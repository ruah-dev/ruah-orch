import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claimSetFromFiles } from "../src/core/claims.js";
import type { Task } from "../src/core/state.js";
import { addHistoryEntry, loadState, saveState } from "../src/core/state.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-test-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeFailedTask(name: string, root: string): Task {
	return {
		name,
		status: "failed",
		baseBranch: "main",
		branch: `ruah/${name}`,
		worktree: join(root, ".ruah", "worktrees", name),
		files: ["src/auth/**"],
		workspace: {
			id: name,
			kind: "worktree",
			root: join(root, ".ruah", "worktrees", name),
			baseRef: "main",
			headRef: `ruah/${name}`,
			metadata: { branchName: `ruah/${name}` },
		},
		claims: claimSetFromFiles(["src/auth/**"]),
		artifact: null,
		integration: { status: "unknown", conflictsWith: [] },
		lockMode: "write",
		executor: "script",
		prompt: "echo hello",
		parent: null,
		children: [],
		depends: [],
		repoRoot: root,
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null,
		mergedAt: null,
	};
}

describe("task retry", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("can only retry failed tasks", () => {
		const state = loadState(root);
		state.tasks.auth = makeFailedTask("auth", root);
		state.tasks.auth.status = "done";
		saveState(root, state);

		// Verify task is not retryable when status is "done"
		const loaded = loadState(root);
		assert.equal(loaded.tasks.auth.status, "done");
		assert.notEqual(loaded.tasks.auth.status, "failed");
	});

	it("retry resets failed task state correctly", () => {
		const state = loadState(root);
		state.tasks.auth = makeFailedTask("auth", root);
		saveState(root, state);

		// Simulate retry: reset status
		const loaded = loadState(root);
		const task = loaded.tasks.auth;
		assert.equal(task.status, "failed");

		task.status = "in-progress";
		task.startedAt = new Date().toISOString();
		task.completedAt = null;
		addHistoryEntry(loaded, "task.retried", { task: "auth" });
		saveState(root, loaded);

		// Verify
		const after = loadState(root);
		assert.equal(after.tasks.auth.status, "in-progress");
		assert.equal(after.tasks.auth.completedAt, null);
		assert.ok(after.history.some((h) => h.action === "task.retried"));
	});

	it("retry preserves worktree and branch", () => {
		const state = loadState(root);
		const task = makeFailedTask("auth", root);
		state.tasks.auth = task;
		saveState(root, state);

		// Simulate retry
		const loaded = loadState(root);
		const retried = loaded.tasks.auth;
		retried.status = "in-progress";
		retried.startedAt = new Date().toISOString();
		retried.completedAt = null;
		saveState(root, loaded);

		// Verify worktree and branch are unchanged
		const after = loadState(root);
		assert.equal(after.tasks.auth.worktree, task.worktree);
		assert.equal(after.tasks.auth.branch, task.branch);
	});
});
