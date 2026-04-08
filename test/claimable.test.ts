import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimSetFromFiles } from "../src/core/claims.js";
import type { RuahState, Task } from "../src/core/state.js";
import { getClaimableTasks, isTaskClaimable } from "../src/core/state.js";

function makeTask(overrides: Partial<Task> & { name: string }): Task {
	return {
		status: "created",
		baseBranch: "main",
		branch: `ruah/${overrides.name}`,
		worktree: `/tmp/worktrees/${overrides.name}`,
		files: [],
		workspace: {
			id: overrides.name,
			kind: "worktree",
			root: `/tmp/worktrees/${overrides.name}`,
			baseRef: "main",
			headRef: `ruah/${overrides.name}`,
			metadata: { branchName: `ruah/${overrides.name}` },
		},
		claims: claimSetFromFiles([]),
		artifact: null,
		integration: { status: "unknown", conflictsWith: [] },
		lockMode: "write",
		executor: null,
		prompt: null,
		parent: null,
		children: [],
		depends: [],
		createdAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		mergedAt: null,
		...overrides,
	};
}

function makeState(tasks: Task[]): RuahState {
	return {
		version: 2,
		revision: 0,
		baseBranch: "main",
		tasks: Object.fromEntries(tasks.map((t) => [t.name, t])),
		artifacts: {},
		locks: {},
		lockModes: {},
		lockSnapshots: {},
		history: [],
	};
}

describe("isTaskClaimable", () => {
	it("task with no dependencies is claimable", () => {
		const state = makeState([makeTask({ name: "auth" })]);
		const result = isTaskClaimable(state, "auth");
		assert.ok(result.claimable);
		assert.deepEqual(result.blockedBy, []);
	});

	it("task with all deps done is claimable", () => {
		const state = makeState([
			makeTask({ name: "backend", status: "done", depends: [] }),
			makeTask({ name: "frontend", status: "done", depends: [] }),
			makeTask({ name: "integration", depends: ["backend", "frontend"] }),
		]);
		const result = isTaskClaimable(state, "integration");
		assert.ok(result.claimable);
		assert.deepEqual(result.blockedBy, []);
	});

	it("task with all deps merged is claimable", () => {
		const state = makeState([
			makeTask({ name: "backend", status: "merged", depends: [] }),
			makeTask({ name: "integration", depends: ["backend"] }),
		]);
		const result = isTaskClaimable(state, "integration");
		assert.ok(result.claimable);
	});

	it("task with dep removed from state (already merged+cleaned) is claimable", () => {
		// After merge, removeTask deletes the task from state entirely
		const state = makeState([
			makeTask({ name: "integration", depends: ["backend"] }),
		]);
		// "backend" doesn't exist in state — was merged and cleaned up
		const result = isTaskClaimable(state, "integration");
		assert.ok(result.claimable);
	});

	it("task with in-progress dep is NOT claimable", () => {
		const state = makeState([
			makeTask({ name: "backend", status: "in-progress", depends: [] }),
			makeTask({ name: "integration", depends: ["backend"] }),
		]);
		const result = isTaskClaimable(state, "integration");
		assert.ok(!result.claimable);
		assert.deepEqual(result.blockedBy, ["backend"]);
	});

	it("task with created dep is NOT claimable", () => {
		const state = makeState([
			makeTask({ name: "backend", status: "created", depends: [] }),
			makeTask({ name: "integration", depends: ["backend"] }),
		]);
		const result = isTaskClaimable(state, "integration");
		assert.ok(!result.claimable);
		assert.deepEqual(result.blockedBy, ["backend"]);
	});

	it("task with failed dep is NOT claimable", () => {
		const state = makeState([
			makeTask({ name: "backend", status: "failed", depends: [] }),
			makeTask({ name: "integration", depends: ["backend"] }),
		]);
		const result = isTaskClaimable(state, "integration");
		assert.ok(!result.claimable);
		assert.deepEqual(result.blockedBy, ["backend"]);
	});

	it("reports all blocking deps, not just the first", () => {
		const state = makeState([
			makeTask({ name: "a", status: "in-progress", depends: [] }),
			makeTask({ name: "b", status: "created", depends: [] }),
			makeTask({ name: "c", status: "done", depends: [] }),
			makeTask({ name: "target", depends: ["a", "b", "c"] }),
		]);
		const result = isTaskClaimable(state, "target");
		assert.ok(!result.claimable);
		assert.deepEqual(result.blockedBy, ["a", "b"]);
	});

	it("nonexistent task is not claimable", () => {
		const state = makeState([]);
		const result = isTaskClaimable(state, "ghost");
		assert.ok(!result.claimable);
	});

	it("mixed done and merged deps are all satisfied", () => {
		const state = makeState([
			makeTask({ name: "a", status: "done", depends: [] }),
			makeTask({ name: "b", status: "merged", depends: [] }),
			makeTask({ name: "target", depends: ["a", "b"] }),
		]);
		const result = isTaskClaimable(state, "target");
		assert.ok(result.claimable);
	});
});

describe("getClaimableTasks", () => {
	it("returns empty when no tasks exist", () => {
		const state = makeState([]);
		assert.deepEqual(getClaimableTasks(state), []);
	});

	it("returns only created tasks with satisfied deps", () => {
		const state = makeState([
			makeTask({ name: "a", status: "done", depends: [] }),
			makeTask({ name: "b", status: "in-progress", depends: [] }),
			makeTask({ name: "c", status: "created", depends: ["a"] }),
			makeTask({ name: "d", status: "created", depends: ["b"] }),
			makeTask({ name: "e", status: "created", depends: [] }),
		]);
		const claimable = getClaimableTasks(state);
		const names = claimable.map((t) => t.name).sort();
		assert.deepEqual(names, ["c", "e"]);
	});

	it("excludes in-progress tasks even if deps are met", () => {
		const state = makeState([
			makeTask({ name: "a", status: "in-progress", depends: [] }),
		]);
		assert.deepEqual(getClaimableTasks(state), []);
	});

	it("handles DAG fan-in correctly", () => {
		// Diamond DAG: a -> c, b -> c, a -> d, b -> d
		const state = makeState([
			makeTask({ name: "a", status: "done", depends: [] }),
			makeTask({ name: "b", status: "done", depends: [] }),
			makeTask({ name: "c", status: "created", depends: ["a", "b"] }),
			makeTask({ name: "d", status: "created", depends: ["a", "b"] }),
		]);
		const claimable = getClaimableTasks(state);
		const names = claimable.map((t) => t.name).sort();
		assert.deepEqual(names, ["c", "d"]);
	});

	it("returns nothing when all created tasks are blocked", () => {
		const state = makeState([
			makeTask({ name: "a", status: "in-progress", depends: [] }),
			makeTask({ name: "b", status: "created", depends: ["a"] }),
			makeTask({ name: "c", status: "created", depends: ["b"] }),
		]);
		const claimable = getClaimableTasks(state);
		assert.deepEqual(claimable, []);
	});

	it("deep chain: only leaf-most ready task is claimable", () => {
		// a (done) -> b (created) -> c (created)
		const state = makeState([
			makeTask({ name: "a", status: "done", depends: [] }),
			makeTask({ name: "b", status: "created", depends: ["a"] }),
			makeTask({ name: "c", status: "created", depends: ["b"] }),
		]);
		const claimable = getClaimableTasks(state);
		assert.equal(claimable.length, 1);
		assert.equal(claimable[0].name, "b");
	});
});
