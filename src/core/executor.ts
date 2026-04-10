import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo } from "../utils/format.js";
import { autoCommitChanges } from "./git.js";
import type { FileContract } from "./planner.js";
import { renderContractMarkdown } from "./planner.js";

interface AdapterResult {
	command: string;
	args: string[];
	shell?: boolean;
}

export interface RuahClaudeProfile {
	model: string;
	effort: string;
	taskPromptFile: string;
}

export interface ClaudeCliCapabilities {
	model: boolean;
	effort: boolean;
}

export interface TaskDef {
	name: string;
	executor?: string | null;
	prompt?: string | null;
	parent?: string | null;
	files?: string[];
	repoRoot?: string;
	contract?: FileContract | null;
}

export interface ExecuteOptions {
	dryRun?: boolean;
	silent?: boolean;
	debug?: boolean;
}

export interface ExecuteResult {
	success: boolean;
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	error?: string | null;
	command?: string;
	dryRun?: boolean;
	autoCommitted?: boolean;
}

function isExecutionDebugEnabled(opts: ExecuteOptions): boolean {
	if (opts.debug === true) return true;
	const flag = process.env.RUAH_DEBUG?.trim().toLowerCase();
	return flag === "1" || flag === "true" || flag === "yes";
}

function formatCommandPart(part: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part);
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(formatCommandPart).join(" ");
}

function createPrefixedWriter(
	prefix: string,
	write: (chunk: string) => boolean,
): {
	push: (chunk: Buffer | string) => void;
	flush: () => void;
} {
	let buffer = "";

	function emitLine(line: string): void {
		write(`${prefix}${line}\n`);
	}

	return {
		push(chunk) {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				emitLine(buffer.slice(0, newlineIndex));
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush() {
			if (!buffer) return;
			emitLine(buffer);
			buffer = "";
		},
	};
}

function parseCommandLine(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (quote) {
		throw new Error(`Unterminated ${quote} quote in script command`);
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

function generateMcpScript(prompt: string, mcpUrl: string): string {
	// Use JSON.stringify to safely embed the prompt and URL — no shell injection
	return `
import { request } from "node:http";
const mcpUrl = new URL(${JSON.stringify(mcpUrl)});
const prompt = ${JSON.stringify(prompt)};
const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "execute", arguments: { prompt, workdir: process.cwd() } }
});
const req = request({
    hostname: mcpUrl.hostname,
    port: mcpUrl.port,
    path: mcpUrl.pathname,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    timeout: 300000
}, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
        try {
            const r = JSON.parse(body);
            if (r.error) { console.error("MCP error:", r.error.message); process.exit(1); }
            console.log(JSON.stringify(r.result, null, 2));
        } catch { console.error("Invalid MCP response"); process.exit(1); }
    });
});
req.on("error", (e) => { console.error("MCP connection failed:", e.message); process.exit(1); });
req.write(payload);
req.end();
`;
}

/**
 * Keep the CLI prompt small for ruah fan-out workers and point Claude at the
 * task file that already contains the full instructions and coordination data.
 */
const RUAH_TASK_PROMPT_FILE = ".ruah-task.md";
const DEFAULT_RUAH_CLAUDE_MODEL = "sonnet";
const DEFAULT_RUAH_CLAUDE_EFFORT = "low";
let cachedClaudeCliCapabilities: ClaudeCliCapabilities | null = null;

function readNonEmptyEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

export function getRuahClaudeProfile(): RuahClaudeProfile {
	return {
		model:
			readNonEmptyEnv("PITH_RUAH_CLAUDE_MODEL") || DEFAULT_RUAH_CLAUDE_MODEL,
		effort:
			readNonEmptyEnv("PITH_RUAH_CLAUDE_EFFORT") || DEFAULT_RUAH_CLAUDE_EFFORT,
		taskPromptFile: RUAH_TASK_PROMPT_FILE,
	};
}

export function parseClaudeHelpCapabilities(
	helpText: string,
): ClaudeCliCapabilities {
	return {
		model: helpText.includes("--model <model>"),
		effort: helpText.includes("--effort <level>"),
	};
}

function getClaudeCliCapabilities(): ClaudeCliCapabilities {
	if (cachedClaudeCliCapabilities) {
		return cachedClaudeCliCapabilities;
	}

	try {
		const result = spawnSync("claude", ["--help"], {
			encoding: "utf-8",
			stdio: "pipe",
		});
		const output = `${result.stdout || ""}\n${result.stderr || ""}`;
		cachedClaudeCliCapabilities = parseClaudeHelpCapabilities(output);
	} catch {
		cachedClaudeCliCapabilities = { model: false, effort: false };
	}

	return cachedClaudeCliCapabilities;
}

function buildRuahClaudePrompt(taskName: string): string {
	return [
		`Read ${RUAH_TASK_PROMPT_FILE} in the current directory for the full task instructions.`,
		"Stay within the declared file scope and modification contract.",
		`When you are finished, commit all changes before exiting with: git add -A && git commit -m "ruah(${taskName}): completed task"`,
		"Do not leave uncommitted changes behind.",
	].join("\n");
}

function buildClaudeCodeArgs(taskName: string): string[] {
	const profile = getRuahClaudeProfile();
	const capabilities = getClaudeCliCapabilities();
	const args: string[] = [];

	if (capabilities.model) {
		args.push("--model", profile.model);
	}
	if (capabilities.effort) {
		args.push("--effort", profile.effort);
	}

	args.push(
		"-p",
		buildRuahClaudePrompt(taskName),
		"--dangerously-skip-permissions",
	);

	return args;
}

const ADAPTERS: Record<
	string,
	(prompt: string, taskName?: string) => AdapterResult
> = {
	"claude-code": (_prompt, taskName) => ({
		command: "claude",
		args: buildClaudeCodeArgs(taskName || "task"),
	}),
	aider: (prompt) => ({
		command: "aider",
		args: ["--message", prompt, "--yes-always", "--no-git"],
	}),
	codex: (prompt) => ({
		command: "codex",
		args: [prompt],
	}),
	"codex-mcp": (prompt) => {
		if (process.env.CODEX_MCP_URL) {
			return {
				command: "node",
				args: [
					"--input-type=module",
					"-e",
					generateMcpScript(prompt, process.env.CODEX_MCP_URL),
				],
			};
		}
		// Fallback: regular codex CLI when MCP server is not configured
		return {
			command: "codex",
			args: [prompt],
		};
	},
	"open-code": (prompt) => ({
		command: "opencode",
		args: ["-p", prompt],
	}),
	raw: (prompt) => ({
		command: process.platform === "win32" ? "cmd" : "sh",
		args:
			process.platform === "win32"
				? ["/d", "/s", "/c", prompt]
				: ["-c", prompt],
		shell: false,
	}),
	script: (prompt) => {
		const parts = parseCommandLine(prompt);
		if (parts.length === 0) {
			throw new Error("Script executor requires a non-empty command line");
		}
		return {
			command: parts[0],
			args: parts.slice(1),
		};
	},
};

export function getAvailableExecutors(): string[] {
	return Object.keys(ADAPTERS);
}

export function executeTask(
	taskDef: TaskDef,
	worktreePath: string,
	opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
	const { dryRun, silent } = opts;
	const prompt = taskDef.prompt || "";
	const executorName = taskDef.executor || "script";
	const debugEnabled = isExecutionDebugEnabled(opts);

	// Resolve adapter
	const adapter = ADAPTERS[executorName];
	let cmd: string;
	let args: string[];
	let useShell = process.platform === "win32";

	if (adapter) {
		let resolved: AdapterResult;
		try {
			resolved = adapter(prompt, taskDef.name);
		} catch (err: unknown) {
			return Promise.resolve({
				success: false,
				exitCode: null,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		cmd = resolved.command;
		args = resolved.args;
		useShell = resolved.shell ?? process.platform === "win32";
	} else {
		return Promise.resolve({
			success: false,
			exitCode: null,
			error: `Unknown executor: ${executorName}. Use a supported executor, "script", or explicit "raw".`,
		});
	}
	const renderedCommand = formatCommand(cmd, args);

	// Write task file with context and subagent instructions
	const taskFile = join(worktreePath, ".ruah-task.md");
	const parentInfo = taskDef.parent
		? `\n## Parent Task\n- Parent: ${taskDef.parent}\n- This is a subtask — merges into parent branch, not base.\n`
		: "";
	const filesInfo =
		taskDef.files && taskDef.files.length > 0
			? `\n## File Scope\n- Locked files: ${taskDef.files.join(", ")}\n`
			: "";
	const contractInfo = taskDef.contract
		? `\n${renderContractMarkdown(taskDef.contract)}\n`
		: "";
	const subagentGuide = `
## Spawning Subtasks

You can split work into subtasks. Each subtask gets its own worktree.

\`\`\`bash
# Create a subtask (inherits your worktree as base)
ruah task create <name> --parent ${taskDef.name} --files "src/sub/**" --executor <cli> --prompt "..."

# Start it
ruah task start <name>

# When subtask is done
ruah task done <name>
ruah task merge <name>   # merges into YOUR branch, not base
\`\`\`

Available executors: claude-code, aider, codex, codex-mcp, open-code, script

Environment variables available:
- RUAH_TASK=${taskDef.name}
- RUAH_WORKTREE=${worktreePath}
- RUAH_EXECUTOR=${executorName}${taskDef.parent ? `\n- RUAH_PARENT_TASK=${taskDef.parent}` : ""}${taskDef.repoRoot ? `\n- RUAH_ROOT=${taskDef.repoRoot}` : ""}${taskDef.files && taskDef.files.length > 0 ? `\n- RUAH_FILES=${taskDef.files.join(",")}` : ""}
`;
	writeFileSync(
		taskFile,
		`# Task: ${taskDef.name}\n\n${prompt}\n${parentInfo}${filesInfo}${contractInfo}${subagentGuide}`,
		"utf-8",
	);

	if (dryRun) {
		return Promise.resolve({
			success: true,
			command: renderedCommand,
			dryRun: true,
		});
	}

	return new Promise((resolve) => {
		const taskEnv: Record<string, string> = {
			...process.env,
			RUAH_TASK: taskDef.name,
			RUAH_WORKTREE: worktreePath,
			RUAH_EXECUTOR: executorName,
		} as Record<string, string>;

		// Subagent context: pass parent info + repo root so spawned CLIs
		// can call `ruah task create --parent $RUAH_TASK` from within execution
		if (taskDef.parent) {
			taskEnv.RUAH_PARENT_TASK = taskDef.parent;
		}
		if (taskDef.repoRoot) {
			taskEnv.RUAH_ROOT = taskDef.repoRoot;
		}
		// Pass file lock scope so agents know their boundaries
		if (taskDef.files && taskDef.files.length > 0) {
			taskEnv.RUAH_FILES = taskDef.files.join(",");
		}

		if (debugEnabled) {
			logInfo(`Spawn ${taskDef.name}: ${renderedCommand}`);
			logInfo(`Worktree ${taskDef.name}: ${worktreePath}`);
		}

		const captureOutput = silent || debugEnabled;

		const child = spawn(cmd, args, {
			cwd: worktreePath,
			env: taskEnv,
			stdio: captureOutput ? "pipe" : "inherit",
			shell: useShell,
		});

		let stdout = "";
		let stderr = "";
		const stdoutWriter = debugEnabled
			? createPrefixedWriter(
					`[${taskDef.name} stdout] `,
					process.stdout.write.bind(process.stdout),
				)
			: null;
		const stderrWriter = debugEnabled
			? createPrefixedWriter(
					`[${taskDef.name} stderr] `,
					process.stderr.write.bind(process.stderr),
				)
			: null;

		child.on("spawn", () => {
			if (debugEnabled) {
				logInfo(`PID ${taskDef.name}: ${child.pid ?? "unknown"}`);
			}
		});

		if (captureOutput && child.stdout) {
			child.stdout.on("data", (data: Buffer) => {
				stdout += data;
				stdoutWriter?.push(data);
			});
		}
		if (captureOutput && child.stderr) {
			child.stderr.on("data", (data: Buffer) => {
				stderr += data;
				stderrWriter?.push(data);
			});
		}

		child.on("error", (err) => {
			stdoutWriter?.flush();
			stderrWriter?.flush();
			// Try to salvage any work done before the error
			let autoCommitted = false;
			try {
				autoCommitted = autoCommitChanges(taskDef.name, worktreePath);
			} catch {
				// Non-fatal
			}
			if (debugEnabled) {
				logInfo(`Spawn error ${taskDef.name}: ${err.message}`);
			}

			resolve({
				success: false,
				exitCode: null,
				stdout,
				stderr,
				error: err.message,
				autoCommitted,
			});
		});

		child.on("close", (code) => {
			stdoutWriter?.flush();
			stderrWriter?.flush();
			// Safety net: auto-commit any uncommitted changes left by the executor.
			// This prevents lost work when agents forget to commit or crash mid-task.
			let autoCommitted = false;
			try {
				autoCommitted = autoCommitChanges(taskDef.name, worktreePath);
				if (autoCommitted) {
					stderr += "\n[ruah] Auto-committed uncommitted changes\n";
				}
			} catch {
				// Non-fatal — best effort
			}
			if (debugEnabled) {
				logInfo(`Exit ${taskDef.name}: ${code ?? "null"}`);
			}

			resolve({
				success: code === 0,
				exitCode: code,
				stdout,
				stderr,
				error: code !== 0 ? `Process exited with code ${code}` : null,
				autoCommitted,
			});
		});
	});
}
