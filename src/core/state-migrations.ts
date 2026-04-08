import { join } from "node:path";
import type { TaskArtifact } from "./artifact.js";
import type { ClaimSet } from "./claims.js";
import { claimSetFromFiles, claimSetToFiles } from "./claims.js";
import { sanitizeName } from "./git.js";
import type { WorkspaceHandle } from "./workspace.js";

interface LegacyTaskLike {
	name?: string;
	baseBranch?: string;
	branch?: string;
	worktree?: string;
	files?: string[];
	lockMode?: "read" | "write";
	workspace?: WorkspaceHandle | null;
	claims?: ClaimSet | null;
	artifact?: TaskArtifact | null;
	integration?: {
		status: "unknown" | "clean" | "conflict" | "stale";
		conflictsWith: string[];
		lastCheckedAt?: string;
	} | null;
}

interface LegacyStateLike {
	version?: number;
	tasks?: Record<string, LegacyTaskLike>;
	artifacts?: Record<string, TaskArtifact>;
	baseBranch?: string;
}

function deriveWorkspacePath(repoRoot: string, taskName: string): string {
	return join(repoRoot, ".ruah", "worktrees", sanitizeName(taskName));
}

export function migrateTaskLike<T extends LegacyTaskLike>(
	task: T,
	repoRoot: string,
): T {
	const migrated = task;
	if (!migrated.claims) {
		migrated.claims = claimSetFromFiles(
			migrated.files || [],
			migrated.lockMode || "write",
		);
	}

	if (!migrated.workspace && migrated.worktree) {
		migrated.workspace = {
			id: migrated.name || migrated.branch || migrated.worktree,
			kind: "worktree",
			root: migrated.worktree,
			baseRef: migrated.baseBranch || "main",
			headRef: migrated.branch,
			metadata: migrated.branch ? { branchName: migrated.branch } : undefined,
		};
	}

	if (!migrated.workspace) {
		const taskName = migrated.name || migrated.branch || "task";
		const branchName = migrated.branch || `ruah/${sanitizeName(taskName)}`;
		const worktree =
			migrated.worktree || deriveWorkspacePath(repoRoot, taskName);
		migrated.workspace = {
			id: taskName,
			kind: "worktree",
			root: worktree,
			baseRef: migrated.baseBranch || "main",
			headRef: branchName,
			metadata: {
				taskName,
				branchName,
			},
		};
	}

	if (migrated.workspace) {
		migrated.worktree = migrated.workspace.root;
		migrated.branch =
			migrated.workspace.metadata?.branchName ||
			migrated.branch ||
			migrated.workspace.headRef;
	}

	if (!migrated.files) {
		migrated.files = claimSetToFiles(migrated.claims);
	}

	if (!migrated.integration) {
		migrated.integration = {
			status: "unknown",
			conflictsWith: [],
		};
	}

	return migrated;
}

export function migrateStateShape<T extends LegacyStateLike>(
	state: T,
	repoRoot: string,
): T {
	state.version = Math.max(state.version || 1, 2);
	state.artifacts = state.artifacts || {};
	state.baseBranch = state.baseBranch || "main";

	for (const [name, task] of Object.entries(state.tasks || {})) {
		task.name = task.name || name;
		migrateTaskLike(task, repoRoot);
	}

	return state;
}
