import type { TaskArtifact } from "./artifact.js";
import { checkMergeConflicts, getCurrentCommit } from "./git.js";

export interface CompatibilityResult {
	clean: boolean;
	staleBase: boolean;
	needsReplay: boolean;
	conflictingFiles: string[];
	comparedAgainst: {
		baseRef?: string;
		taskName?: string;
	};
	checkedAt: string;
}

function checkedAt(): string {
	return new Date().toISOString();
}

export function compareArtifactAgainstBase(
	artifact: TaskArtifact,
	currentBaseRef: string,
	repoRoot: string,
): CompatibilityResult {
	const currentBaseCommit = getCurrentCommit(repoRoot);
	const artifactRef = artifact.commitSha || artifact.headRef || null;
	const staleBase =
		typeof currentBaseCommit === "string" &&
		artifact.baseRef !== currentBaseRef &&
		artifact.baseRef !== currentBaseCommit;

	const canCheckMerge = !!artifactRef && artifactRef !== currentBaseRef;
	const mergeCheck = canCheckMerge
		? checkMergeConflicts(currentBaseRef, artifactRef as string, repoRoot)
		: { clean: true, conflictFiles: [] };

	return {
		clean: mergeCheck.clean,
		staleBase,
		needsReplay: staleBase || !mergeCheck.clean,
		conflictingFiles: mergeCheck.conflictFiles,
		comparedAgainst: {
			baseRef: currentBaseRef,
		},
		checkedAt: checkedAt(),
	};
}

export function compareArtifactToBase(
	artifact: TaskArtifact,
	currentBaseRef: string,
	repoRoot: string,
): CompatibilityResult {
	return compareArtifactAgainstBase(artifact, currentBaseRef, repoRoot);
}

export function compareArtifacts(
	left: TaskArtifact,
	right: TaskArtifact,
	repoRoot: string,
): CompatibilityResult {
	const leftRef = left.commitSha || left.headRef || null;
	const rightRef = right.commitSha || right.headRef || null;
	const staleBase = left.baseRef !== right.baseRef;

	if (!leftRef || !rightRef) {
		const overlap = left.changedFiles.filter((file) =>
			right.changedFiles.includes(file),
		);
		return {
			clean: overlap.length === 0,
			staleBase,
			needsReplay: overlap.length > 0,
			conflictingFiles: overlap,
			comparedAgainst: {
				taskName: right.taskName,
			},
			checkedAt: checkedAt(),
		};
	}

	const mergeCheck = checkMergeConflicts(leftRef, rightRef, repoRoot);
	return {
		clean: mergeCheck.clean,
		staleBase,
		needsReplay: !mergeCheck.clean,
		conflictingFiles: mergeCheck.conflictFiles,
		comparedAgainst: {
			taskName: right.taskName,
		},
		checkedAt: checkedAt(),
	};
}
