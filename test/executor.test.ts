import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeTask, getAvailableExecutors } from "../src/core/executor.js";

function tmpDir(): string {
	const dir = join(tmpdir(), `ruah-exec-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("executor", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpDir();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("getAvailableExecutors returns known adapters", () => {
		const executors = getAvailableExecutors();
		assert.ok(executors.includes("claude-code"));
		assert.ok(executors.includes("aider"));
		assert.ok(executors.includes("codex"));
		assert.ok(executors.includes("script"));
	});

	it("executeTask dry run returns command without executing", async () => {
		const task = { name: "test", executor: "script", prompt: "echo hello" };
		const result = await executeTask(task, dir, { dryRun: true });
		assert.ok(result.success);
		assert.ok(result.dryRun);
		assert.ok(result.command?.includes("echo"));
	});

	it("executeTask writes .ruah-task.md", async () => {
		const task = {
			name: "test-task",
			executor: "script",
			prompt: "echo hello",
		};
		await executeTask(task, dir, { dryRun: true });
		assert.ok(existsSync(join(dir, ".ruah-task.md")));
	});

	it("executeTask runs script executor successfully", async () => {
		const task = { name: "test", executor: "script", prompt: "echo hello" };
		const result = await executeTask(task, dir, { silent: true });
		assert.ok(result.success);
		assert.equal(result.exitCode, 0);
	});

	it("executeTask captures failure", async () => {
		const task = { name: "test", executor: "script", prompt: "false" };
		const result = await executeTask(task, dir, { silent: true });
		assert.ok(!result.success);
		assert.notEqual(result.exitCode, 0);
	});

	it("executeTask handles unknown executor as raw command", async () => {
		const task = { name: "test", executor: "echo", prompt: "hello" };
		const result = await executeTask(task, dir, { silent: true });
		assert.ok(result.success);
	});
});
