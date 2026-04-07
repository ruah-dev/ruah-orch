import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		assert.equal(loaded.revision, 1);
	});

	it("saveState rejects stale writes", () => {
		const first = loadState(root);
		const stale = loadState(root);

		first.baseBranch = "develop";
		saveState(root, first);

		stale.baseBranch = "feature";
		assert.throws(() => saveState(root, stale), /state changed on disk/i);
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
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("acquireLocks succeeds with no conflicts", () => {
		const state = {
			locks: {},
			lockModes: {},
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(state, "auth", ["src/auth/**"]);
		assert.ok(result.success);
		assert.deepEqual(state.locks.auth, ["src/auth/**"]);
	});

	it("acquireLocks detects overlapping patterns", () => {
		const state = {
			locks: { auth: ["src/auth/**"] },
			lockModes: { auth: "write" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(state, "api", ["src/auth/**"]);
		assert.ok(!result.success);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0].task, "auth");
	});

	it("acquireLocks allows non-overlapping patterns", () => {
		const state = {
			locks: { auth: ["src/auth/**"] },
			lockModes: { auth: "write" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(state, "api", ["src/api/**"]);
		assert.ok(result.success);
	});

	it("acquireLocks succeeds with empty patterns", () => {
		const state = {
			locks: { auth: ["src/auth/**"] },
			lockModes: { auth: "write" },
			lockSnapshots: {},
		} as unknown as RuahState;
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

	it("strict locks reject unresolved glob patterns", () => {
		const state = {
			locks: {},
			lockModes: {},
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"auth",
			["src/auth/**"],
			null,
			root,
			true,
		);
		assert.equal(result.success, false);
		assert.equal(result.ambiguous, true);
	});

	it("stores resolved lock snapshots", () => {
		execSync("git init -b main", { cwd: root, stdio: "pipe" });
		writeFileSync(join(root, "auth.ts"), "export const a = 1;\n", "utf-8");

		const state = {
			locks: {},
			lockModes: {},
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(state, "auth", ["*.ts"], null, root);
		assert.equal(result.success, true);
		assert.deepEqual(state.lockSnapshots.auth["*.ts"], ["auth.ts"]);
	});
});

describe("patternsOverlap", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

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

	it("uses repo files to reject disjoint glob patterns in the same directory", () => {
		execSync("git init -b main", { cwd: root, stdio: "pipe" });
		writeFileSync(join(root, "login.ts"), "export const a = 1;\n", "utf-8");
		writeFileSync(join(root, "login.js"), "module.exports = 1;\n", "utf-8");

		assert.equal(patternsOverlap("*.ts", "*.js", root), false);
	});
});

describe("read-only locks", () => {
	it("read-only locks never conflict with write locks", () => {
		const state = {
			locks: { writer: ["src/auth/**"] },
			lockModes: { writer: "write" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"reader",
			["src/auth/**"],
			null,
			undefined,
			false,
			"read",
		);
		assert.ok(result.success);
	});

	it("read-only locks never conflict with other read-only locks", () => {
		const state = {
			locks: { reader1: ["src/**"] },
			lockModes: { reader1: "read" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"reader2",
			["src/**"],
			null,
			undefined,
			false,
			"read",
		);
		assert.ok(result.success);
	});

	it("write locks do not conflict with existing read-only locks", () => {
		const state = {
			locks: { reader: ["src/auth/**"] },
			lockModes: { reader: "read" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"writer",
			["src/auth/**"],
			null,
			undefined,
			false,
			"write",
		);
		assert.ok(result.success);
	});

	it("write locks still conflict with other write locks", () => {
		const state = {
			locks: { writer1: ["src/auth/**"] },
			lockModes: { writer1: "write" },
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"writer2",
			["src/auth/**"],
			null,
			undefined,
			false,
			"write",
		);
		assert.ok(!result.success);
		assert.equal(result.conflicts.length, 1);
	});

	it("lockModes defaults to write when absent (backward compat)", () => {
		const state = {
			locks: { legacy: ["src/**"] },
			lockModes: {},
			lockSnapshots: {},
		} as unknown as RuahState;
		const result = acquireLocks(
			state,
			"new-writer",
			["src/**"],
			null,
			undefined,
			false,
			"write",
		);
		assert.ok(!result.success);
	});

	it("releaseLocks cleans up lockModes", () => {
		const state = {
			locks: { task: ["src/**"] },
			lockModes: { task: "read" },
			lockSnapshots: {},
		} as unknown as RuahState;
		releaseLocks(state, "task");
		assert.equal(state.lockModes.task, undefined);
	});

	it("multiple read-only tasks on same files all succeed", () => {
		const state = {
			locks: {},
			lockModes: {},
			lockSnapshots: {},
		} as unknown as RuahState;
		for (let i = 0; i < 5; i++) {
			const result = acquireLocks(
				state,
				`audit-${i}`,
				["src/**"],
				null,
				undefined,
				false,
				"read",
			);
			assert.ok(result.success, `audit-${i} should succeed`);
		}
		assert.equal(Object.keys(state.locks).length, 5);
	});
});

describe("subtask state functions", () => {
	it("acquireLocks validates subtask within parent scope", () => {
		const state = {
			locks: { parent: ["src/auth/**"] },
			lockModes: { parent: "write" },
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
		const state = { locks: {}, lockModes: {} } as unknown as RuahState;
		const result = acquireLocks(state, "child", ["src/anything/**"], "parent");
		assert.ok(result.success);
	});

	it("subtask does not conflict with parent locks", () => {
		const state = {
			locks: { parent: ["src/**"] },
			lockModes: { parent: "write" },
		} as unknown as RuahState;
		// Subtask within parent's scope should not conflict with parent
		const result = acquireLocks(state, "child", ["src/auth/**"], "parent");
		assert.ok(result.success);
	});

	it("sibling subtasks can conflict", () => {
		const state = {
			locks: { parent: ["src/**"], child1: ["src/auth/**"] },
			lockModes: { parent: "write", child1: "write" },
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
