import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadState, saveState } from "../src/core/state.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-migrate-${randomBytes(4).toString("hex")}`);
	mkdirSync(join(dir, ".ruah"), { recursive: true });
	return dir;
}

describe("state migration", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("migrates legacy v1 state into canonical workspace and claims metadata", () => {
		const legacy = {
			version: 1,
			revision: 0,
			baseBranch: "main",
			tasks: {
				auth: {
					name: "auth",
					status: "created",
					baseBranch: "main",
					branch: "ruah/auth",
					worktree: join(root, ".ruah", "worktrees", "auth"),
					files: ["src/auth/**"],
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
				},
			},
			locks: {
				auth: ["src/auth/**"],
			},
			lockModes: {
				auth: "write",
			},
			lockSnapshots: {},
			history: [],
		};
		writeFileSync(
			join(root, ".ruah", "state.json"),
			`${JSON.stringify(legacy, null, 2)}\n`,
			"utf-8",
		);

		const migrated = loadState(root);
		assert.equal(migrated.version, 2);
		assert.deepEqual(migrated.tasks.auth.claims?.ownedPaths, ["src/auth/**"]);
		assert.equal(
			migrated.tasks.auth.workspace?.root,
			legacy.tasks.auth.worktree,
		);
		assert.equal(
			migrated.tasks.auth.workspace?.metadata?.branchName,
			legacy.tasks.auth.branch,
		);
		assert.deepEqual(migrated.tasks.auth.files, ["src/auth/**"]);
		assert.deepEqual(migrated.artifacts, {});
	});

	it("saveState persists canonical v2 shape while preserving legacy fields", () => {
		const state = loadState(root);
		state.tasks.auth = {
			name: "auth",
			status: "created",
			baseBranch: "main",
			branch: "ruah/auth",
			worktree: join(root, ".ruah", "worktrees", "auth"),
			files: ["src/auth/**"],
			lockMode: "write",
			workspace: {
				id: "auth",
				kind: "worktree",
				root: join(root, ".ruah", "worktrees", "auth"),
				baseRef: "main",
				headRef: "ruah/auth",
				metadata: { branchName: "ruah/auth" },
			},
			claims: {
				ownedPaths: ["src/auth/**"],
				sharedPaths: [],
				readOnlyPaths: [],
			},
			artifact: null,
			integration: {
				status: "unknown",
				conflictsWith: [],
			},
			executor: null,
			prompt: null,
			parent: null,
			children: [],
			depends: [],
			createdAt: new Date().toISOString(),
			startedAt: null,
			completedAt: null,
			mergedAt: null,
		};

		saveState(root, state);
		const raw = JSON.parse(
			readFileSync(join(root, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(raw.version, 2);
		assert.ok(raw.tasks.auth.workspace);
		assert.deepEqual(raw.tasks.auth.claims.ownedPaths, ["src/auth/**"]);
		assert.equal(raw.tasks.auth.branch, "ruah/auth");
		assert.equal(
			raw.tasks.auth.worktree,
			join(root, ".ruah", "worktrees", "auth"),
		);
		assert.deepEqual(raw.tasks.auth.files, ["src/auth/**"]);
		assert.deepEqual(raw.artifacts, {});
	});
});
