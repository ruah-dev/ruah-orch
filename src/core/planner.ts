import { statSync } from "node:fs";
import { join } from "node:path";
import { type HistoryEntry, loadState, patternsOverlap } from "./state.js";
import type { WorkflowTask } from "./workflow.js";

// --- Types ---

export type FileAccessMode = "owned" | "shared-append" | "read-only";

export interface FileContract {
	taskName: string;
	/** Files this agent exclusively owns — modify freely */
	owned: string[];
	/** Files shared with other agents — only append new code, don't modify existing lines */
	sharedAppend: string[];
	/** Files visible but must not be modified */
	readOnly: string[];
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
	tasks: WorkflowTask[],
	repoRoot: string,
): TaskPairOverlap[] {
	const overlaps: TaskPairOverlap[] = [];
	const history = loadState(repoRoot).history;

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const a = tasks[i];
			const b = tasks[j];
			const overlapping: string[] = [];

			for (const pa of a.files) {
				for (const pb of b.files) {
					if (patternsOverlap(pa, pb, repoRoot)) {
						// Add both patterns to show what overlaps
						if (!overlapping.includes(pa)) overlapping.push(pa);
						if (!overlapping.includes(pb)) overlapping.push(pb);
					}
				}
			}

			if (overlapping.length > 0) {
				const unionSize = new Set([...a.files, ...b.files]).size;
				const overlapRatio = overlapping.length / unionSize;
				const baseRisk = overlapping.reduce(
					(sum, p) => sum + estimatePatternRisk(p, repoRoot),
					0,
				);
				const historyPenalty = calculateHistoryPenalty(a.name, b.name, history);
				const riskScore = baseRisk + historyPenalty;

				overlaps.push({
					taskA: a.name,
					taskB: b.name,
					overlappingPatterns: overlapping,
					overlapRatio: Math.min(overlapRatio, 1.0),
					riskScore,
					historyPenalty,
				});
			}
		}
	}

	return overlaps;
}

// --- Contract Generation ---

/**
 * Given tasks with manageable overlap, assign file access modes to each task.
 */
export function buildContracts(
	tasks: WorkflowTask[],
	_overlaps: TaskPairOverlap[],
): Map<string, FileContract> {
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
	}

	return contracts;
}

// --- Stage Decision ---

/**
 * Given overlap analysis for a stage, decide the execution strategy.
 */
export function decideStageStrategy(
	tasks: WorkflowTask[],
	overlaps: TaskPairOverlap[],
	_repoRoot: string,
): StageDecision {
	// Single task — always parallel (nothing to conflict with)
	if (tasks.length <= 1) {
		return {
			strategy: "parallel",
			tasks,
			reason: "single task",
		};
	}

	// No overlaps — safe to parallelize
	if (overlaps.length === 0) {
		return {
			strategy: "parallel",
			tasks,
			reason: "no file overlaps detected",
		};
	}

	// Check if any overlap exceeds thresholds
	const hasHighOverlap = overlaps.some(
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
		for (const o of overlaps) {
			connectionCount.set(o.taskA, (connectionCount.get(o.taskA) || 0) + 1);
			connectionCount.set(o.taskB, (connectionCount.get(o.taskB) || 0) + 1);
		}

		const sorted = [...tasks].sort((a, b) => {
			const diff =
				(connectionCount.get(b.name) || 0) - (connectionCount.get(a.name) || 0);
			return diff !== 0 ? diff : a.name.localeCompare(b.name);
		});

		const maxRatio = Math.max(...overlaps.map((o) => o.overlapRatio));
		const maxRisk = Math.max(...overlaps.map((o) => o.riskScore));
		const historyPenalty = overlaps.reduce(
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
	const contracts = buildContracts(tasks, overlaps);
	const historyPenalty = overlaps.reduce(
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
		reason: `${overlaps.length} overlap(s) within thresholds${historySuffix} — parallel with modification contracts`,
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
	stages: WorkflowTask[][],
	repoRoot: string,
	maxParallel?: number,
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

		const overlaps = analyzeStageOverlaps(stage, repoRoot);
		allOverlaps.push(...overlaps);
		const decision = decideStageStrategy(stage, overlaps, repoRoot);

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
	const sections: string[] = [
		"## Modification Contract",
		"",
		"This task has a coordination contract with other parallel tasks.",
		"Follow these rules to avoid merge conflicts.",
	];

	if (contract.owned.length > 0) {
		sections.push("");
		sections.push("### Owned Files (modify freely)");
		for (const f of contract.owned) {
			sections.push(`- ${f}`);
		}
	}

	if (contract.sharedAppend.length > 0) {
		sections.push("");
		sections.push(
			"### Shared Files (append-only — add new code, do NOT modify existing lines)",
		);
		for (const f of contract.sharedAppend) {
			sections.push(`- ${f}`);
		}
	}

	if (contract.readOnly.length > 0) {
		sections.push("");
		sections.push("### Read-Only Files (do not modify)");
		for (const f of contract.readOnly) {
			sections.push(`- ${f}`);
		}
	}

	return sections.join("\n");
}
