import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildTaskArtifact } from "../src/core/artifact.js";
import {
	compareArtifacts,
	compareArtifactToBase,
} from "../src/core/integration.js";
import { createWorktreeProvider } from "../src/core/workspace.js";

function tmpGitRepo(): string {
	const dir = join(tmpdir(), `ruah-engine-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	mkdirSync(join(dir, ".ruah", "worktrees"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "hello\n", "utf-8");
	writeFileSync(join(dir, "api.txt"), "api\n", "utf-8");
	execSync('git add . && git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

describe("artifact and integration engine", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpGitRepo();
	});

	afterEach(() => {
		try {
			execSync("git worktree prune", { cwd: repo, stdio: "pipe" });
		} catch {}
		rmSync(repo, { recursive: true, force: true });
	});

	it("captures an artifact from a workspace", () => {
		const provider = createWorktreeProvider();
		const workspace = provider.create("artifact-task", "main", repo);

		writeFileSync(
			join(workspace.root, "README.md"),
			"hello artifact\n",
			"utf-8",
		);
		execSync('git add README.md && git commit -m "artifact change"', {
			cwd: workspace.root,
			stdio: "pipe",
		});

		const artifact = buildTaskArtifact(provider, {
			taskName: "artifact-task",
			workspace,
			baseRef: "main",
			repoRoot: repo,
			validation: {
				executorSuccess: true,
				contractSuccess: true,
			},
		});

		assert.equal(artifact.taskName, "artifact-task");
		assert.ok(artifact.changedFiles.includes("README.md"));
		assert.ok(artifact.commitSha);
		assert.ok(artifact.baseRef.length > 0);
	});

	it("detects conflicting artifacts and stale base movement", () => {
		const provider = createWorktreeProvider();
		const left = provider.create("left", "main", repo);
		writeFileSync(join(left.root, "README.md"), "left side\n", "utf-8");
		execSync('git add README.md && git commit -m "left change"', {
			cwd: left.root,
			stdio: "pipe",
		});
		const leftArtifact = buildTaskArtifact(provider, {
			taskName: "left",
			workspace: left,
			baseRef: "main",
			repoRoot: repo,
			validation: {
				executorSuccess: true,
				contractSuccess: true,
			},
		});

		const right = provider.create("right", "main", repo);
		writeFileSync(join(right.root, "README.md"), "right side\n", "utf-8");
		execSync('git add README.md && git commit -m "right change"', {
			cwd: right.root,
			stdio: "pipe",
		});
		const rightArtifact = buildTaskArtifact(provider, {
			taskName: "right",
			workspace: right,
			baseRef: "main",
			repoRoot: repo,
			validation: {
				executorSuccess: true,
				contractSuccess: true,
			},
		});

		const pairCompatibility = compareArtifacts(
			leftArtifact,
			rightArtifact,
			repo,
		);
		assert.equal(pairCompatibility.clean, false);

		writeFileSync(join(repo, "api.txt"), "api changed on base\n", "utf-8");
		execSync('git add api.txt && git commit -m "base change"', {
			cwd: repo,
			stdio: "pipe",
		});

		const baseCompatibility = compareArtifactToBase(leftArtifact, "main", repo);
		assert.equal(baseCompatibility.staleBase, true);
	});
});
