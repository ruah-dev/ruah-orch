import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	branchExists,
	createWorktree,
	getCurrentBranch,
	getRepoRoot,
	isGitRepo,
	listWorktrees,
	removeWorktree,
	sanitizeName,
} from "../src/core/git.js";

function tmpGitRepo(): string {
	const dir = join(tmpdir(), `ruah-git-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "hello", "utf-8");
	execSync('git add . && git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

describe("git", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpGitRepo();
	});

	afterEach(() => {
		// Clean up worktrees before removing the repo
		try {
			execSync("git worktree prune", { cwd: repo, stdio: "pipe" });
		} catch {
			/* ignore */
		}
		rmSync(repo, { recursive: true, force: true });
	});

	it("isGitRepo returns true for a git repo", () => {
		assert.ok(isGitRepo(repo));
	});

	it("isGitRepo returns false for non-repo", () => {
		const dir = join(tmpdir(), `ruah-nogit-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
		assert.ok(!isGitRepo(dir));
		rmSync(dir, { recursive: true, force: true });
	});

	it("getCurrentBranch returns main or master", () => {
		const branch = getCurrentBranch(repo);
		assert.ok(branch === "main" || branch === "master");
	});

	it("getRepoRoot returns correct path", () => {
		const root = getRepoRoot(repo);
		assert.ok(root.includes("ruah-git"));
	});

	it("branchExists returns false for nonexistent branch", () => {
		assert.ok(!branchExists("nonexistent", repo));
	});

	it("sanitizeName replaces special chars", () => {
		assert.equal(sanitizeName("my task!@#"), "my_task___");
		assert.equal(sanitizeName("normal-name"), "normal-name");
		assert.equal(sanitizeName("with.dots"), "with.dots");
	});

	it("createWorktree creates worktree and branch", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		const result = createWorktree("test-task", branch, repo);
		assert.ok(result.worktreePath.includes("test-task"));
		assert.equal(result.branchName, "ruah/test-task");
		assert.ok(branchExists("ruah/test-task", repo));
	});

	it("removeWorktree cleans up", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		createWorktree("cleanup", branch, repo);
		removeWorktree("cleanup", repo);
		assert.ok(!branchExists("ruah/cleanup", repo));
	});

	it("listWorktrees returns ruah worktrees", () => {
		mkdirSync(join(repo, ".ruah", "worktrees"), { recursive: true });
		const branch = getCurrentBranch(repo);
		createWorktree("wt-test", branch, repo);
		const wts = listWorktrees(repo);
		assert.ok(wts.length >= 1);
		assert.ok(wts.some((w) => w.branch?.includes("ruah/wt-test")));
	});
});
