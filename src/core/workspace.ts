import {
	createWorktree,
	getCurrentCommit,
	getDiffPatchAgainstBase,
	getWorktreeDiff,
	listChangedFilesAgainstBase,
	type MergeResult,
	mergeBranchIntoTarget,
	removeWorktree,
} from "./git.js";

export interface WorkspaceHandle {
	id: string;
	kind: "worktree";
	root: string;
	baseRef: string;
	headRef?: string;
	metadata?: Record<string, string>;
}

export interface WorkspaceProvider {
	kind: "worktree";
	create(taskName: string, baseRef: string, repoRoot: string): WorkspaceHandle;
	remove(handle: WorkspaceHandle, repoRoot: string): void;
	currentHead(handle: WorkspaceHandle, repoRoot: string): string | undefined;
	changedFiles(
		handle: WorkspaceHandle,
		baseRef: string,
		repoRoot: string,
	): string[];
	patch(handle: WorkspaceHandle, baseRef: string, repoRoot: string): string;
	diffStat(handle: WorkspaceHandle, baseRef: string, repoRoot: string): string;
	merge(
		handle: WorkspaceHandle,
		targetRef: string,
		repoRoot: string,
		opts?: { parentWorkspace?: WorkspaceHandle },
	): MergeResult;
}

export function createWorktreeProvider(): WorkspaceProvider {
	return {
		kind: "worktree",
		create(
			taskName: string,
			baseRef: string,
			repoRoot: string,
		): WorkspaceHandle {
			const { worktreePath, branchName } = createWorktree(
				taskName,
				baseRef,
				repoRoot,
			);
			const headRef = getCurrentCommit(worktreePath);
			return {
				id: taskName,
				kind: "worktree",
				root: worktreePath,
				baseRef,
				headRef,
				metadata: {
					branchName,
					taskName,
				},
			};
		},
		remove(handle: WorkspaceHandle, repoRoot: string): void {
			removeWorktree(handle.id, repoRoot);
		},
		currentHead(handle: WorkspaceHandle): string | undefined {
			return getCurrentCommit(handle.root) || undefined;
		},
		changedFiles(handle: WorkspaceHandle, baseRef: string): string[] {
			return listChangedFilesAgainstBase(baseRef, handle.root);
		},
		patch(handle: WorkspaceHandle, baseRef: string): string {
			const changed = listChangedFilesAgainstBase(baseRef, handle.root);
			return changed
				.map((file) => getDiffPatchAgainstBase(baseRef, file, handle.root))
				.filter(Boolean)
				.join("\n");
		},
		diffStat(
			handle: WorkspaceHandle,
			baseRef: string,
			repoRoot: string,
		): string {
			return getWorktreeDiff(handle.id, baseRef, repoRoot);
		},
		merge(
			handle: WorkspaceHandle,
			targetRef: string,
			repoRoot: string,
			opts?: { parentWorkspace?: WorkspaceHandle },
		): MergeResult {
			const branchName = handle.metadata?.branchName || `ruah/${handle.id}`;
			return mergeBranchIntoTarget(branchName, targetRef, repoRoot, {
				parentWorktree: opts?.parentWorkspace?.root,
			});
		},
	};
}

let provider: WorkspaceProvider = createWorktreeProvider();

export function getWorkspaceProvider(): WorkspaceProvider {
	return provider;
}

export function setWorkspaceProvider(next: WorkspaceProvider): void {
	provider = next;
}
