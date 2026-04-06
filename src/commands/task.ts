import type { ParsedArgs } from "../cli.js";
import { executeTask } from "../core/executor.js";
import {
	createWorktree,
	getRepoRoot,
	getWorktreeDiff,
	mergeWorktree,
	removeWorktree,
} from "../core/git.js";
import {
	detectCrag,
	readCragGovernance,
	runGates,
} from "../core/integrations.js";
import type { Task } from "../core/state.js";
import {
	acquireLocks,
	addHistoryEntry,
	getChildren,
	getUnmergedChildren,
	loadState,
	releaseLocks,
	saveState,
} from "../core/state.js";
import {
	formatLocks,
	formatTask,
	formatTaskList,
	log,
	logError,
	logInfo,
	logSuccess,
	logWarn,
} from "../utils/format.js";

export async function run(args: ParsedArgs): Promise<void> {
	const sub = args._[1];
	if (!sub) {
		logError(
			"Missing subcommand. Usage: ruah task <create|start|done|merge|list|cancel>",
		);
		process.exit(1);
	}

	const root = getRepoRoot();

	switch (sub) {
		case "create":
			return taskCreate(args, root);
		case "start":
			return taskStart(args, root);
		case "done":
			return taskDone(args, root);
		case "merge":
			return taskMerge(args, root);
		case "list":
			return taskList(args, root);
		case "cancel":
			return taskCancel(args, root);
		case "children":
			return taskChildren(args, root);
		default:
			logError(`Unknown task subcommand: ${sub}`);
			process.exit(1);
	}
}

function taskCreate(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task create <name>");
		process.exit(1);
	}

	const files =
		typeof args.flags.files === "string"
			? args.flags.files.split(",").map((f) => f.trim())
			: [];
	const baseBranch =
		typeof args.flags.base === "string" ? args.flags.base : undefined;
	const executor =
		typeof args.flags.executor === "string" ? args.flags.executor : null;
	const prompt =
		typeof args.flags.prompt === "string" ? args.flags.prompt : null;
	const parentName =
		typeof args.flags.parent === "string"
			? args.flags.parent
			: process.env.RUAH_PARENT_TASK || null;

	const state = loadState(root);

	if (state.tasks[name]) {
		logError(`Task "${name}" already exists`);
		process.exit(1);
	}

	// Resolve base branch: subtasks branch from parent's branch, not base
	let base: string;
	let parentTask: Task | undefined;
	if (parentName) {
		parentTask = state.tasks[parentName];
		if (!parentTask) {
			logError(`Parent task "${parentName}" not found`);
			process.exit(1);
		}
		if (
			parentTask.status !== "in-progress" &&
			parentTask.status !== "created"
		) {
			logError(
				`Parent task "${parentName}" is ${parentTask.status} — can only spawn subtasks from active tasks`,
			);
			process.exit(1);
		}
		base = parentTask.branch;
	} else {
		base = baseBranch || state.baseBranch;
	}

	// Check file locks (subtask locks validated against parent scope)
	if (files.length > 0) {
		const lockResult = acquireLocks(state, name, files, parentName);
		if (!lockResult.success) {
			if (lockResult.outOfScope) {
				logError("Subtask file locks outside parent scope:");
			} else {
				logError("File lock conflict:");
			}
			for (const c of lockResult.conflicts) {
				logWarn(
					`  "${c.requested}" overlaps with "${c.pattern}" (locked by: ${c.task})`,
				);
			}
			process.exit(1);
		}
	}

	// Create worktree
	const { worktreePath, branchName } = createWorktree(name, base, root);

	// Save task
	state.tasks[name] = {
		name,
		status: "created",
		baseBranch: parentName && parentTask ? parentTask.branch : base,
		branch: branchName,
		worktree: worktreePath,
		files,
		executor,
		prompt,
		parent: parentName || null,
		children: [],
		repoRoot: root,
		createdAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		mergedAt: null,
	};

	// Register child on parent
	if (parentName && parentTask) {
		if (!parentTask.children) parentTask.children = [];
		parentTask.children.push(name);
	}

	addHistoryEntry(state, "task.created", {
		task: name,
		parent: parentName || null,
	});
	saveState(root, state);

	logSuccess(`Task "${name}" created`);
	if (parentName) {
		log(`Parent: ${parentName}`);
		log(`Branched from: ${base}`);
	}
	log(`Branch: ${branchName}`);
	log(`Worktree: ${worktreePath}`);
	if (files.length > 0) {
		log(`Locked: ${files.join(", ")}`);
	}
	if (executor) logInfo(`Executor: ${executor}`);
}

async function taskStart(args: ParsedArgs, root: string): Promise<void> {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task start <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status !== "created") {
		logError(`Task "${name}" is ${task.status}, can only start from "created"`);
		process.exit(1);
	}

	task.status = "in-progress";
	task.startedAt = new Date().toISOString();
	addHistoryEntry(state, "task.started", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" started`);

	const noExec = args.flags["no-exec"];
	const dryRun = args.flags["dry-run"];

	if (task.prompt && !noExec) {
		log(`Executing with ${task.executor || "default"}...`);

		const result = await executeTask(task, task.worktree, {
			dryRun: !!dryRun,
		});

		if (dryRun) {
			logInfo(`Would run: ${result.command}`);
			return;
		}

		if (result.success) {
			task.status = "done";
			task.completedAt = new Date().toISOString();
			addHistoryEntry(state, "task.done", { task: name });
			saveState(root, state);
			logSuccess(`Task "${name}" completed successfully`);
		} else {
			task.status = "failed";
			addHistoryEntry(state, "task.failed", {
				task: name,
				error: result.error,
			});
			saveState(root, state);
			logError(
				`Task "${name}" failed: ${result.error || `exit code ${result.exitCode}`}`,
			);
			process.exit(1);
		}
	} else if (!task.prompt) {
		logInfo("No prompt set — task is ready for manual work");
		log(`Worktree: ${task.worktree}`);
	}
}

function taskDone(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task done <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status !== "in-progress") {
		logError(
			`Task "${name}" is ${task.status}, can only mark done from "in-progress"`,
		);
		process.exit(1);
	}

	// Show diff summary
	const diff = getWorktreeDiff(name, task.baseBranch, root);
	if (diff) {
		log("Changes:");
		console.log(diff);
	}

	task.status = "done";
	task.completedAt = new Date().toISOString();
	addHistoryEntry(state, "task.done", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" marked as done`);
}

function taskMerge(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task merge <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status !== "done") {
		logError(`Task "${name}" is ${task.status}, can only merge from "done"`);
		process.exit(1);
	}

	// Block merge if task has unmerged children
	const unmergedChildren = getUnmergedChildren(state, name);
	if (unmergedChildren.length > 0) {
		logError(
			`Cannot merge "${name}" — ${unmergedChildren.length} subtask(s) not yet merged:`,
		);
		for (const child of unmergedChildren) {
			logWarn(`  ${child.name} (${child.status})`);
		}
		logInfo("Merge or cancel all subtasks first.");
		process.exit(1);
	}

	const dryRun = args.flags["dry-run"];
	const skipGates = args.flags["skip-gates"];

	// Determine merge target — subtasks merge into parent branch, not base
	const mergeTarget = task.baseBranch;
	const isSubtask = !!task.parent;

	if (dryRun) {
		const diff = getWorktreeDiff(name, mergeTarget, root);
		log(
			`Dry run — changes that would be merged into ${isSubtask ? `parent (${task.parent})` : mergeTarget}:`,
		);
		console.log(diff || "  (no changes)");
		return;
	}

	// crag gate enforcement (skip for subtasks merging into parent — gates run on parent merge)
	if (!skipGates && !isSubtask) {
		const crag = detectCrag(root);
		if (crag.detected) {
			log("Running crag gates...");
			const governance = readCragGovernance(root);
			if (governance) {
				const gateResult = runGates(governance, task.worktree);
				for (const r of gateResult.results) {
					if (r.success) {
						logSuccess(
							`[${r.classification}] ${r.section || r.command}: passed`,
						);
					} else if (r.classification === "MANDATORY") {
						logError(`[MANDATORY] ${r.section || r.command}: FAILED`);
						logError("Merge blocked. Fix the issue or use --skip-gates");
						process.exit(1);
					} else if (r.classification === "OPTIONAL") {
						logWarn(
							`[OPTIONAL] ${r.section || r.command}: failed (continuing)`,
						);
					} else {
						logInfo(
							`[ADVISORY] ${r.section || r.command}: ${r.success ? "passed" : "failed"}`,
						);
					}
				}
				if (!gateResult.passed) {
					logError("Mandatory gate(s) failed. Merge blocked.");
					process.exit(1);
				}
				logSuccess("All mandatory gates passed");
			}
		}
	} else if (isSubtask && !skipGates) {
		logInfo("Subtask merge — gates deferred to parent merge into base branch");
	} else {
		logWarn("Skipping crag gates (--skip-gates)");
	}

	// Merge — subtasks merge from within the parent's worktree
	const mergeOpts: { parentWorktree?: string } = {};
	if (isSubtask) {
		const parentTask = state.tasks[task.parent!];
		if (parentTask?.worktree) {
			mergeOpts.parentWorktree = parentTask.worktree;
		}
	}
	const result = mergeWorktree(name, mergeTarget, root, mergeOpts);

	if (result.success) {
		task.status = "merged";
		task.mergedAt = new Date().toISOString();
		releaseLocks(state, name);
		addHistoryEntry(state, "task.merged", {
			task: name,
			target: mergeTarget,
			parent: task.parent || null,
		});
		saveState(root, state);

		removeWorktree(name, root);

		if (isSubtask) {
			logSuccess(
				`Subtask "${name}" merged into parent "${task.parent}" (${mergeTarget})`,
			);
		} else {
			logSuccess(`Task "${name}" merged into ${mergeTarget}`);
		}
	} else {
		logError("Merge conflicts detected:");
		for (const f of result.conflicts) {
			logWarn(`  ${f}`);
		}
		logInfo("Resolve conflicts manually, then run: ruah task merge <name>");
	}
}

function taskList(args: ParsedArgs, root: string): void {
	const state = loadState(root);
	const json = args.flags.json;

	if (json) {
		console.log(JSON.stringify(state.tasks, null, 2));
		return;
	}

	// Build tree: show root tasks, then indent children
	const rootTasks = Object.values(state.tasks).filter((t) => !t.parent);
	const childrenOf = (parentName: string): Task[] =>
		Object.values(state.tasks).filter((t) => t.parent === parentName);

	log("Tasks:");
	if (rootTasks.length === 0 && Object.keys(state.tasks).length === 0) {
		console.log(formatTaskList(state.tasks));
	} else {
		for (const task of rootTasks) {
			console.log(formatTask(task));
			const children = childrenOf(task.name);
			for (const child of children) {
				console.log(`  ${formatTask(child)}`);
			}
		}
		// Show orphaned tasks (parent was cancelled/removed)
		const orphans = Object.values(state.tasks).filter(
			(t) => t.parent && !state.tasks[t.parent],
		);
		for (const orphan of orphans) {
			console.log(formatTask(orphan));
		}
	}

	if (Object.keys(state.locks).length > 0) {
		console.log("");
		log("File locks:");
		console.log(formatLocks(state.locks));
	}
}

function taskChildren(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task children <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}

	const json = args.flags.json;
	const children = getChildren(state, name);

	if (json) {
		console.log(JSON.stringify(children, null, 2));
		return;
	}

	if (children.length === 0) {
		log(`Task "${name}" has no subtasks`);
		return;
	}

	log(`Subtasks of "${name}":`);
	for (const child of children) {
		console.log(formatTask(child));
	}
}

function taskCancel(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task cancel <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status === "merged") {
		logError(`Task "${name}" is already merged, cannot cancel`);
		process.exit(1);
	}

	// Cascade cancel to all children
	const children = getChildren(state, name);
	for (const child of children) {
		if (child.status !== "merged" && child.status !== "cancelled") {
			removeWorktree(child.name, root);
			child.status = "cancelled";
			releaseLocks(state, child.name);
			addHistoryEntry(state, "task.cancelled", {
				task: child.name,
				reason: `parent "${name}" cancelled`,
			});
			logWarn(`Subtask "${child.name}" cancelled (parent cancelled)`);
		}
	}

	removeWorktree(name, root);
	releaseLocks(state, name);
	task.status = "cancelled";
	addHistoryEntry(state, "task.cancelled", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" cancelled`);
}
