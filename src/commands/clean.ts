import type { ParsedArgs } from "../cli.js";
import { getRepoRoot, listWorktrees, removeWorktree } from "../core/git.js";
import { loadState, releaseLocks, saveState } from "../core/state.js";
import { log, logInfo, logSuccess, logWarn } from "../utils/format.js";

export async function run(args: ParsedArgs): Promise<void> {
	const root = getRepoRoot();
	const state = loadState(root);
	const dryRun = args.flags["dry-run"];
	const force = args.flags.force;

	// Find stale tasks: tasks that are in-progress, created, or failed
	// but whose worktree no longer exists, or tasks that have been stuck
	const staleTasks: string[] = [];
	const activeWorktrees = new Set(listWorktrees(root).map((w) => w.path));

	for (const [name, task] of Object.entries(state.tasks)) {
		const isTerminal = task.status === "merged" || task.status === "cancelled";
		if (isTerminal) continue;

		// Check if the worktree still exists
		const worktreeExists =
			!!task.worktree && activeWorktrees.has(task.worktree);

		if (!worktreeExists) {
			staleTasks.push(name);
		} else if (force) {
			// --force cleans ALL non-terminal tasks
			staleTasks.push(name);
		}
	}

	// Also find orphaned locks (locks for tasks that don't exist)
	const orphanedLocks: string[] = [];
	for (const lockOwner of Object.keys(state.locks)) {
		if (!state.tasks[lockOwner]) {
			orphanedLocks.push(lockOwner);
		}
	}

	if (staleTasks.length === 0 && orphanedLocks.length === 0) {
		logSuccess("No stale tasks or orphaned locks found");
		return;
	}

	log(
		`Found ${staleTasks.length} stale task(s) and ${orphanedLocks.length} orphaned lock(s)`,
	);

	for (const name of staleTasks) {
		const task = state.tasks[name];
		const previousStatus = task.status;
		if (dryRun) {
			logInfo(`  Would clean: ${name} (${previousStatus})`);
			continue;
		}

		// Remove worktree if it exists
		removeWorktree(name, root);

		// Release locks
		releaseLocks(state, name);

		// Mark as cancelled
		task.status = "cancelled";
		logWarn(`  Cleaned: ${name} (was ${previousStatus})`);
	}

	for (const lockOwner of orphanedLocks) {
		if (dryRun) {
			logInfo(`  Would release orphaned lock: ${lockOwner}`);
			continue;
		}
		releaseLocks(state, lockOwner);
		logWarn(`  Released orphaned lock: ${lockOwner}`);
	}

	if (!dryRun) {
		saveState(root, state);
		logSuccess(
			`Cleaned ${staleTasks.length} task(s) and ${orphanedLocks.length} orphaned lock(s)`,
		);
	}
}
