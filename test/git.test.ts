import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	branchExists,
	checkMergeConflicts,
	createWorktree,
	getCurrentBranch,
	getRepoRoot,
	isGitRepo,
	listWorktrees,
	removeWorktree,
	sanitizeName,
} from "../src/core/git.js";

function tmpGitRepo(): string {
	const dir = join(tmpdir(), `ruah-git-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "hello", "utf-8");
	execSync('git add . && git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

describe("git", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpGitRepo();
	});

	afterEach(() => {
		// Clean up worktrees before removing the repo
		try {
			execSync("git worktree prune", { cwd: repo, stdio: "pipe" });
		} catch {
			/* ignore */
		}
		rmSync(repo, { recursive: true, force: true });
	});

	it("isGitRepo returns true for a git repo", () => {
		assert.ok(isGitRepo(repo));
	});

	it("isGitRepo returns false for non-repo", () => {
		const dir = join(tmpdir(), `ruah-nogit-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		assert.ok(!isGitRepo(dir));
		rmSync(dir, { recursive: true, force: true });
	});

	it("getCurrentBranch returns main or master", () => {
		const branch = getCurrentBranch(repo);
		assert.ok(branch === "main" || branch === "master");
	});

	it("getRepoRoot returns correct path", () => {
		const root = getRepoRoot(repo);
		assert.ok(root.includes("ruah-git"));
	});

	it("branchExists returns false for nonexistent branch", () => {
		assert.ok(!branchExists("nonexistent", repo));
	});

	it("sanitizeName replaces special chars", () => {
		assert.equal(sanitizeName("my task!@#"), "my_task___");
		assert.equal(sanitizeName("normal-name"), "normal-name");
		assert.equal(sanitizeName("with.dots"), "with.dots");
	});

	it("createWorktree creates worktree and branch", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		const result = createWorktree("test-task", branch, repo);
		assert.ok(result.worktreePath.includes("test-task"));
		assert.equal(result.branchName, "ruah/test-task");
		assert.ok(branchExists("ruah/test-task", repo));
	});

	it("removeWorktree cleans up", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		createWorktree("cleanup", branch, repo);
		removeWorktree("cleanup", repo);
		assert.ok(!branchExists("ruah/cleanup", repo));
	});

	it("listWorktrees returns ruah worktrees", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		createWorktree("wt-test", branch, repo);
		const wts = listWorktrees(repo);
		assert.ok(wts.length >= 1);
		assert.ok(wts.some((w) => w.branch?.includes("ruah/wt-test")));
	});

	describe("checkMergeConflicts", () => {
		it("returns clean for non-conflicting branches", () => {
			const mainBranch = getCurrentBranch(repo);

			// Create branch-a that edits file-a.txt
			execSync("git checkout -b branch-a", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "file-a.txt"), "content from branch A", "utf-8");
			execSync('git add . && git commit -m "add file-a"', {
				cwd: repo,
				stdio: "pipe",
			});

			// Create branch-b from main that edits file-b.txt
			execSync(`git checkout ${mainBranch}`, { cwd: repo, stdio: "pipe" });
			execSync("git checkout -b branch-b", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "file-b.txt"), "content from branch B", "utf-8");
			execSync('git add . && git commit -m "add file-b"', {
				cwd: repo,
				stdio: "pipe",
			});

			const result = checkMergeConflicts("branch-a", "branch-b", repo);
			assert.equal(result.clean, true);
			assert.deepEqual(result.conflictFiles, []);

			// Restore main branch
			execSync(`git checkout ${mainBranch}`, { cwd: repo, stdio: "pipe" });
		});

		it("detects conflicts when branches edit same file", () => {
			const mainBranch = getCurrentBranch(repo);

			// Create branch-a that edits README.md
			execSync("git checkout -b conflict-a", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "version A content", "utf-8");
			execSync('git add . && git commit -m "edit readme on A"', {
				cwd: repo,
				stdio: "pipe",
			});

			// Create branch-b from main that also edits README.md differently
			execSync(`git checkout ${mainBranch}`, { cwd: repo, stdio: "pipe" });
			execSync("git checkout -b conflict-b", { cwd: repo, stdio: "pipe" });
			writeFileSync(join(repo, "README.md"), "version B content", "utf-8");
			execSync('git add . && git commit -m "edit readme on B"', {
				cwd: repo,
				stdio: "pipe",
			});

			const result = checkMergeConflicts("conflict-a", "conflict-b", repo);
			assert.equal(result.clean, false);

			// Restore main branch
			execSync(`git checkout ${mainBranch}`, { cwd: repo, stdio: "pipe" });
		});

		it("handles missing merge base gracefully", () => {
			// Create an orphan branch with no common ancestor
			execSync("git checkout --orphan orphan-branch", {
				cwd: repo,
				stdio: "pipe",
			});
			writeFileSync(join(repo, "orphan.txt"), "orphan content", "utf-8");
			execSync('git add . && git commit -m "orphan init"', {
				cwd: repo,
				stdio: "pipe",
			});

			const mainBranch = "main";
			const result = checkMergeConflicts(mainBranch, "orphan-branch", repo);
			// No common ancestor — should return clean: true
			assert.equal(result.clean, true);
			assert.deepEqual(result.conflictFiles, []);

			execSync(`git checkout ${mainBranch}`, { cwd: repo, stdio: "pipe" });
		});
	});
});
