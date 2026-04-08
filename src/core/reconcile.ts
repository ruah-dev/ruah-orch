import { branchExists, isBranchMerged, removeWorktree } from "./git.js";
import type { RuahState } from "./state.js";
import { addHistoryEntry, removeTask, saveState } from "./state.js";

export interface ReconcileResult {
	merged: string[];
	cleanedCancelled: string[];
}

export function reconcileStateWithGit(
	root: string,
	state: RuahState,
): ReconcileResult {
	const merged: string[] = [];
	const cleanedCancelled: string[] = [];

	for (const [name, task] of Object.entries(state.tasks)) {
		if (task.status === "merged") {
			const timestamp = new Date().toISOString();
			addHistoryEntry(state, "task.cleaned.merged", {
				task: name,
				target: task.baseBranch,
				mergedAt: task.mergedAt || timestamp,
			});
			removeWorktree(name, root);
			removeTask(state, name);
			merged.push(name);
			continue;
		}

		if (task.status === "cancelled") {
			addHistoryEntry(state, "task.cleaned.cancelled", {
				task: name,
			});
			removeWorktree(name, root);
			removeTask(state, name);
			cleanedCancelled.push(name);
			continue;
		}

		// Only auto-reconcile "done" tasks. Tasks in created/in-progress/failed
		// haven't completed their lifecycle — auto-removing them causes the
		// "disappearing tasks" bug (freshly created branches are trivially
		// ancestors of their base, so isBranchMerged returns a false positive).
		if (task.status !== "done") {
			continue;
		}

		if (
			!task.branch ||
			!branchExists(task.branch, root) ||
			!branchExists(task.baseBranch, root)
		) {
			continue;
		}

		if (!isBranchMerged(task.branch, task.baseBranch, root)) {
			continue;
		}

		const timestamp = new Date().toISOString();
		addHistoryEntry(state, "task.reconciled.merged", {
			task: name,
			target: task.baseBranch,
			mergedAt: timestamp,
		});
		removeWorktree(name, root);
		removeTask(state, name);
		merged.push(name);
	}

	if (merged.length > 0 || cleanedCancelled.length > 0) {
		saveState(root, state);
	}

	return { merged, cleanedCancelled };
}
