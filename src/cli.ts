#!/usr/bin/env node

import { checkForUpdate, formatUpdateBanner } from "./core/update-notifier.js";
import { label, logError } from "./utils/format.js";
import { VERSION } from "./version.js";

export interface ParsedArgs {
	_: string[];
	flags: Record<string, string | boolean>;
}

const HELP = `
${label()} — multi-agent orchestration

Usage:
  ruah init [--force]
  ruah task <subcommand> [options]
  ruah workflow <subcommand> [options]
  ruah setup [--force]
  ruah clean [--dry-run] [--force]  Clean stale tasks and orphaned locks
  ruah config            Show resolved configuration
  ruah doctor [--json]   Validate git, ruah state, locks, and executors
  ruah status [--json]
  ruah demo [--fast]     Interactive demo — see ruah in action

Task subcommands:
  create <name>  Create a task with isolated worktree
    --files <globs>      File patterns to lock (comma-separated)
    --strict-locks       Reject globs that do not resolve to repo files
    --base <branch>      Base branch (default: from state)
    --executor <cmd>     Agent executor (claude-code|aider|codex|open-code|script)
    --prompt <text>      Prompt for the agent
    --parent <task>      Create as subtask (branches from parent)
  start <name>   Start task execution
    --no-exec            Create worktree only, don't run executor
    --debug-exec         Stream spawned executor output with task prefixes
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
  retry <name>   Retry a failed task (re-execute without recreating worktree)
    --debug-exec         Stream spawned executor output with task prefixes
    --no-exec            Reset status only, don't run executor
    --dry-run            Show what would be executed
  takeover <name> Adopt a created/in-progress/failed task in its existing worktree
    --executor <cmd>     Switch executor for the takeover
    --prompt <text>      Replace the stored prompt before resuming
    --debug-exec         Stream spawned executor output with task prefixes
    --no-exec            Mark as taken over without executing
    --dry-run            Show what would be executed

Workflow subcommands:
  run <file.md>  Execute a workflow
    --debug-exec         Stream spawned executor output with task prefixes
    --strict-locks       Reject ambiguous lock globs before task creation
    --dry-run            Show plan without executing
    --json               Output as JSON
  explain <name|file> Show why a workflow stopped and what to run next
  plan <file.md> Show execution plan
    --json               Output as JSON
  list           List available workflows
    --json               Output as JSON
  create <name>  Create workflow from template
    --force              Overwrite existing workflow

Options:
  --help, -h     Show this help
  --version, -v  Show version

Smart planner:
  When workflows use parallel: true, ruah analyzes file overlaps
  and decides per-stage: parallel, parallel-with-contracts, or serial.
  Agents receive modification contracts in .ruah-task.md specifying
  owned, shared-append, and read-only file boundaries.

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
			case "setup": {
				const { run } = await import("./commands/setup.js");
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
			case "clean": {
				const { run } = await import("./commands/clean.js");
				await run(args);
				break;
			}
			case "config": {
				const { run } = await import("./commands/config.js");
				await run(args);
				break;
			}
			case "doctor": {
				const { run } = await import("./commands/doctor.js");
				await run(args);
				break;
			}
			case "status": {
				const { run } = await import("./commands/status.js");
				await run(args);
				break;
			}
			case "demo": {
				const { run } = await import("./commands/demo.js");
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

	// Non-blocking update check — runs after command completes
	if (!process.env.RUAH_NO_UPDATE_CHECK) {
		checkForUpdate(VERSION)
			.then((info) => {
				if (info) {
					console.error(formatUpdateBanner(info));
				}
			})
			.catch(() => {
				// Silent — never fail on update check
			});
	}
}

main();
