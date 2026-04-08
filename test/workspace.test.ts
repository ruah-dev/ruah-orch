import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createWorktreeProvider } from "../src/core/workspace.js";

function tmpGitRepo(): string {
	const dir = join(
		tmpdir(),
		`ruah-workspace-${randomBytes(4).toString("hex")}`,
	);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	mkdirSync(join(dir, ".ruah", "worktrees"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "hello\n", "utf-8");
	execSync('git add . && git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

describe("workspace provider", () => {
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

	it("creates a worktree handle and reports changes", () => {
		const provider = createWorktreeProvider();
		const workspace = provider.create("auth", "main", repo);

		assert.equal(workspace.kind, "worktree");
		assert.ok(existsSync(workspace.root));
		assert.equal(workspace.metadata?.branchName, "ruah/auth");

		writeFileSync(
			join(workspace.root, "README.md"),
			"hello workspace\n",
			"utf-8",
		);

		const changed = provider.changedFiles(workspace, "main", repo);
		assert.deepEqual(changed, ["README.md"]);
		execSync('git add README.md && git commit -m "workspace change"', {
			cwd: workspace.root,
			stdio: "pipe",
		});
		assert.ok(provider.diffStat(workspace, "main", repo).includes("README.md"));
		assert.ok(provider.currentHead(workspace, repo));

		provider.remove(workspace, repo);
		assert.ok(!existsSync(workspace.root));
	});
});
