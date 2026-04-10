import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	executeTask,
	getAvailableExecutors,
	parseClaudeHelpCapabilities,
} from "../src/core/executor.js";

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
		assert.ok(executors.includes("codex-mcp"));
		assert.ok(executors.includes("script"));
		assert.ok(executors.includes("raw"));
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

	it("executeTask streams prefixed debug output", async () => {
		const task = {
			name: "debug-task",
			executor: "script",
			prompt:
				"node -e \"process.stdout.write('hello\\\\n');process.stderr.write('warn\\\\n')\"",
		};
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const originalStdoutWrite = process.stdout.write.bind(process.stdout);
		const originalStderrWrite = process.stderr.write.bind(process.stderr);

		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutChunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;

		try {
			const result = await executeTask(task, dir, {
				debug: true,
				silent: true,
			});
			assert.equal(result.success, true);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}

		assert.ok(
			stdoutChunks.some((chunk) => chunk.includes("Spawn debug-task: node -e")),
		);
		assert.ok(
			stdoutChunks.some((chunk) => chunk.includes("[debug-task stdout] hello")),
		);
		assert.ok(
			stderrChunks.some((chunk) => chunk.includes("[debug-task stderr] warn")),
		);
	});

	it("executeTask rejects unknown executors", async () => {
		const task = { name: "test", executor: "echo", prompt: "hello" };
		const result = await executeTask(task, dir, { silent: true });
		assert.equal(result.success, false);
		assert.ok(result.error?.includes("Unknown executor"));
	});

	it("executeTask supports explicit raw shell execution", async () => {
		const task = { name: "test", executor: "raw", prompt: "echo hello" };
		const result = await executeTask(task, dir, { silent: true });
		assert.equal(result.success, true);
		assert.ok(result.stdout?.includes("hello"));
	});

	it("script executor preserves quoted arguments", async () => {
		const task = {
			name: "quoted",
			executor: "script",
			prompt: `node -e "process.stdout.write(process.argv[1])" "hello world"`,
		};
		const result = await executeTask(task, dir, { silent: true });
		assert.equal(result.success, true);
		assert.equal(result.stdout, "hello world");
	});

	it("codex-mcp adapter falls back to codex CLI when no MCP URL", async () => {
		const original = process.env.CODEX_MCP_URL;
		delete process.env.CODEX_MCP_URL;

		const result = await executeTask(
			{ name: "test", executor: "codex-mcp", prompt: "hello" },
			dir,
			{ dryRun: true },
		);
		assert.ok(result.success);
		assert.ok(result.dryRun);
		assert.ok(result.command?.startsWith("codex"));

		if (original) process.env.CODEX_MCP_URL = original;
	});

	it("codex-mcp adapter uses MCP when URL is configured", async () => {
		process.env.CODEX_MCP_URL = "http://localhost:3100";

		const result = await executeTask(
			{ name: "test", executor: "codex-mcp", prompt: "hello" },
			dir,
			{ dryRun: true },
		);
		assert.ok(result.success);
		assert.ok(result.dryRun);
		assert.ok(result.command?.startsWith("node"));

		delete process.env.CODEX_MCP_URL;
	});

	it("parses Claude CLI help capabilities", () => {
		assert.deepEqual(
			parseClaudeHelpCapabilities(`
  --effort <level>  Effort level
  --model <model>   Model for the current session
`),
			{ model: true, effort: true },
		);
		assert.deepEqual(parseClaudeHelpCapabilities("usage only"), {
			model: false,
			effort: false,
		});
	});

	it("claude-code dry run uses ruah defaults and task file launcher", async () => {
		const result = await executeTask(
			{
				name: "claude-task",
				executor: "claude-code",
				prompt: "Implement auth",
			},
			dir,
			{ dryRun: true },
		);
		assert.ok(result.success);
		assert.ok(result.command?.startsWith("claude --model sonnet --effort low"));
		assert.ok(result.command?.includes("Read .ruah-task.md"));
		assert.ok(
			!result.command?.includes("Implement auth"),
			"expected the CLI prompt to stay small and refer to .ruah-task.md",
		);

		const content = readFileSync(join(dir, ".ruah-task.md"), "utf-8");
		assert.ok(content.includes("Implement auth"));
	});

	it("claude-code dry run respects ruah env overrides", async () => {
		const originalModel = process.env.PITH_RUAH_CLAUDE_MODEL;
		const originalEffort = process.env.PITH_RUAH_CLAUDE_EFFORT;

		process.env.PITH_RUAH_CLAUDE_MODEL = "opus";
		process.env.PITH_RUAH_CLAUDE_EFFORT = "medium";

		try {
			const result = await executeTask(
				{
					name: "claude-task",
					executor: "claude-code",
					prompt: "Implement auth",
				},
				dir,
				{ dryRun: true },
			);
			assert.ok(result.success);
			assert.ok(
				result.command?.startsWith("claude --model opus --effort medium"),
			);
		} finally {
			if (originalModel === undefined) {
				delete process.env.PITH_RUAH_CLAUDE_MODEL;
			} else {
				process.env.PITH_RUAH_CLAUDE_MODEL = originalModel;
			}
			if (originalEffort === undefined) {
				delete process.env.PITH_RUAH_CLAUDE_EFFORT;
			} else {
				process.env.PITH_RUAH_CLAUDE_EFFORT = originalEffort;
			}
		}
	});

	it("executeTask writes contract to .ruah-task.md when provided", async () => {
		const task = {
			name: "contract-task",
			executor: "script",
			prompt: "echo hello",
			contract: {
				taskName: "contract-task",
				owned: ["src/foo.ts"],
				sharedAppend: ["src/index.ts"],
				readOnly: ["src/utils.ts"],
			},
		};
		await executeTask(task, dir, { dryRun: true });
		const content = readFileSync(join(dir, ".ruah-task.md"), "utf-8");
		assert.ok(content.includes("Modification Contract"));
		assert.ok(content.includes("src/foo.ts"));
		assert.ok(content.includes("src/index.ts"));
		assert.ok(content.includes("src/utils.ts"));
		assert.ok(content.includes("Owned Files"));
		assert.ok(content.includes("Read-Only Files"));
	});
});
