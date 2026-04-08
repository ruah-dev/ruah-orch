import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ParsedArgs } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { getAvailableExecutors } from "../core/executor.js";
import {
	getCurrentBranch,
	getRepoRoot,
	isGitRepo,
	listWorktrees,
} from "../core/git.js";
import { loadState, stateLockPath, statePath } from "../core/state.js";
import {
	heading,
	log,
	logError,
	logInfo,
	logSuccess,
	logWarn,
} from "../utils/format.js";

interface CheckResult {
	name: string;
	ok: boolean;
	details: string;
	hint?: string;
}

const EXECUTOR_COMMANDS: Record<string, string[]> = {
	"claude-code": ["claude"],
	aider: ["aider"],
	codex: ["codex"],
	"codex-mcp": [process.env.CODEX_MCP_URL ? "node" : "codex"],
	"open-code": ["opencode"],
	script: [],
};

function hasCommand(command: string): boolean {
	const probe = process.platform === "win32" ? "where" : "which";
	return spawnSync(probe, [command], { stdio: "pipe" }).status === 0;
}

function summarizeExecutors(root: string): CheckResult[] {
	const config = loadConfig(root);
	const state = loadState(root);
	const requested = new Set<string>(getAvailableExecutors());
	if (config.executor) requested.add(config.executor);
	for (const task of Object.values(state.tasks)) {
		if (task.executor) requested.add(task.executor);
	}

	return [...requested].sort().map((executor) => {
		const commands = EXECUTOR_COMMANDS[executor];
		if (executor === "script") {
			return {
				name: `executor:${executor}`,
				ok: true,
				details: "explicit shell-script executor",
			};
		}
		if (!commands) {
			return {
				name: `executor:${executor}`,
				ok: false,
				details: "not a known ruah executor adapter",
				hint: "Use a supported executor or switch to script for explicit shell commands.",
			};
		}

		const missing = commands.filter((command) => !hasCommand(command));
		return {
			name: `executor:${executor}`,
			ok: missing.length === 0,
			details:
				missing.length === 0
					? `ready (${commands.join(", ")})`
					: `missing command(s): ${missing.join(", ")}`,
			hint:
				missing.length > 0
					? `Install ${missing.join(", ")} or change the configured executor.`
					: undefined,
		};
	});
}

export async function run(args: ParsedArgs): Promise<void> {
	const json = args.flags.json;
	if (!isGitRepo()) {
		logError("Not a git repository");
		process.exit(1);
	}

	const root = getRepoRoot();
	const stateFile = statePath(root);
	const lockFile = stateLockPath(root);
	const currentBranch = getCurrentBranch(root);
	const state = existsSync(stateFile) ? loadState(root) : null;
	const worktrees = listWorktrees(root);
	const activeWorktrees = new Set(worktrees.map((worktree) => worktree.path));
	const stateLockAgeMs = existsSync(lockFile)
		? Date.now() - statSync(lockFile).mtimeMs
		: null;

	const checks: CheckResult[] = [
		{
			name: "git",
			ok: true,
			details: `repo root ${root}, branch ${currentBranch}`,
		},
		{
			name: "ruah-state",
			ok: existsSync(stateFile),
			details: existsSync(stateFile)
				? ".ruah/state.json present"
				: "missing .ruah/state.json",
			hint: existsSync(stateFile) ? undefined : "Run `ruah init` first.",
		},
	];

	if (state) {
		if (!state.artifacts) {
			state.artifacts = {};
		}
		const artifacts = state.artifacts;
		const staleTasks = Object.values(state.tasks).filter((task) => {
			const isTerminal =
				task.status === "merged" || task.status === "cancelled";
			return (
				!isTerminal && !!task.worktree && !activeWorktrees.has(task.worktree)
			);
		});
		const orphanedLocks = Object.keys(state.locks).filter(
			(taskName) => !state.tasks[taskName],
		);
		const snapshotGaps = Object.keys(state.locks).filter(
			(taskName) => !state.lockSnapshots[taskName],
		);
		const artifactGaps = Object.values(state.tasks).filter(
			(task) =>
				task.status === "done" && !task.artifact && !artifacts[task.name],
		);
		const workspaceMetadataGaps = Object.values(state.tasks).filter(
			(task) => !task.workspace && task.worktree,
		);

		checks.push(
			{
				name: "state-health",
				ok: staleTasks.length === 0 && orphanedLocks.length === 0,
				details: `${staleTasks.length} stale task(s), ${orphanedLocks.length} orphaned lock(s)`,
				hint:
					staleTasks.length > 0 || orphanedLocks.length > 0
						? "Run `ruah clean --dry-run` to inspect recovery candidates."
						: undefined,
			},
			{
				name: "lock-snapshots",
				ok: snapshotGaps.length === 0,
				details:
					snapshotGaps.length === 0
						? "all active locks have resolved snapshots"
						: `${snapshotGaps.length} lock(s) missing resolved snapshots`,
				hint:
					snapshotGaps.length > 0
						? "Recreate those tasks to capture resolved lock snapshots."
						: undefined,
			},
			{
				name: "artifacts",
				ok: artifactGaps.length === 0,
				details:
					artifactGaps.length === 0
						? "all completed tasks have artifacts"
						: `${artifactGaps.length} completed task(s) missing artifacts`,
				hint:
					artifactGaps.length > 0
						? "Re-run or re-mark those tasks to capture engine artifacts."
						: undefined,
			},
			{
				name: "workspace-metadata",
				ok: workspaceMetadataGaps.length === 0,
				details:
					workspaceMetadataGaps.length === 0
						? "all tasks have canonical workspace metadata"
						: `${workspaceMetadataGaps.length} task(s) still rely on legacy worktree fields`,
				hint:
					workspaceMetadataGaps.length > 0
						? "Run any ruah command that rewrites state to migrate legacy task metadata."
						: undefined,
			},
		);
	}

	checks.push({
		name: "state-lock",
		ok: !existsSync(lockFile) || (stateLockAgeMs || 0) < 30_000,
		details: existsSync(lockFile)
			? `state lock present (${Math.round((stateLockAgeMs || 0) / 1000)}s old)`
			: "no active state lock",
		hint:
			existsSync(lockFile) && (stateLockAgeMs || 0) >= 30_000
				? "A previous command may have been interrupted; the next write will recover the stale lock."
				: undefined,
	});

	checks.push(...summarizeExecutors(root));

	if (json) {
		console.log(
			JSON.stringify(
				{
					root,
					currentBranch,
					checks,
				},
				null,
				2,
			),
		);
		return;
	}

	log(heading("Doctor"));
	for (const check of checks) {
		if (check.ok) {
			logSuccess(`${check.name}: ${check.details}`);
		} else {
			logWarn(`${check.name}: ${check.details}`);
			if (check.hint) {
				logInfo(`  ${check.hint}`);
			}
		}
	}
}
