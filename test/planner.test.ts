import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FileContract } from "../src/core/planner.js";
import {
	analyzeStageOverlaps,
	buildContracts,
	createSmartPlan,
	decideStageStrategy,
	estimatePatternRisk,
	renderContractMarkdown,
	splitStageByParallelLimit,
} from "../src/core/planner.js";
import type { WorkflowTask } from "../src/core/workflow.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-test-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeTask(name: string, files: string[]): WorkflowTask {
	return {
		name,
		files,
		executor: null,
		depends: [],
		prompt: "",
		onConflict: "fail",
	};
}

/** Extract a value from a Map, failing the test if the key is missing. */
function getContract(
	contracts: Map<string, FileContract>,
	key: string,
): FileContract {
	const value = contracts.get(key);
	assert.ok(value, `expected contract for "${key}" to exist`);
	return value;
}

describe("estimatePatternRisk", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("glob pattern returns 1.0", () => {
		assert.equal(estimatePatternRisk("src/**", root), 1.0);
	});

	it("non-existent file returns 0.5", () => {
		assert.equal(estimatePatternRisk("does/not/exist.ts", root), 0.5);
	});

	it("small file (< 100 bytes) returns 0.3", () => {
		const file = "small.ts";
		writeFileSync(join(root, file), "x".repeat(50));
		assert.equal(estimatePatternRisk(file, root), 0.3);
	});

	it("medium file (100-999 bytes) returns 0.7", () => {
		const file = "medium.ts";
		writeFileSync(join(root, file), "x".repeat(500));
		assert.equal(estimatePatternRisk(file, root), 0.7);
	});

	it("large file (>= 1000 bytes) returns 1.5", () => {
		const file = "large.ts";
		writeFileSync(join(root, file), "x".repeat(1500));
		assert.equal(estimatePatternRisk(file, root), 1.5);
	});

	it("directory returns 1.0", () => {
		const dir = "subdir";
		mkdirSync(join(root, dir));
		assert.equal(estimatePatternRisk(dir, root), 1.0);
	});
});

describe("analyzeStageOverlaps", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("two tasks with no overlapping files returns empty array", () => {
		const tasks = [
			makeTask("auth", ["src/auth/login.ts", "src/auth/signup.ts"]),
			makeTask("api", ["src/api/routes.ts", "src/api/handler.ts"]),
		];
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.equal(overlaps.length, 0);
	});

	it("two tasks with identical files returns overlap with ratio ~1.0", () => {
		const files = ["src/shared.ts", "src/utils.ts"];
		const tasks = [makeTask("taskA", files), makeTask("taskB", files)];
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.equal(overlaps.length, 1);
		assert.equal(overlaps[0].taskA, "taskA");
		assert.equal(overlaps[0].taskB, "taskB");
		// Union of identical sets = same set; overlapping patterns = all; ratio = 1.0
		assert.equal(overlaps[0].overlapRatio, 1.0);
	});

	it("two tasks with partial overlap returns correct ratio and patterns", () => {
		const tasks = [
			makeTask("auth", ["src/auth.ts", "src/shared.ts"]),
			makeTask("api", ["src/api.ts", "src/shared.ts"]),
		];
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.equal(overlaps.length, 1);
		assert.ok(overlaps[0].overlappingPatterns.includes("src/shared.ts"));
		// 1 overlapping pattern / 3 unique files = 0.333...
		const union = new Set(["src/auth.ts", "src/shared.ts", "src/api.ts"]).size;
		assert.equal(
			overlaps[0].overlapRatio,
			overlaps[0].overlappingPatterns.length / union,
		);
	});

	it("three tasks produce correct number of pair entries", () => {
		// All three share the same file so we get 3 pairs: AB, AC, BC
		const tasks = [
			makeTask("a", ["shared.ts"]),
			makeTask("b", ["shared.ts"]),
			makeTask("c", ["shared.ts"]),
		];
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.equal(overlaps.length, 3);
	});

	it("tasks with glob overlap detected", () => {
		const tasks = [
			makeTask("broad", ["src/**"]),
			makeTask("narrow", ["src/auth/**"]),
		];
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.equal(overlaps.length, 1);
		assert.ok(overlaps[0].overlappingPatterns.includes("src/**"));
		assert.ok(overlaps[0].overlappingPatterns.includes("src/auth/**"));
	});
});

describe("buildContracts", () => {
	it("non-overlapping files: each task gets all files as owned", () => {
		const tasks = [
			makeTask("auth", ["src/auth.ts"]),
			makeTask("api", ["src/api.ts"]),
		];
		const contracts = buildContracts(tasks, []);
		const authContract = getContract(contracts, "auth");
		const apiContract = getContract(contracts, "api");
		assert.deepEqual(authContract.owned, ["src/auth.ts"]);
		assert.deepEqual(authContract.sharedAppend, []);
		assert.deepEqual(apiContract.owned, ["src/api.ts"]);
		assert.deepEqual(apiContract.sharedAppend, []);
	});

	it("one shared pattern: primary task (most files) gets owned, other gets shared-append", () => {
		const tasks = [
			makeTask("big", ["src/a.ts", "src/b.ts", "src/shared.ts"]),
			makeTask("small", ["src/shared.ts"]),
		];
		const contracts = buildContracts(tasks, []);
		const bigContract = getContract(contracts, "big");
		const smallContract = getContract(contracts, "small");
		// big has more files so it's primary for the shared pattern
		assert.ok(bigContract.owned.includes("src/shared.ts"));
		assert.ok(smallContract.sharedAppend.includes("src/shared.ts"));
	});

	it("all files shared between two tasks: deterministic assignment", () => {
		const files = ["src/x.ts", "src/y.ts"];
		const tasks = [makeTask("alpha", files), makeTask("beta", files)];
		const contracts = buildContracts(tasks, []);
		const alphaContract = getContract(contracts, "alpha");
		const betaContract = getContract(contracts, "beta");
		// Both tasks have equal file count so tie-break is alphabetical
		// "alpha" < "beta", so alpha is primary
		assert.deepEqual(alphaContract.owned, ["src/x.ts", "src/y.ts"]);
		assert.deepEqual(alphaContract.sharedAppend, []);
		assert.deepEqual(betaContract.owned, []);
		assert.deepEqual(betaContract.sharedAppend, ["src/x.ts", "src/y.ts"]);
	});

	it("read-only assigned for patterns from other tasks not in this task's files", () => {
		const tasks = [
			makeTask("auth", ["src/auth.ts", "src/shared.ts"]),
			makeTask("api", ["src/api.ts", "src/shared.ts"]),
		];
		const contracts = buildContracts(tasks, []);
		const authContract = getContract(contracts, "auth");
		const apiContract = getContract(contracts, "api");
		// auth doesn't reference src/api.ts -> read-only
		assert.ok(authContract.readOnly.includes("src/api.ts"));
		// api doesn't reference src/auth.ts -> read-only
		assert.ok(apiContract.readOnly.includes("src/auth.ts"));
	});

	it("tie-breaking: alphabetical by task name when file counts are equal", () => {
		const tasks = [
			makeTask("zebra", ["src/shared.ts"]),
			makeTask("alpha", ["src/shared.ts"]),
		];
		const contracts = buildContracts(tasks, []);
		// Equal file count -> alphabetical: "alpha" wins primary
		const alphaContract = getContract(contracts, "alpha");
		const zebraContract = getContract(contracts, "zebra");
		assert.ok(alphaContract.owned.includes("src/shared.ts"));
		assert.ok(zebraContract.sharedAppend.includes("src/shared.ts"));
	});
});

describe("decideStageStrategy", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("single task returns parallel", () => {
		const tasks = [makeTask("solo", ["src/solo.ts"])];
		const decision = decideStageStrategy(tasks, [], root);
		assert.equal(decision.strategy, "parallel");
		assert.equal(decision.reason, "single task");
	});

	it("no overlaps returns parallel", () => {
		const tasks = [
			makeTask("auth", ["src/auth.ts"]),
			makeTask("api", ["src/api.ts"]),
		];
		const decision = decideStageStrategy(tasks, [], root);
		assert.equal(decision.strategy, "parallel");
		assert.equal(decision.reason, "no file overlaps detected");
	});

	it("low overlap within thresholds returns parallel-with-contracts", () => {
		const tasksLow = [
			makeTask("auth", [
				"src/auth.ts",
				"src/auth2.ts",
				"src/auth3.ts",
				"src/shared.ts",
			]),
			makeTask("api", [
				"src/api.ts",
				"src/api2.ts",
				"src/api3.ts",
				"src/shared.ts",
			]),
		];
		// Overlapping: "src/shared.ts" = 1 pattern
		// Union: 7 unique files -> ratio = 1/7 ~ 0.14
		// Risk: estimatePatternRisk("src/shared.ts", root) = 0.5 (non-existent)
		// 0.5 < 2.0 threshold -> parallel-with-contracts
		const overlaps = analyzeStageOverlaps(tasksLow, root);
		const decision = decideStageStrategy(tasksLow, overlaps, root);
		assert.equal(decision.strategy, "parallel-with-contracts");
		assert.ok(decision.contracts);
	});

	it("high overlap ratio (> 0.3) returns serial", () => {
		const tasks = [
			makeTask("auth", ["src/shared.ts"]),
			makeTask("api", ["src/shared.ts"]),
		];
		// Overlap: "src/shared.ts" = 1 pattern, union = 1 -> ratio = 1.0
		// ratio 1.0 > 0.3 -> serial
		const overlaps = analyzeStageOverlaps(tasks, root);
		const decision = decideStageStrategy(tasks, overlaps, root);
		assert.equal(decision.strategy, "serial");
		assert.ok(decision.serialOrder);
	});

	it("high risk score (> 2.0) returns serial with most-connected task first", () => {
		// Create large files to get high risk scores (1.5 each)
		writeFileSync(join(root, "big1.ts"), "x".repeat(2000));
		writeFileSync(join(root, "big2.ts"), "x".repeat(2000));
		writeFileSync(join(root, "big3.ts"), "x".repeat(2000));

		const tasks = [
			makeTask("taskA", [
				"big1.ts",
				"big2.ts",
				"a-only1.ts",
				"a-only2.ts",
				"a-only3.ts",
				"a-only4.ts",
				"a-only5.ts",
				"a-only6.ts",
				"a-only7.ts",
				"a-only8.ts",
			]),
			makeTask("taskB", [
				"big1.ts",
				"big2.ts",
				"big3.ts",
				"b-only1.ts",
				"b-only2.ts",
				"b-only3.ts",
				"b-only4.ts",
				"b-only5.ts",
				"b-only6.ts",
				"b-only7.ts",
			]),
		];
		// Overlapping: big1.ts, big2.ts = 2 patterns
		// Union: 18 unique files -> ratio = 2/18 ~ 0.11 (within ratio threshold)
		// Risk: 1.5 + 1.5 = 3.0 > 2.0 threshold -> serial
		const overlaps = analyzeStageOverlaps(tasks, root);
		assert.ok(overlaps.length > 0);
		assert.ok(overlaps[0].riskScore > 2.0);
		const decision = decideStageStrategy(tasks, overlaps, root);
		assert.equal(decision.strategy, "serial");
		assert.ok(decision.serialOrder);
		// Both tasks have 1 connection each, tie-break alphabetical
		assert.equal(decision.serialOrder[0][0].name, "taskA");
	});
});

describe("createSmartPlan", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("all non-overlapping stages result in all parallel with correct summary", () => {
		const stages = [
			[makeTask("auth", ["src/auth.ts"]), makeTask("api", ["src/api.ts"])],
			[makeTask("ui", ["src/ui.ts"]), makeTask("db", ["src/db.ts"])],
		];
		const plan = createSmartPlan(stages, root);
		assert.equal(plan.summary.totalTasks, 4);
		assert.equal(plan.summary.parallelStages, 2);
		assert.equal(plan.summary.serialStages, 0);
		assert.equal(plan.summary.contractStages, 0);
		assert.equal(plan.summary.overlapCount, 0);
		assert.equal(plan.refinedStages.length, 2);
		for (const stage of plan.refinedStages) {
			assert.equal(stage.strategy, "parallel");
		}
	});

	it("mixed stages produce correct parallel/serial/contract counts", () => {
		// Stage 1: single task -> parallel
		// Stage 2: high overlap -> serial
		const stages = [
			[makeTask("solo", ["src/solo.ts"])],
			[makeTask("a", ["src/shared.ts"]), makeTask("b", ["src/shared.ts"])],
		];
		const plan = createSmartPlan(stages, root);
		assert.equal(plan.summary.totalTasks, 3);
		assert.equal(plan.summary.parallelStages, 1);
		// The high-overlap stage becomes serial (ratio 1.0 > 0.3)
		assert.equal(plan.summary.serialStages, 1);
		assert.equal(plan.refinedStages[0].strategy, "parallel");
		assert.equal(plan.refinedStages[1].strategy, "serial");
	});

	it("with maxParallel=2 splits a 4-task stage into 2 batches", () => {
		const stages = [
			[
				makeTask("a", ["src/a.ts"]),
				makeTask("b", ["src/b.ts"]),
				makeTask("c", ["src/c.ts"]),
				makeTask("d", ["src/d.ts"]),
			],
		];
		const plan = createSmartPlan(stages, root, 2);
		// 4 tasks / maxParallel 2 = 2 batches
		assert.equal(plan.refinedStages.length, 2);
		assert.equal(plan.refinedStages[0].tasks.length, 2);
		assert.equal(plan.refinedStages[1].tasks.length, 2);
		assert.ok(plan.refinedStages[0].reason.includes("batch 1/2"));
		assert.ok(plan.refinedStages[1].reason.includes("batch 2/2"));
		assert.ok(plan.refinedStages[0].reason.includes("capped at 2 parallel"));
	});

	it("single-task stages are always parallel", () => {
		const stages = [
			[makeTask("one", ["src/a.ts"])],
			[makeTask("two", ["src/b.ts"])],
			[makeTask("three", ["src/c.ts"])],
		];
		const plan = createSmartPlan(stages, root);
		assert.equal(plan.summary.parallelStages, 3);
		assert.equal(plan.summary.serialStages, 0);
		assert.equal(plan.summary.contractStages, 0);
		for (const stage of plan.refinedStages) {
			assert.equal(stage.strategy, "parallel");
			assert.equal(stage.reason, "single task");
		}
	});
});

describe("splitStageByParallelLimit", () => {
	it("splits 7 tasks with limit 3 into [3, 3, 1]", () => {
		const tasks = Array.from({ length: 7 }, (_, i) =>
			makeTask(`task-${i}`, [`src/file-${i}.ts`]),
		);
		const batches = splitStageByParallelLimit(tasks, 3);
		assert.equal(batches.length, 3);
		assert.equal(batches[0].length, 3);
		assert.equal(batches[1].length, 3);
		assert.equal(batches[2].length, 1);
	});

	it("returns single batch when under limit", () => {
		const tasks = [makeTask("a", ["src/a.ts"]), makeTask("b", ["src/b.ts"])];
		const batches = splitStageByParallelLimit(tasks, 5);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 2);
	});

	it("returns single batch when exactly at limit", () => {
		const tasks = Array.from({ length: 3 }, (_, i) =>
			makeTask(`task-${i}`, [`src/file-${i}.ts`]),
		);
		const batches = splitStageByParallelLimit(tasks, 3);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 3);
	});
});

describe("renderContractMarkdown", () => {
	it("renders all three sections when present", () => {
		const md = renderContractMarkdown({
			taskName: "auth",
			owned: ["src/auth.ts"],
			sharedAppend: ["src/shared.ts"],
			readOnly: ["src/api.ts"],
		});
		assert.ok(md.includes("## Modification Contract"));
		assert.ok(md.includes("### Owned Files"));
		assert.ok(md.includes("- src/auth.ts"));
		assert.ok(md.includes("### Shared Files"));
		assert.ok(md.includes("- src/shared.ts"));
		assert.ok(md.includes("### Read-Only Files"));
		assert.ok(md.includes("- src/api.ts"));
	});

	it("omits empty sections", () => {
		const md = renderContractMarkdown({
			taskName: "auth",
			owned: ["src/auth.ts"],
			sharedAppend: [],
			readOnly: [],
		});
		assert.ok(md.includes("### Owned Files"));
		assert.ok(!md.includes("### Shared Files"));
		assert.ok(!md.includes("### Read-Only Files"));
	});

	it("contains correct headers", () => {
		const md = renderContractMarkdown({
			taskName: "test",
			owned: [],
			sharedAppend: ["src/shared.ts"],
			readOnly: ["src/other.ts"],
		});
		assert.ok(md.startsWith("## Modification Contract"));
		assert.ok(
			md.includes(
				"### Shared Files (append-only — add new code, do NOT modify existing lines)",
			),
		);
		assert.ok(md.includes("### Read-Only Files (do not modify)"));
		assert.ok(!md.includes("### Owned Files"));
	});
});
