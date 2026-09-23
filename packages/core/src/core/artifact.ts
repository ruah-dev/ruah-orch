import type { Artifact } from "@ruah-dev/schema";
import type { ClaimSet } from "./claims.js";
import { getCommitSha, getCurrentCommit } from "./git.js";
import type { WorkspaceHandle, WorkspaceProvider } from "./workspace.js";

/** @deprecated Prefer `Artifact` from `@ruah-dev/schema`; alias kept for orch API stability. */
export type TaskArtifact = Artifact;

export interface ArtifactValidationInput {
	executorSuccess: boolean;
	contractSuccess: boolean;
	gatesSuccess?: boolean;
}

export interface ArtifactBuildOptions {
	taskName: string;
	workspace: WorkspaceHandle;
	baseRef: string;
	repoRoot: string;
	claims?: ClaimSet | null;
	validation: ArtifactValidationInput;
}

export function buildTaskArtifact(
	provider: WorkspaceProvider,
	options: ArtifactBuildOptions,
): TaskArtifact {
	const { taskName, workspace, baseRef, repoRoot, claims, validation } =
		options;
	const resolvedBaseRef = getCommitSha(baseRef, repoRoot) || baseRef;
	const changedFiles = provider.changedFiles(workspace, baseRef, repoRoot);
	const patch = provider.patch(workspace, baseRef, repoRoot);
	const headRef = provider.currentHead(workspace, repoRoot);
	const commitSha = getCurrentCommit(workspace.root) || headRef;

	return {
		schemaVersion: 1,
		taskName,
		workspaceId: workspace.id,
		baseRef: resolvedBaseRef,
		headRef,
		commitSha,
		changedFiles,
		patch,
		createdAt: new Date().toISOString(),
		claims: claims || null,
		validation,
	};
}

export function captureTaskArtifact(
	provider: WorkspaceProvider,
	options: ArtifactBuildOptions,
): TaskArtifact {
	return buildTaskArtifact(provider, options);
}

export function artifactPresent(artifact?: TaskArtifact | null): boolean {
	return (
		!!artifact &&
		((artifact.changedFiles?.length ?? 0) > 0 ||
			(artifact.patch?.length ?? 0) > 0)
	);
}
