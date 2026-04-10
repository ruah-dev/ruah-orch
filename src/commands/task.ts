import type { ParsedArgs } from "../cli.js";
import { buildTaskArtifact } from "../core/artifact.js";
import { claimSetFromFiles } from "../core/claims.js";
import { loadConfig } from "../core/config.js";
import { executeTask } from "../core/executor.js";
import { getRepoRoot } from "../core/git.js";
import { compareArtifactToBase } from "../core/integration.js";
import {
	detectGovernance,
	readGovernance,
	runGates,
} from "../core/integrations.js";
import type { Task } from "../core/state.js";
import {
	acquireLocks,
	addHistoryEntry,
	getChildren,
	getClaimableTasks,
	getUnmergedChildren,
	isTaskClaimable,
	loadState,
	type RuahState,
	releaseLocks,
	removeTask,
	saveState,
} from "../core/state.js";
import {
	getWorkspaceProvider,
	type WorkspaceHandle,
} from "../core/workspace.js";
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

function taskWorkspace(task: Task): WorkspaceHandle {
	if (task.workspace) return task.workspace;
	if (!task.worktree) {
		throw new Error(`Task "${task.name}" is missing workspace metadata`);
	}
	return {
		id: task.name,
		kind: "worktree",
		root: task.worktree,
		baseRef: task.baseBranch,
		headRef: task.branch,
		metadata: task.branch ? { branchName: task.branch } : undefined,
	};
}

function taskWorktreeRoot(task: Task): string {
	return taskWorkspace(task).root;
}

function syncLegacyTaskFields(task: Task): void {
	if (!task.workspace) return;
	task.worktree = task.workspace.root;
	task.branch =
		task.workspace.metadata?.branchName ||
		task.workspace.headRef ||
		task.branch;
	task.files = task.files || [];
}

export async function run(args: ParsedArgs): Promise<void> {
	const sub = args._[1];
	if (!sub) {
		logError(
			"Missing subcommand. Usage: ruah task <create|start|done|merge|list|children|cancel|retry|takeover>",
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
		case "retry":
			return taskRetry(args, root);
		case "takeover":
			return taskTakeover(args, root);
		case "claimable":
			return taskClaimable(args, root);
		default:
			logError(`Unknown task subcommand: ${sub}`);
			process.exit(1);
	}
}

async function executeTaskLifecycle(
	task: Task,
	state: RuahState,
	root: string,
	options: {
		dryRun: boolean;
		debugExec: boolean;
		noExec: string | boolean | undefined;
		startVerb: string;
		successMessage: string;
		failurePrefix: string;
	},
): Promise<void> {
	if (task.prompt && !options.noExec) {
		const config = loadConfig(root);
		const provider = getWorkspaceProvider();
		const workspace = taskWorkspace(task);
		state.artifacts ||= {};
		log(`${options.startVerb} ${task.executor || "default"}...`);

		const result = await executeTask(task, workspace.root, {
			debug: options.debugExec,
			dryRun: options.dryRun,
		});

		if (options.dryRun) {
			logInfo(`Would run: ${result.command}`);
			return;
		}

		if (result.success) {
			task.status = "done";
			task.completedAt = new Date().toISOString();
			task.workspace = {
				...workspace,
				headRef: provider.currentHead(workspace, root),
			};
			if (config.captureArtifacts !== false) {
				task.artifact = buildTaskArtifact(provider, {
					taskName: task.name,
					workspace: task.workspace,
					baseRef: task.baseBranch,
					repoRoot: root,
					claims: task.claims,
					validation: {
						executorSuccess: true,
						contractSuccess: true,
					},
				});
				state.artifacts[task.name] = task.artifact;
				if (config.enableCompatibilityChecks) {
					const compatibility = compareArtifactToBase(
						task.artifact,
						task.baseBranch,
						root,
					);
					task.integration = {
						status: compatibility.staleBase
							? "stale"
							: compatibility.clean
								? "clean"
								: "conflict",
						conflictsWith: compatibility.conflictingFiles,
						lastCheckedAt: compatibility.checkedAt,
					};
				}
			}
			syncLegacyTaskFields(task);
			addHistoryEntry(state, "task.done", { task: task.name });
			saveState(root, state);
			logSuccess(options.successMessage);
		} else {
			task.status = "failed";
			addHistoryEntry(state, "task.failed", {
				task: task.name,
				error: result.error,
			});
			saveState(root, state);
			logError(
				`${options.failurePrefix}: ${result.error || `exit code ${result.exitCode}`}`,
			);
			logInfo(`Retry: ruah task retry ${task.name}`);
			logInfo(
				`Take over: ruah task takeover ${task.name} --executor ${task.executor || "<cmd>"}`,
			);
			process.exit(1);
		}
	} else if (!task.prompt) {
		logInfo("No prompt set — task is ready for manual work");
		log(`Worktree: ${task.worktree}`);
	}
}

function taskCreate(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task create <name>");
		process.exit(1);
	}

	const config = loadConfig(root);
	const files =
		typeof args.flags.files === "string"
			? args.flags.files.split(",").map((f) => f.trim())
			: config.files || [];
	const baseBranch =
		typeof args.flags.base === "string" ? args.flags.base : config.baseBranch;
	const executor =
		typeof args.flags.executor === "string"
			? args.flags.executor
			: config.executor || null;
	const prompt =
		typeof args.flags.prompt === "string" ? args.flags.prompt : null;
	const parentName =
		typeof args.flags.parent === "string"
			? args.flags.parent
			: process.env.RUAH_PARENT_TASK || null;
	const depends =
		typeof args.flags.depends === "string"
			? args.flags.depends
					.split(",")
					.map((d) => d.trim())
					.filter(Boolean)
			: [];
	const readOnly = args.flags["read-only"] === true;
	const lockMode = readOnly ? ("read" as const) : ("write" as const);
	const strictLocks =
		args.flags["strict-locks"] === true || config.strictLocks === true;
	const provider = getWorkspaceProvider();

	const state = loadState(root);

	// Validate dependency references
	for (const dep of depends) {
		if (!state.tasks[dep]) {
			logError(
				`Dependency "${dep}" does not exist. Create it first or check the name.`,
			);
			process.exit(1);
		}
	}

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
		base = parentTask.branch || parentTask.baseBranch;
	} else {
		base = baseBranch || state.baseBranch;
	}

	// Check file locks (subtask locks validated against parent scope)
	if (files.length > 0) {
		const lockResult = acquireLocks(
			state,
			name,
			files,
			parentName,
			root,
			strictLocks,
			lockMode,
		);
		if (!lockResult.success) {
			if (lockResult.ambiguous) {
				logError("Strict lock validation failed:");
			} else if (lockResult.outOfScope) {
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
	const workspace = provider.create(name, base, root);
	const worktreePath = workspace.root;
	const branchName =
		workspace.metadata?.branchName || workspace.headRef || `ruah/${name}`;
	const claims = claimSetFromFiles(files, lockMode);

	// Save task
	state.tasks[name] = {
		name,
		status: "created",
		baseBranch:
			parentName && parentTask
				? parentTask.branch || parentTask.baseBranch
				: base,
		workspace,
		claims,
		artifact: null,
		integration: {
			status: "unknown",
			conflictsWith: [],
		},
		branch: branchName,
		worktree: worktreePath,
		files,
		lockMode,
		executor,
		prompt,
		parent: parentName || null,
		children: [],
		depends,
		repoRoot: root,
		createdAt: new Date().toISOString(),
		startedAt: null,
		completedAt: null,
		mergedAt: null,
		workflow: parentTask?.workflow ? { ...parentTask.workflow } : null,
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
		log(`Locked: ${files.join(", ")}${readOnly ? " (read-only)" : ""}`);
	}
	if (executor) logInfo(`Executor: ${executor}`);
}

async function taskStart(args: ParsedArgs, root: string): Promise<void> {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task start <name>");
		process.exit(1);
	}

	const force = args.flags.force === true;
	const state = loadState(root);
	state.artifacts ||= {};
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status !== "created") {
		logError(`Task "${name}" is ${task.status}, can only start from "created"`);
		process.exit(1);
	}

	// Dependency gate: refuse to start if upstream tasks aren't complete
	if (task.depends.length > 0 && !force) {
		const { claimable, blockedBy } = isTaskClaimable(state, name);
		if (!claimable) {
			logError(`Task "${name}" has unmet dependencies — cannot start yet`);
			for (const dep of blockedBy) {
				const depTask = state.tasks[dep];
				logWarn(`  ${dep} (${depTask?.status || "unknown"})`);
			}
			logInfo(
				"Wait for upstream tasks to complete, or use --force to override.",
			);
			process.exit(1);
		}
	}

	task.status = "in-progress";
	task.startedAt = new Date().toISOString();
	addHistoryEntry(state, "task.started", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" started`);

	const noExec = args.flags["no-exec"];
	const dryRun = args.flags["dry-run"];
	const debugExec = args.flags["debug-exec"] === true;

	await executeTaskLifecycle(task, state, root, {
		debugExec,
		dryRun: !!dryRun,
		noExec,
		startVerb: "Executing with",
		successMessage: `Task "${name}" completed successfully`,
		failurePrefix: `Task "${name}" failed`,
	});
}

function taskDone(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task done <name>");
		process.exit(1);
	}

	const state = loadState(root);
	state.artifacts ||= {};
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
	const provider = getWorkspaceProvider();
	const workspace = taskWorkspace(task);
	const diff = provider.diffStat(workspace, task.baseBranch, root);
	if (diff) {
		log("Changes:");
		console.log(diff);
	}

	task.status = "done";
	task.completedAt = new Date().toISOString();
	task.workspace = {
		...workspace,
		headRef: provider.currentHead(workspace, root),
	};
	if (loadConfig(root).captureArtifacts !== false) {
		task.artifact = buildTaskArtifact(provider, {
			taskName: task.name,
			workspace: task.workspace,
			baseRef: task.baseBranch,
			repoRoot: root,
			claims: task.claims,
			validation: {
				executorSuccess: true,
				contractSuccess: true,
			},
		});
		state.artifacts[task.name] = task.artifact;
	}
	syncLegacyTaskFields(task);
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
	const provider = getWorkspaceProvider();
	const workspace = taskWorkspace(task);

	// Determine merge target — subtasks merge into parent branch, not base
	const mergeTarget = task.baseBranch;
	const isSubtask = !!task.parent;

	if (dryRun) {
		const diff = provider.diffStat(workspace, mergeTarget, root);
		log(
			`Dry run — changes that would be merged into ${isSubtask ? `parent (${task.parent})` : mergeTarget}:`,
		);
		console.log(diff || "  (no changes)");
		return;
	}

	// Governance gate enforcement (skip for subtasks merging into parent — gates run on parent merge)
	if (!skipGates && !isSubtask) {
		const gov = detectGovernance(root);
		if (gov.detected) {
			log("Running governance gates...");
			const governance = readGovernance(root);
			if (governance) {
				const gateResult = runGates(governance, workspace.root);
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
		logWarn("Skipping governance gates (--skip-gates)");
	}

	// Merge — subtasks merge from within the parent's worktree
	const mergeOpts: { parentWorktree?: string } = {};
	let parentWorkspace: WorkspaceHandle | undefined;
	if (isSubtask) {
		const parentTask = task.parent ? state.tasks[task.parent] : undefined;
		if (parentTask?.workspace || parentTask?.worktree) {
			parentWorkspace = taskWorkspace(parentTask);
			mergeOpts.parentWorktree = parentWorkspace.root;
		}
	}
	const result = provider.merge(workspace, mergeTarget, root, {
		parentWorkspace,
	});

	if (result.success) {
		const mergedAt = new Date().toISOString();
		addHistoryEntry(state, "task.merged", {
			task: name,
			target: mergeTarget,
			parent: task.parent || null,
			mergedAt,
		});
		provider.remove(workspace, root);
		removeTask(state, name);
		saveState(root, state);

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

function taskClaimable(args: ParsedArgs, root: string): void {
	const state = loadState(root);
	const json = args.flags.json;
	const claimable = getClaimableTasks(state);

	if (json) {
		console.log(JSON.stringify(claimable, null, 2));
		return;
	}

	if (claimable.length === 0) {
		logInfo(
			"No claimable tasks (all tasks are either in-progress, blocked by dependencies, or completed)",
		);
		return;
	}

	log("Claimable tasks (dependencies satisfied):");
	for (const task of claimable) {
		console.log(formatTask(task));
		if (task.depends.length > 0) {
			logInfo(`  deps: ${task.depends.join(", ")} (all satisfied)`);
		}
	}
}

async function taskRetry(args: ParsedArgs, root: string): Promise<void> {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task retry <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (task.status !== "failed") {
		logError(`Task "${name}" is ${task.status}, can only retry from "failed"`);
		process.exit(1);
	}

	const dryRun = args.flags["dry-run"];
	const noExec = args.flags["no-exec"];
	const debugExec = args.flags["debug-exec"] === true;

	// Reset task state — worktree and branch still exist
	task.status = "in-progress";
	task.startedAt = new Date().toISOString();
	task.completedAt = null;
	addHistoryEntry(state, "task.retried", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" reset to in-progress`);

	if (task.prompt && !noExec) {
		await executeTaskLifecycle(task, state, root, {
			debugExec,
			dryRun: !!dryRun,
			noExec,
			startVerb: "Re-executing with",
			successMessage: `Task "${name}" completed successfully on retry`,
			failurePrefix: `Task "${name}" failed again`,
		});
	} else if (!task.prompt) {
		logInfo("No prompt set — task is ready for manual retry");
		log(`Worktree: ${taskWorktreeRoot(task)}`);
	}
}

async function taskTakeover(args: ParsedArgs, root: string): Promise<void> {
	const name = args._[2];
	if (!name) {
		logError("Missing task name. Usage: ruah task takeover <name>");
		process.exit(1);
	}

	const state = loadState(root);
	const task = state.tasks[name];
	if (!task) {
		logError(`Task "${name}" not found`);
		process.exit(1);
	}
	if (
		task.status !== "created" &&
		task.status !== "in-progress" &&
		task.status !== "failed"
	) {
		logError(
			`Task "${name}" is ${task.status}, can only take over created, in-progress, or failed tasks`,
		);
		process.exit(1);
	}

	const dryRun = args.flags["dry-run"];
	const noExec = args.flags["no-exec"];
	const debugExec = args.flags["debug-exec"] === true;
	const previousStatus = task.status;
	const previousExecutor = task.executor;
	const startedAt = new Date().toISOString();
	const nextTask: Task = {
		...task,
		status: "in-progress",
		startedAt,
		completedAt: null,
	};

	if (typeof args.flags.executor === "string") {
		nextTask.executor = args.flags.executor;
	}
	if (typeof args.flags.prompt === "string") {
		nextTask.prompt = args.flags.prompt;
	}

	logSuccess(`Task "${name}" taken over`);
	logInfo(`Worktree: ${taskWorktreeRoot(nextTask)}`);
	if (nextTask.workflow) {
		logInfo(
			`Workflow: ${nextTask.workflow.name} (stage ${nextTask.workflow.stage})`,
		);
	}
	if (typeof args.flags.executor === "string") {
		logInfo(`Executor: ${nextTask.executor}`);
	}

	if (!dryRun) {
		state.tasks[name] = nextTask;
		addHistoryEntry(state, "task.taken_over", {
			task: name,
			fromStatus: previousStatus,
			fromExecutor: previousExecutor,
			toExecutor: nextTask.executor,
			workflow: nextTask.workflow?.name || null,
		});
		saveState(root, state);
	}

	await executeTaskLifecycle(nextTask, state, root, {
		debugExec,
		dryRun: !!dryRun,
		noExec,
		startVerb: "Executing with",
		successMessage: `Task "${name}" completed successfully after takeover`,
		failurePrefix: `Task "${name}" failed after takeover`,
	});
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
	const provider = getWorkspaceProvider();
	const children = getChildren(state, name);
	for (const child of children) {
		if (child.status !== "merged" && child.status !== "cancelled") {
			provider.remove(taskWorkspace(child), root);
			child.status = "cancelled";
			releaseLocks(state, child.name);
			addHistoryEntry(state, "task.cancelled", {
				task: child.name,
				reason: `parent "${name}" cancelled`,
			});
			logWarn(`Subtask "${child.name}" cancelled (parent cancelled)`);
		}
	}

	provider.remove(taskWorkspace(task), root);
	releaseLocks(state, name);
	task.status = "cancelled";
	addHistoryEntry(state, "task.cancelled", { task: name });
	saveState(root, state);

	logSuccess(`Task "${name}" cancelled`);
}
