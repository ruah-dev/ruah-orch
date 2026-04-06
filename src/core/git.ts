import { execSync } from "node:child_process";
import { join } from "node:path";

interface GitOptions {
	cwd?: string;
	silent?: boolean;
	ignoreError?: boolean;
}

export interface WorktreeInfo {
	worktreePath: string;
	branchName: string;
}

export interface MergeResult {
	success: boolean;
	conflicts: string[];
}

export interface MergeOptions {
	parentWorktree?: string;
}

export interface WorktreeEntry {
	path: string;
	branch?: string;
}

function git(cmd: string, opts: GitOptions = {}): string {
	const { cwd, silent, ignoreError } = opts;
	try {
		const result = execSync(`git ${cmd}`, {
			encoding: "utf-8",
			cwd: cwd || process.cwd(),
			stdio: silent ? "pipe" : ["pipe", "pipe", "pipe"],
		});
		return result.trim();
	} catch (err: unknown) {
		if (ignoreError) return "";
		const stderr =
			(err as { stderr?: string })?.stderr?.trim() ||
			(err instanceof Error ? err.message : String(err));
		throw new Error(`git ${cmd.split(" ")[0]} failed: ${stderr}`);
	}
}

export function isGitRepo(cwd?: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			encoding: "utf-8",
			cwd: cwd || process.cwd(),
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

export function getCurrentBranch(cwd?: string): string {
	return git("rev-parse --abbrev-ref HEAD", { cwd, silent: true });
}

export function getRepoRoot(cwd?: string): string {
	return git("rev-parse --show-toplevel", { cwd, silent: true });
}

export function branchExists(name: string, cwd?: string): boolean {
	try {
		git(`rev-parse --verify ${name}`, { cwd, silent: true });
		return true;
	} catch {
		return false;
	}
}

export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function createWorktree(
	taskName: string,
	baseBranch: string,
	repoRoot: string,
): WorktreeInfo {
	const safe = sanitizeName(taskName);
	const branchName = `ruah/${safe}`;
	const worktreePath = join(repoRoot, ".ruah", "worktrees", safe);

	if (branchExists(branchName, repoRoot)) {
		throw new Error(`Branch ${branchName} already exists`);
	}

	git(`worktree add -b ${branchName} "${worktreePath}" ${baseBranch}`, {
		cwd: repoRoot,
		silent: true,
	});

	return { worktreePath, branchName };
}

export function removeWorktree(taskName: string, repoRoot: string): void {
	const safe = sanitizeName(taskName);
	const branchName = `ruah/${safe}`;
	const worktreePath = join(repoRoot, ".ruah", "worktrees", safe);

	git(`worktree remove "${worktreePath}" --force`, {
		cwd: repoRoot,
		silent: true,
		ignoreError: true,
	});
	git(`branch -D ${branchName}`, {
		cwd: repoRoot,
		silent: true,
		ignoreError: true,
	});
}

export function mergeWorktree(
	taskName: string,
	baseBranch: string,
	repoRoot: string,
	opts: MergeOptions = {},
): MergeResult {
	const safe = sanitizeName(taskName);
	const branchName = `ruah/${safe}`;

	// For subtask merges, the target branch is already checked out in the
	// parent's worktree. Merge from there instead of the repo root.
	const mergeCwd = opts.parentWorktree || repoRoot;

	if (!opts.parentWorktree) {
		// Standard merge: checkout target branch in repo root
		git(`checkout ${baseBranch}`, { cwd: repoRoot, silent: true });
	}
	// else: parentWorktree already has the target branch checked out

	try {
		git(`merge ${branchName} --no-ff -m "ruah: merge ${taskName}"`, {
			cwd: mergeCwd,
			silent: true,
		});
		return { success: true, conflicts: [] };
	} catch {
		// Check for merge conflicts
		const status = git("status --porcelain", {
			cwd: mergeCwd,
			silent: true,
		});
		const conflicts = status
			.split("\n")
			.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line))
			.map((line) => line.slice(3).trim());

		// Abort the failed merge
		git("merge --abort", {
			cwd: mergeCwd,
			silent: true,
			ignoreError: true,
		});

		return { success: false, conflicts };
	}
}

export function getWorktreeDiff(
	taskName: string,
	baseBranch: string,
	repoRoot: string,
): string {
	const safe = sanitizeName(taskName);
	const branchName = `ruah/${safe}`;
	return git(`diff ${baseBranch}...${branchName} --stat`, {
		cwd: repoRoot,
		silent: true,
	});
}

export function listWorktrees(repoRoot: string): WorktreeEntry[] {
	const raw = git("worktree list --porcelain", {
		cwd: repoRoot,
		silent: true,
	});
	if (!raw) return [];

	const worktrees: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> = {};
	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) worktrees.push(current as WorktreeEntry);
			current = { path: line.slice(9) };
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7);
		} else if (line === "") {
			if (current.path) worktrees.push(current as WorktreeEntry);
			current = {};
		}
	}
	if (current.path) worktrees.push(current as WorktreeEntry);

	return worktrees.filter((w) => w.branch?.includes("ruah/"));
}

export function hasUncommittedChanges(cwd?: string): boolean {
	const status = git("status --porcelain", { cwd, silent: true });
	return status.length > 0;
}

export interface ConflictCheck {
	/** Whether the merge would be clean */
	clean: boolean;
	/** List of files with conflicts (empty if clean) */
	conflictFiles: string[];
}

/**
 * Check if merging branchB into branchA would cause conflicts.
 * Uses git merge-tree (read-only — does not modify the repo).
 */
export function checkMergeConflicts(
	branchA: string,
	branchB: string,
	repoRoot: string,
): ConflictCheck {
	// Find the merge base
	const base = git(`merge-base ${branchA} ${branchB}`, {
		cwd: repoRoot,
		silent: true,
		ignoreError: true,
	});

	if (!base) {
		// No common ancestor — can't check
		return { clean: true, conflictFiles: [] };
	}

	try {
		// git merge-tree exits 0 if clean, non-zero if conflicts
		// The --write-tree form (git 2.38+) is best, but fallback to classic
		const result = git(`merge-tree ${base} ${branchA} ${branchB}`, {
			cwd: repoRoot,
			silent: true,
		});

		// Classic merge-tree outputs conflict markers — if output contains
		// "changed in both" or conflict markers, there are conflicts
		const conflictFiles: string[] = [];
		for (const line of result.split("\n")) {
			// Classic merge-tree format: each conflict section starts with
			// a line like "changed in both" followed by file info
			const match = line.match(/^\+\+\+\s+(.+)$/);
			if (match) {
				conflictFiles.push(match[1]);
			}
		}

		// If merge-tree produced output with conflict markers, it's not clean
		const hasConflicts =
			result.includes("changed in both") || result.includes("+<<<<<<< ");

		return {
			clean: !hasConflicts,
			conflictFiles,
		};
	} catch {
		// merge-tree failed — try the write-tree variant (git 2.38+)
		try {
			git(`merge-tree --write-tree ${branchA} ${branchB}`, {
				cwd: repoRoot,
				silent: true,
			});
			// If it succeeds, merge is clean
			return { clean: true, conflictFiles: [] };
		} catch (err: unknown) {
			// Parse error output for conflict files
			const stderr = (err as { stderr?: string })?.stderr || "";
			const files: string[] = [];
			for (const line of stderr.split("\n")) {
				const m = line.match(/^CONFLICT\s+\([^)]+\):\s+(.+)/);
				if (m) files.push(m[1].trim());
			}
			return {
				clean: false,
				conflictFiles: files,
			};
		}
	}
}
