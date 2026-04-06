import { branchExists, isBranchMerged, removeWorktree } from "./git.js";
import type { RuahState } from "./state.js";
import { addHistoryEntry, releaseLocks, saveState } from "./state.js";

export interface ReconcileResult {
	merged: string[];
}

export function reconcileStateWithGit(
	root: string,
	state: RuahState,
): ReconcileResult {
	const merged: string[] = [];

	for (const [name, task] of Object.entries(state.tasks)) {
		const isTerminal = task.status === "merged" || task.status === "cancelled";
		if (isTerminal) continue;

		if (
			!branchExists(task.branch, root) ||
			!branchExists(task.baseBranch, root)
		) {
			continue;
		}

		if (!isBranchMerged(task.branch, task.baseBranch, root)) {
			continue;
		}

		const timestamp = new Date().toISOString();
		task.status = "merged";
		task.completedAt ??= timestamp;
		task.mergedAt ??= timestamp;
		releaseLocks(state, name);
		addHistoryEntry(state, "task.reconciled.merged", {
			task: name,
			target: task.baseBranch,
		});
		removeWorktree(name, root);
		merged.push(name);
	}

	if (merged.length > 0) {
		saveState(root, state);
	}

	return { merged };
}
