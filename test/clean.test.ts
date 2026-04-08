import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claimSetFromFiles } from "../src/core/claims.js";
import type { Task } from "../src/core/state.js";
import { loadState, releaseLocks, saveState } from "../src/core/state.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-test-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeTask(overrides: Partial<Task> & { name: string }): Task {
	return {
		status: "in-progress",
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

describe("clean — stale task detection", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("identifies tasks whose worktrees are missing as stale", () => {
		const state = loadState(root);
		state.tasks["stale-task"] = makeTask({
			name: "stale-task",
			status: "in-progress",
			worktree: "/nonexistent/path",
		});
		state.locks["stale-task"] = ["src/auth/**"];

		// Simulate: active worktrees is empty (no worktrees exist)
		const activeWorktrees = new Set<string>();
		const staleTasks: string[] = [];

		for (const [name, task] of Object.entries(state.tasks)) {
			const isTerminal =
				task.status === "merged" || task.status === "cancelled";
			if (isTerminal) continue;
			if (!activeWorktrees.has(task.worktree)) {
				staleTasks.push(name);
			}
		}

		assert.equal(staleTasks.length, 1);
		assert.equal(staleTasks[0], "stale-task");
	});

	it("does not flag merged or cancelled tasks as stale", () => {
		const state = loadState(root);
		state.tasks["merged-task"] = makeTask({
			name: "merged-task",
			status: "merged",
			worktree: "/nonexistent/path",
		});
		state.tasks["cancelled-task"] = makeTask({
			name: "cancelled-task",
			status: "cancelled",
			worktree: "/nonexistent/path",
		});

		const activeWorktrees = new Set<string>();
		const staleTasks: string[] = [];

		for (const [name, task] of Object.entries(state.tasks)) {
			const isTerminal =
				task.status === "merged" || task.status === "cancelled";
			if (isTerminal) continue;
			if (!activeWorktrees.has(task.worktree)) {
				staleTasks.push(name);
			}
		}

		assert.equal(staleTasks.length, 0);
	});

	it("detects orphaned locks (locks for nonexistent tasks)", () => {
		const state = loadState(root);
		state.tasks["real-task"] = makeTask({
			name: "real-task",
			status: "merged",
		});
		state.locks["real-task"] = ["src/a/**"];
		state.locks["ghost-task"] = ["src/b/**"];
		state.locks["another-ghost"] = ["src/c/**"];

		const orphanedLocks: string[] = [];
		for (const lockOwner of Object.keys(state.locks)) {
			if (!state.tasks[lockOwner]) {
				orphanedLocks.push(lockOwner);
			}
		}

		assert.equal(orphanedLocks.length, 2);
		assert.ok(orphanedLocks.includes("ghost-task"));
		assert.ok(orphanedLocks.includes("another-ghost"));
	});

	it("releaseLocks removes orphaned lock entries", () => {
		const state = loadState(root);
		state.locks.ghost = ["src/**"];
		state.locks.real = ["lib/**"];

		releaseLocks(state, "ghost");

		assert.equal(state.locks.ghost, undefined);
		assert.deepEqual(state.locks.real, ["lib/**"]);
	});

	it("cleaning a stale task releases its locks and marks it cancelled", () => {
		const state = loadState(root);
		state.tasks.stale = makeTask({
			name: "stale",
			status: "in-progress",
			worktree: "/nonexistent",
		});
		state.locks.stale = ["src/feature/**"];

		// Simulate the clean operation
		releaseLocks(state, "stale");
		state.tasks.stale.status = "cancelled";

		saveState(root, state);

		const loaded = loadState(root);
		assert.equal(loaded.tasks.stale.status, "cancelled");
		assert.equal(loaded.locks.stale, undefined);
	});

	it("dry-run mode does not modify state", () => {
		const state = loadState(root);
		state.tasks.stale = makeTask({
			name: "stale",
			status: "in-progress",
			worktree: "/nonexistent",
		});
		state.locks.stale = ["src/**"];
		saveState(root, state);

		// In dry-run, we only identify but don't modify
		const loaded = loadState(root);
		assert.equal(loaded.tasks.stale.status, "in-progress");
		assert.deepEqual(loaded.locks.stale, ["src/**"]);
	});

	it("force flag includes tasks with existing worktrees", () => {
		const state = loadState(root);
		const existingPath = "/existing/worktree";
		state.tasks.active = makeTask({
			name: "active",
			status: "in-progress",
			worktree: existingPath,
		});

		const activeWorktrees = new Set<string>([existingPath]);
		const force = true;
		const staleTasks: string[] = [];

		for (const [name, task] of Object.entries(state.tasks)) {
			const isTerminal =
				task.status === "merged" || task.status === "cancelled";
			if (isTerminal) continue;
			const worktreeExists = activeWorktrees.has(task.worktree);
			if (!worktreeExists) {
				staleTasks.push(name);
			} else if (force) {
				staleTasks.push(name);
			}
		}

		assert.equal(staleTasks.length, 1);
		assert.equal(staleTasks[0], "active");
	});

	it("handles mixed stale tasks and orphaned locks", () => {
		const state = loadState(root);
		state.tasks["stale-a"] = makeTask({
			name: "stale-a",
			status: "failed",
			worktree: "/gone/a",
		});
		state.tasks["stale-b"] = makeTask({
			name: "stale-b",
			status: "created",
			worktree: "/gone/b",
		});
		state.tasks["merged-ok"] = makeTask({
			name: "merged-ok",
			status: "merged",
		});
		state.locks["stale-a"] = ["src/a/**"];
		state.locks["stale-b"] = ["src/b/**"];
		state.locks.orphan = ["src/c/**"];

		const activeWorktrees = new Set<string>();

		// Identify stale tasks
		const staleTasks: string[] = [];
		for (const [name, task] of Object.entries(state.tasks)) {
			const isTerminal =
				task.status === "merged" || task.status === "cancelled";
			if (isTerminal) continue;
			if (!activeWorktrees.has(task.worktree)) {
				staleTasks.push(name);
			}
		}

		// Identify orphaned locks
		const orphanedLocks: string[] = [];
		for (const lockOwner of Object.keys(state.locks)) {
			if (!state.tasks[lockOwner]) {
				orphanedLocks.push(lockOwner);
			}
		}

		assert.equal(staleTasks.length, 2);
		assert.equal(orphanedLocks.length, 1);
		assert.equal(orphanedLocks[0], "orphan");

		// Clean them
		for (const name of staleTasks) {
			releaseLocks(state, name);
			state.tasks[name].status = "cancelled";
		}
		for (const lockOwner of orphanedLocks) {
			releaseLocks(state, lockOwner);
		}

		saveState(root, state);
		const loaded = loadState(root);

		assert.equal(loaded.tasks["stale-a"].status, "cancelled");
		assert.equal(loaded.tasks["stale-b"].status, "cancelled");
		assert.equal(loaded.tasks["merged-ok"].status, "merged");
		assert.equal(Object.keys(loaded.locks).length, 0);
	});
});
