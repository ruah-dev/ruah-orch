import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RuahState } from "../src/core/state.js";
import {
	acquireLocks,
	addHistoryEntry,
	ensureStateDir,
	getChildren,
	getTaskLineage,
	getUnmergedChildren,
	loadState,
	patternsOverlap,
	releaseLocks,
	saveState,
} from "../src/core/state.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-test-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("state", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("loadState returns default when no file exists", () => {
		const state = loadState(root);
		assert.equal(state.version, 1);
		assert.equal(state.baseBranch, "main");
		assert.deepEqual(state.tasks, {});
		assert.deepEqual(state.locks, {});
		assert.deepEqual(state.history, []);
	});

	it("saveState writes valid JSON and loadState reads it back", () => {
		const state = loadState(root);
		state.baseBranch = "develop";
		state.tasks.foo = {
			name: "foo",
			status: "created",
		} as RuahState["tasks"][string];
		saveState(root, state);

		const loaded = loadState(root);
		assert.equal(loaded.baseBranch, "develop");
		assert.equal(loaded.tasks.foo.name, "foo");
	});

	it("ensureStateDir creates .ruah directory structure", () => {
		ensureStateDir(root);
		assert.ok(existsSync(join(root, ".ruah")));
		assert.ok(existsSync(join(root, ".ruah", "worktrees")));
		assert.ok(existsSync(join(root, ".ruah", "workflows")));
	});

	it("addHistoryEntry appends entries", () => {
		const state = loadState(root);
		addHistoryEntry(state, "task.created", { task: "auth" });
		assert.equal(state.history.length, 1);
		assert.equal(state.history[0].action, "task.created");
		assert.equal(state.history[0].task, "auth");
		assert.ok(state.history[0].timestamp);
	});

	it("addHistoryEntry caps at 200 entries", () => {
		const state = loadState(root);
		for (let i = 0; i < 250; i++) {
			addHistoryEntry(state, `action.${i}`, { i });
		}
		assert.equal(state.history.length, 200);
		// Should keep the most recent
		assert.equal(state.history[199].action, "action.249");
	});
});

describe("file locks", () => {
	it("acquireLocks succeeds with no conflicts", () => {
		const state = { locks: {} } as unknown as RuahState;
		const result = acquireLocks(state, "auth", ["src/auth/**"]);
		assert.ok(result.success);
		assert.deepEqual(state.locks.auth, ["src/auth/**"]);
	});

	it("acquireLocks detects overlapping patterns", () => {
		const state = { locks: { auth: ["src/auth/**"] } } as unknown as RuahState;
		const result = acquireLocks(state, "api", ["src/auth/**"]);
		assert.ok(!result.success);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0].task, "auth");
	});

	it("acquireLocks allows non-overlapping patterns", () => {
		const state = { locks: { auth: ["src/auth/**"] } } as unknown as RuahState;
		const result = acquireLocks(state, "api", ["src/api/**"]);
		assert.ok(result.success);
	});

	it("acquireLocks succeeds with empty patterns", () => {
		const state = { locks: { auth: ["src/auth/**"] } } as unknown as RuahState;
		const result = acquireLocks(state, "api", []);
		assert.ok(result.success);
	});

	it("releaseLocks removes lock entry", () => {
		const state = {
			locks: { auth: ["src/auth/**"], api: ["src/api/**"] },
		} as unknown as RuahState;
		releaseLocks(state, "auth");
		assert.ok(!state.locks.auth);
		assert.ok(state.locks.api);
	});
});

describe("patternsOverlap", () => {
	it("exact match", () => {
		assert.ok(patternsOverlap("src/auth/**", "src/auth/**"));
	});

	it("one is prefix of another with **", () => {
		assert.ok(patternsOverlap("src/**", "src/auth/**"));
		assert.ok(patternsOverlap("src/auth/**", "src/**"));
	});

	it("non-overlapping directories", () => {
		assert.ok(!patternsOverlap("src/auth/**", "src/api/**"));
	});

	it("specific file vs directory glob", () => {
		assert.ok(patternsOverlap("src/auth/**", "src/auth/login.js"));
	});

	it("completely different paths", () => {
		assert.ok(!patternsOverlap("src/auth/**", "tests/api/**"));
	});

	it("same string", () => {
		assert.ok(patternsOverlap("src/file.js", "src/file.js"));
	});
});

describe("subtask state functions", () => {
	it("acquireLocks validates subtask within parent scope", () => {
		const state = {
			locks: { parent: ["src/auth/**"] },
		} as unknown as RuahState;
		// Within scope — should succeed
		const ok = acquireLocks(state, "child", ["src/auth/api/**"], "parent");
		assert.ok(ok.success);

		// Outside scope — should fail
		const fail = acquireLocks(state, "child2", ["lib/**"], "parent");
		assert.ok(!fail.success);
		assert.ok(fail.outOfScope);
	});

	it("acquireLocks allows subtask when parent has no locks", () => {
		const state = { locks: {} } as unknown as RuahState;
		const result = acquireLocks(state, "child", ["src/anything/**"], "parent");
		assert.ok(result.success);
	});

	it("subtask does not conflict with parent locks", () => {
		const state = { locks: { parent: ["src/**"] } } as unknown as RuahState;
		// Subtask within parent's scope should not conflict with parent
		const result = acquireLocks(state, "child", ["src/auth/**"], "parent");
		assert.ok(result.success);
	});

	it("sibling subtasks can conflict", () => {
		const state = {
			locks: { parent: ["src/**"], child1: ["src/auth/**"] },
		} as unknown as RuahState;
		const result = acquireLocks(state, "child2", ["src/auth/**"], "parent");
		assert.ok(!result.success);
	});

	it("getChildren returns only direct children", () => {
		const state = {
			tasks: {
				root: { name: "root", parent: null },
				child1: { name: "child1", parent: "root" },
				child2: { name: "child2", parent: "root" },
				grandchild: { name: "grandchild", parent: "child1" },
				unrelated: { name: "unrelated", parent: null },
			},
		} as unknown as RuahState;
		const children = getChildren(state, "root");
		assert.equal(children.length, 2);
		assert.ok(children.some((c) => c.name === "child1"));
		assert.ok(children.some((c) => c.name === "child2"));
	});

	it("getUnmergedChildren excludes merged and cancelled", () => {
		const state = {
			tasks: {
				root: { name: "root", parent: null },
				a: { name: "a", parent: "root", status: "merged" },
				b: { name: "b", parent: "root", status: "in-progress" },
				c: { name: "c", parent: "root", status: "cancelled" },
			},
		} as unknown as RuahState;
		const unmerged = getUnmergedChildren(state, "root");
		assert.equal(unmerged.length, 1);
		assert.equal(unmerged[0].name, "b");
	});

	it("getTaskLineage returns full ancestry", () => {
		const state = {
			tasks: {
				root: { name: "root", parent: null },
				mid: { name: "mid", parent: "root" },
				leaf: { name: "leaf", parent: "mid" },
			},
		} as unknown as RuahState;
		const lineage = getTaskLineage(state, "leaf");
		assert.deepStrictEqual(lineage, ["root", "mid", "leaf"]);
	});
});
