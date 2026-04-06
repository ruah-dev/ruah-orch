#!/usr/bin/env node

import { label, logError } from "./utils/format.js";

export interface ParsedArgs {
	_: string[];
	flags: Record<string, string | boolean>;
}

const VERSION = "0.1.0";

const HELP = `
${label()} — multi-agent orchestration

Usage:
  ruah init [--force]
  ruah task <subcommand> [options]
  ruah workflow <subcommand> [options]
  ruah status [--json]

Task subcommands:
  create <name>  Create a task with isolated worktree
    --files <globs>      File patterns to lock (comma-separated)
    --base <branch>      Base branch (default: from state)
    --executor <cmd>     Agent executor (claude-code|aider|codex|open-code|script)
    --prompt <text>      Prompt for the agent
    --parent <task>      Create as subtask (branches from parent)
  start <name>   Start task execution
    --no-exec            Create worktree only, don't run executor
    --dry-run            Show what would be executed
  done <name>    Mark task as complete
  merge <name>   Merge task into base branch
    --dry-run            Show diff without merging
    --skip-gates         Skip crag gate enforcement
  list           List all tasks (shows hierarchy)
    --json               Output as JSON
  children <name> List subtasks of a task
    --json               Output as JSON
  cancel <name>  Cancel and clean up task (cascades to subtasks)

Workflow subcommands:
  run <file.md>  Execute a workflow
    --dry-run            Show plan without executing
    --json               Output as JSON
  plan <file.md> Show execution plan
    --json               Output as JSON
  list           List available workflows
    --json               Output as JSON

Options:
  --help, -h     Show this help
  --version, -v  Show version

crag integration:
  When .claude/governance.md is detected, ruah automatically
  enforces quality gates before merging task branches.
  No configuration needed — just have crag set up.
`;

export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = { _: [], flags: {} };
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) {
				args.flags[key] = true;
			} else {
				args.flags[key] = next;
				i++;
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			args.flags[arg.slice(1)] = true;
		} else {
			args._.push(arg);
		}
		i++;
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.flags.help || args.flags.h) {
		console.log(HELP.trim());
		return;
	}

	if (args.flags.version || args.flags.v) {
		console.log(`ruah ${VERSION}`);
		return;
	}

	const command = args._[0];

	if (!command) {
		console.log(HELP.trim());
		return;
	}

	try {
		switch (command) {
			case "init": {
				const { run } = await import("./commands/init.js");
				await run(args);
				break;
			}
			case "task": {
				const { run } = await import("./commands/task.js");
				await run(args);
				break;
			}
			case "workflow": {
				const { run } = await import("./commands/workflow.js");
				await run(args);
				break;
			}
			case "status": {
				const { run } = await import("./commands/status.js");
				await run(args);
				break;
			}
			default:
				logError(`Unknown command: ${command}`);
				console.log(`Run ${label()} --help for usage`);
				process.exit(1);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		logError(message);
		if (process.env.RUAH_DEBUG) {
			console.error(err instanceof Error ? err.stack : err);
		}
		process.exit(1);
	}
}

main();
