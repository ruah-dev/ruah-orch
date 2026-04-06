import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileContract } from "./planner.js";
import { renderContractMarkdown } from "./planner.js";

interface AdapterResult {
	command: string;
	args: string[];
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
}

export interface ExecuteResult {
	success: boolean;
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	error?: string | null;
	command?: string;
	dryRun?: boolean;
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

const ADAPTERS: Record<string, (prompt: string) => AdapterResult> = {
	"claude-code": (prompt) => ({
		command: "claude",
		args: ["-p", prompt, "--dangerously-skip-permissions"],
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
	script: (prompt) => {
		const parts = prompt.split(/\s+/);
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

	// Resolve adapter
	const adapter = ADAPTERS[executorName];
	let cmd: string;
	let args: string[];

	if (adapter) {
		const resolved = adapter(prompt);
		cmd = resolved.command;
		args = resolved.args;
	} else {
		// Unknown executor: treat as raw command
		const parts = executorName.split(/\s+/);
		cmd = parts[0];
		args = [...parts.slice(1), prompt].filter(Boolean);
	}

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
			command: `${cmd} ${args.join(" ")}`,
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

		const child = spawn(cmd, args, {
			cwd: worktreePath,
			env: taskEnv,
			stdio: silent ? "pipe" : "inherit",
			shell: process.platform === "win32",
		});

		let stdout = "";
		let stderr = "";

		if (silent && child.stdout) {
			child.stdout.on("data", (data: Buffer) => {
				stdout += data;
			});
		}
		if (silent && child.stderr) {
			child.stderr.on("data", (data: Buffer) => {
				stderr += data;
			});
		}

		child.on("error", (err) => {
			resolve({
				success: false,
				exitCode: null,
				stdout,
				stderr,
				error: err.message,
			});
		});

		child.on("close", (code) => {
			resolve({
				success: code === 0,
				exitCode: code,
				stdout,
				stderr,
				error: code !== 0 ? `Process exited with code ${code}` : null,
			});
		});
	});
}
