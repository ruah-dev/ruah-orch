import { statSync } from "node:fs";
import { join } from "node:path";
import {
	type ClaimSet,
	claimPatterns,
	claimSetFromPaths,
	claimSetsOverlap,
	claimSetToBuckets,
	normalizeClaimSet,
} from "./claims.js";
import { type HistoryEntry, loadState } from "./state.js";
import type { WorkflowTask } from "./workflow.js";

// --- Types ---

export type FileAccessMode = "owned" | "shared-append" | "read-only";

export interface CompatibilitySignal {
	clean: boolean;
	staleBase?: boolean;
	needsReplay?: boolean;
	conflictingFiles?: string[];
}

export interface FileContract {
	taskName: string;
	/** Canonical claims representation */
	claims?: ClaimSet | null;
	/** Files this agent exclusively owns — modify freely */
	owned: string[];
	/** Files shared with other agents — only append new code, don't modify existing lines */
	sharedAppend: string[];
	/** Files visible but must not be modified */
	readOnly: string[];
}

export interface PlanningTask extends WorkflowTask {
	claims?: ClaimSet | null;
	compatibility?: CompatibilitySignal | null;
}

export interface SmartPlanOptions {
	compatibilityByPair?:
		| Map<string, CompatibilitySignal>
		| Record<string, CompatibilitySignal>;
	compatibilityByTask?:
		| Map<string, CompatibilitySignal>
		| Record<string, CompatibilitySignal>;
	claimsByTask?: Map<string, ClaimSet> | Record<string, ClaimSet>;
}

export interface TaskPairOverlap {
	taskA: string;
	taskB: string;
	/** Patterns from taskA that overlap with taskB's patterns */
	overlappingPatterns: string[];
	/** 0.0 = no overlap, 1.0 = complete overlap */
	overlapRatio: number;
	/** Size-weighted risk score */
	riskScore: number;
	/** Extra risk pulled from prior ruah failures/conflicts */
	historyPenalty: number;
	/** Optional compatibility signal for this pair */
	compatibility?: CompatibilitySignal | null;
}

export type StageStrategy = "parallel" | "parallel-with-contracts" | "serial";

export interface StageDecision {
	strategy: StageStrategy;
	/** Original tasks in this stage */
	tasks: WorkflowTask[];
	/** If serial, the ordered sub-stages (each is a single task) */
	serialOrder?: WorkflowTask[][];
	/** If parallel-with-contracts, the contracts per task */
	contracts?: Map<string, FileContract>;
	/** Explanation for logging */
	reason: string;
}

export interface SmartPlan {
	/** Original stages from getExecutionPlan */
	originalStages: WorkflowTask[][];
	/** Refined stages after planner analysis */
	refinedStages: StageDecision[];
	/** All detected overlaps for diagnostics */
	overlaps: TaskPairOverlap[];
	/** Summary statistics */
	summary: {
		totalTasks: number;
		parallelStages: number;
		serialStages: number;
		contractStages: number;
		overlapCount: number;
	};
}

// --- Thresholds ---

/** Maximum overlap ratio to allow parallel-with-contracts (above this → serial) */
const OVERLAP_RATIO_THRESHOLD = 0.3;
/** Maximum risk score to allow parallel-with-contracts (above this → serial) */
const RISK_SCORE_THRESHOLD = 2.0;

function getMapValue<T>(
	source: Map<string, T> | Record<string, T> | undefined,
	key: string,
): T | undefined {
	if (!source) return undefined;
	if (source instanceof Map) {
		return source.get(key);
	}
	return source[key];
}

function compatibilityKey(a: string, b: string): string {
	return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function getTaskClaims(
	task: PlanningTask,
	options: SmartPlanOptions = {},
): ClaimSet {
	const directClaims =
		task.claims ?? getMapValue(options.claimsByTask, task.name);
	if (directClaims) {
		return normalizeClaimSet(directClaims);
	}
	return claimSetFromPaths(task.files);
}

function hasExplicitClaims(
	task: PlanningTask,
	options: SmartPlanOptions = {},
): boolean {
	return Boolean(task.claims || getMapValue(options.claimsByTask, task.name));
}

function getPairCompatibility(
	a: string,
	b: string,
	options: SmartPlanOptions = {},
): CompatibilitySignal | undefined {
	return getMapValue(options.compatibilityByPair, compatibilityKey(a, b));
}

function getTaskCompatibility(
	task: PlanningTask,
	options: SmartPlanOptions = {},
): CompatibilitySignal | undefined {
	return (
		task.compatibility ?? getMapValue(options.compatibilityByTask, task.name)
	);
}

function buildClaimContract(
	task: PlanningTask,
	options: SmartPlanOptions = {},
): FileContract {
	const claims = getTaskClaims(task, options);
	return {
		taskName: task.name,
		claims,
		owned: [...claims.ownedPaths],
		sharedAppend: [...claims.sharedPaths],
		readOnly: [...claims.readOnlyPaths],
	};
}

function isCompatibilityConflict(signal?: CompatibilitySignal | null): boolean {
	if (!signal) return false;
	return Boolean(
		!signal.clean || signal.staleBase === true || signal.needsReplay === true,
	);
}

// --- File Size Heuristic ---

/**
 * Estimate risk weight for a single file pattern.
 * Larger existing files = higher conflict probability.
 */
export function estimatePatternRisk(pattern: string, repoRoot: string): number {
	// Globs can't be statted — medium risk
	if (pattern.includes("*")) return 1.0;

	try {
		const stat = statSync(join(repoRoot, pattern));
		if (stat.isDirectory()) return 1.0;
		const size = stat.size;
		if (size < 100) return 0.3;
		if (size < 1000) return 0.7;
		return 1.5;
	} catch {
		// File doesn't exist yet — moderate risk
		return 0.5;
	}
}

// --- Overlap Analysis ---

/**
 * For a single stage of tasks, compute all pairwise overlaps.
 * Returns one TaskPairOverlap for every pair that has any overlap.
 */
export function analyzeStageOverlaps(
	tasks: PlanningTask[],
	repoRoot: string,
	options: SmartPlanOptions = {},
): TaskPairOverlap[] {
	const overlaps: TaskPairOverlap[] = [];
	const history = loadState(repoRoot).history;

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const a = tasks[i];
			const b = tasks[j];
			const claimsA = getTaskClaims(a, options);
			const claimsB = getTaskClaims(b, options);
			const overlapping = claimSetsOverlap(claimsA, claimsB, repoRoot);
			const compatibility = getPairCompatibility(a.name, b.name, options);
			const taskCompatibilityA = getTaskCompatibility(a, options);
			const taskCompatibilityB = getTaskCompatibility(b, options);
			const hasCompatConflict =
				isCompatibilityConflict(compatibility) ||
				isCompatibilityConflict(taskCompatibilityA) ||
				isCompatibilityConflict(taskCompatibilityB);

			if (overlapping.length === 0 && !hasCompatConflict) {
				continue;
			}

			const unionSize = new Set([
				...claimPatterns(claimsA),
				...claimPatterns(claimsB),
			]).size;
			const overlapRatio =
				unionSize > 0 ? Math.min(overlapping.length / unionSize, 1.0) : 0;
			const baseRisk = overlapping.reduce<number>(
				(sum: number, pattern: string) =>
					sum + estimatePatternRisk(pattern, repoRoot),
				0,
			);
			const historyPenalty = calculateHistoryPenalty(a.name, b.name, history);
			const compatibilityPenalty = hasCompatConflict ? 3 : 0;
			const riskScore = baseRisk + historyPenalty + compatibilityPenalty;

			overlaps.push({
				taskA: a.name,
				taskB: b.name,
				overlappingPatterns: overlapping,
				overlapRatio,
				riskScore,
				historyPenalty,
				compatibility: compatibility || null,
			});
		}
	}

	return overlaps;
}

// --- Contract Generation ---

/**
 * Given tasks with manageable overlap, assign file access modes to each task.
 */
export function buildContracts(
	tasks: PlanningTask[],
	_overlaps: TaskPairOverlap[],
	options: SmartPlanOptions = {},
): Map<string, FileContract> {
	const explicitClaims = tasks.some((task) => hasExplicitClaims(task, options));

	if (explicitClaims) {
		const contracts = new Map<string, FileContract>();
		for (const task of tasks) {
			contracts.set(task.name, buildClaimContract(task, options));
		}
		return contracts;
	}

	// Count how many tasks reference each pattern
	const patternRefCount = new Map<string, string[]>();
	for (const task of tasks) {
		for (const pattern of task.files) {
			const refs = patternRefCount.get(pattern) || [];
			refs.push(task.name);
			patternRefCount.set(pattern, refs);
		}
	}

	// Determine the "primary" task — the one with the most files
	const taskFileCount = new Map<string, number>();
	for (const task of tasks) {
		taskFileCount.set(task.name, task.files.length);
	}

	const contracts = new Map<string, FileContract>();

	// Initialize contracts
	for (const task of tasks) {
		contracts.set(task.name, {
			taskName: task.name,
			claims: normalizeClaimSet({
				ownedPaths: [],
				sharedPaths: [],
				readOnlyPaths: [],
			}),
			owned: [],
			sharedAppend: [],
			readOnly: [],
		});
	}

	// Assign patterns
	for (const [pattern, refs] of patternRefCount.entries()) {
		if (refs.length === 1) {
			// Single task references this pattern — owned
			const contract = contracts.get(refs[0]);
			if (contract) contract.owned.push(pattern);
		} else {
			// Multiple tasks reference this — find primary (most files, then alphabetical)
			const sorted = [...refs].sort((a, b) => {
				const diff = (taskFileCount.get(b) || 0) - (taskFileCount.get(a) || 0);
				return diff !== 0 ? diff : a.localeCompare(b);
			});
			const primary = sorted[0];

			for (const taskName of refs) {
				const contract = contracts.get(taskName);
				if (!contract) continue;
				if (taskName === primary) {
					contract.owned.push(pattern);
				} else {
					contract.sharedAppend.push(pattern);
				}
			}
		}
	}

	// Assign read-only: patterns referenced by other tasks but not this one
	const allPatterns = new Set(patternRefCount.keys());
	for (const task of tasks) {
		const contract = contracts.get(task.name);
		if (!contract) continue;
		const myPatterns = new Set(task.files);
		for (const pattern of allPatterns) {
			if (
				!myPatterns.has(pattern) &&
				!contract.owned.includes(pattern) &&
				!contract.sharedAppend.includes(pattern)
			) {
				contract.readOnly.push(pattern);
			}
		}
		contract.claims = normalizeClaimSet({
			ownedPaths: contract.owned,
			sharedPaths: contract.sharedAppend,
			readOnlyPaths: contract.readOnly,
		});
	}

	return contracts;
}

// --- Stage Decision ---

/**
 * Given overlap analysis for a stage, decide the execution strategy.
 */
export function decideStageStrategy(
	tasks: PlanningTask[],
	overlaps: TaskPairOverlap[],
	_repoRoot: string,
	options: SmartPlanOptions = {},
): StageDecision {
	// Single task — always parallel (nothing to conflict with)
	if (tasks.length <= 1) {
		return {
			strategy: "parallel",
			tasks,
			reason: "single task",
		};
	}

	const hardCompatibilityConflicts = overlaps.filter((overlap) => {
		const compatibility = overlap.compatibility;
		return Boolean(
			compatibility &&
				(!compatibility.clean ||
					compatibility.staleBase === true ||
					compatibility.needsReplay === true),
		);
	});

	if (hardCompatibilityConflicts.length > 0) {
		const sorted = [...tasks].sort((a, b) => a.name.localeCompare(b.name));
		const conflictNames = hardCompatibilityConflicts
			.map((overlap) => `${overlap.taskA}↔${overlap.taskB}`)
			.join(", ");
		return {
			strategy: "serial",
			tasks,
			serialOrder: sorted.map((t) => [t]),
			reason: `compatibility risk detected (${conflictNames}) — serializing to prevent conflicts`,
		};
	}

	const effectiveOverlaps = overlaps.filter(
		(overlap) => !overlap.compatibility || overlap.compatibility.clean !== true,
	);

	if (effectiveOverlaps.length === 0) {
		return {
			strategy: "parallel",
			tasks,
			reason:
				overlaps.length > 0
					? "compatibility data indicates safe parallelism"
					: "no file overlaps detected",
		};
	}

	// Check if any overlap exceeds thresholds
	const hasHighOverlap = effectiveOverlaps.some(
		(o) =>
			o.overlapRatio > OVERLAP_RATIO_THRESHOLD ||
			o.riskScore > RISK_SCORE_THRESHOLD,
	);

	if (hasHighOverlap) {
		// Serial — order by most-connected first
		const connectionCount = new Map<string, number>();
		for (const task of tasks) {
			connectionCount.set(task.name, 0);
		}
		for (const o of effectiveOverlaps) {
			connectionCount.set(o.taskA, (connectionCount.get(o.taskA) || 0) + 1);
			connectionCount.set(o.taskB, (connectionCount.get(o.taskB) || 0) + 1);
		}

		const sorted = [...tasks].sort((a, b) => {
			const diff =
				(connectionCount.get(b.name) || 0) - (connectionCount.get(a.name) || 0);
			return diff !== 0 ? diff : a.name.localeCompare(b.name);
		});

		const maxRatio = Math.max(...effectiveOverlaps.map((o) => o.overlapRatio));
		const maxRisk = Math.max(...effectiveOverlaps.map((o) => o.riskScore));
		const historyPenalty = effectiveOverlaps.reduce(
			(sum, overlap) => sum + overlap.historyPenalty,
			0,
		);
		const historySuffix =
			historyPenalty > 0
				? ` including ${historyPenalty.toFixed(1)} historical risk`
				: "";

		return {
			strategy: "serial",
			tasks,
			serialOrder: sorted.map((t) => [t]),
			reason: `high overlap detected (ratio: ${maxRatio.toFixed(2)}, risk: ${maxRisk.toFixed(1)}${historySuffix}) — serializing to prevent conflicts`,
		};
	}

	// Manageable overlap — parallel with contracts
	const contracts = buildContracts(tasks, effectiveOverlaps, options);
	const historyPenalty = effectiveOverlaps.reduce(
		(sum, overlap) => sum + overlap.historyPenalty,
		0,
	);
	const historySuffix =
		historyPenalty > 0
			? ` with ${historyPenalty.toFixed(1)} historical risk`
			: "";
	return {
		strategy: "parallel-with-contracts",
		tasks,
		contracts,
		reason: `${effectiveOverlaps.length} overlap(s) within thresholds${historySuffix} — parallel with modification contracts`,
	};
}

// --- Parallel Limit ---

/**
 * Split a stage of tasks into sub-batches when it exceeds maxParallel.
 * If the stage fits within the limit, returns it as a single batch.
 */
export function splitStageByParallelLimit(
	stage: WorkflowTask[],
	maxParallel: number,
): WorkflowTask[][] {
	if (stage.length <= maxParallel) return [stage];
	const batches: WorkflowTask[][] = [];
	for (let i = 0; i < stage.length; i += maxParallel) {
		batches.push(stage.slice(i, i + maxParallel));
	}
	return batches;
}

function calculateHistoryPenalty(
	taskA: string,
	taskB: string,
	history: HistoryEntry[],
): number {
	const taskNames = new Set([taskA, taskB]);
	let penalty = 0;

	for (const entry of history) {
		if (typeof entry.task !== "string" || !taskNames.has(entry.task)) {
			continue;
		}
		if (entry.action === "task.merge_conflict") {
			penalty += 1.5;
			continue;
		}
		if (
			entry.action === "task.failed" &&
			(entry.reason === "contract-violation" ||
				entry.reason === "merge-conflict")
		) {
			penalty += 1.0;
		}
	}

	return penalty;
}

// --- Top-Level Planner ---

/**
 * Analyze an execution plan and produce a refined smart plan.
 * Main entry point.
 */
export function createSmartPlan(
	stages: PlanningTask[][],
	repoRoot: string,
	maxParallel?: number,
	options: SmartPlanOptions = {},
): SmartPlan {
	const limit = maxParallel ?? 5;
	const allOverlaps: TaskPairOverlap[] = [];
	const refinedStages: StageDecision[] = [];
	let parallelCount = 0;
	let serialCount = 0;
	let contractCount = 0;

	for (const stage of stages) {
		if (stage.length <= 1) {
			refinedStages.push({
				strategy: "parallel",
				tasks: stage,
				reason: "single task",
			});
			parallelCount++;
			continue;
		}

		const overlaps = analyzeStageOverlaps(stage, repoRoot, options);
		allOverlaps.push(...overlaps);
		const decision = decideStageStrategy(stage, overlaps, repoRoot, options);

		// If strategy allows parallelism and tasks exceed the limit, split into sub-batches
		if (
			(decision.strategy === "parallel" ||
				decision.strategy === "parallel-with-contracts") &&
			decision.tasks.length > limit
		) {
			const batches = splitStageByParallelLimit(decision.tasks, limit);
			const totalBatches = batches.length;
			for (let idx = 0; idx < batches.length; idx++) {
				const batchDecision: StageDecision = {
					strategy: decision.strategy,
					tasks: batches[idx],
					contracts: decision.contracts,
					reason: `batch ${idx + 1}/${totalBatches} (capped at ${limit} parallel)`,
				};
				refinedStages.push(batchDecision);
				switch (decision.strategy) {
					case "parallel":
						parallelCount++;
						break;
					case "parallel-with-contracts":
						contractCount++;
						break;
				}
			}
		} else {
			refinedStages.push(decision);
			switch (decision.strategy) {
				case "parallel":
					parallelCount++;
					break;
				case "serial":
					serialCount++;
					break;
				case "parallel-with-contracts":
					contractCount++;
					break;
			}
		}
	}

	const totalTasks = stages.reduce((sum, s) => sum + s.length, 0);

	return {
		originalStages: stages,
		refinedStages,
		overlaps: allOverlaps,
		summary: {
			totalTasks,
			parallelStages: parallelCount,
			serialStages: serialCount,
			contractStages: contractCount,
			overlapCount: allOverlaps.length,
		},
	};
}

// --- Contract Markdown Renderer ---

/**
 * Render a FileContract as markdown for inclusion in .ruah-task.md.
 */
export function renderContractMarkdown(contract: FileContract): string {
	const buckets = contract.claims
		? claimSetToBuckets(contract.claims)
		: {
				owned: contract.owned,
				sharedAppend: contract.sharedAppend,
				readOnly: contract.readOnly,
			};
	const sections: string[] = [
		"## Modification Contract",
		"",
		"This task has a coordination contract with other parallel tasks.",
		"Follow these rules to avoid merge conflicts.",
	];

	if (buckets.owned.length > 0) {
		sections.push("");
		sections.push("### Owned Files (modify freely)");
		for (const f of buckets.owned) {
			sections.push(`- ${f}`);
		}
	}

	if (buckets.sharedAppend.length > 0) {
		sections.push("");
		sections.push(
			"### Shared Files (append-only — add new code, do NOT modify existing lines)",
		);
		for (const f of buckets.sharedAppend) {
			sections.push(`- ${f}`);
		}
	}

	if (buckets.readOnly.length > 0) {
		sections.push("");
		sections.push("### Read-Only Files (do not modify)");
		for (const f of buckets.readOnly) {
			sections.push(`- ${f}`);
		}
	}

	return sections.join("\n");
}
