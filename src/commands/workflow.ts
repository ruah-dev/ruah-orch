import { join } from "node:path";
import type { ParsedArgs } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { executeTask } from "../core/executor.js";
import {
	createWorktree,
	getRepoRoot,
	mergeWorktree,
	removeWorktree,
} from "../core/git.js";
import {
	detectCrag,
	readCragGovernance,
	runGates,
} from "../core/integrations.js";
import {
	acquireLocks,
	addHistoryEntry,
	loadState,
	releaseLocks,
	saveState,
} from "../core/state.js";
import type { WorkflowTask } from "../core/workflow.js";
import {
	getExecutionPlan,
	listWorkflows,
	parseWorkflow,
	validateDAG,
} from "../core/workflow.js";
import {
	formatExecutionPlan,
	heading,
	log,
	logError,
	logInfo,
	logSuccess,
} from "../utils/format.js";

export async function run(args: ParsedArgs): Promise<void> {
	const sub = args._[1];
	if (!sub) {
		logError("Missing subcommand. Usage: ruah workflow <run|plan|list>");
		process.exit(1);
	}

	const root = getRepoRoot();

	switch (sub) {
		case "run":
			return workflowRun(args, root);
		case "plan":
			return workflowPlan(args, root);
		case "list":
			return workflowList(args, root);
		default:
			logError(`Unknown workflow subcommand: ${sub}`);
			process.exit(1);
	}
}

interface StageTask {
	def: WorkflowTask;
	worktreePath: string;
}

interface ExecResult {
	name: string;
	success: boolean;
	exitCode?: number | null;
	error?: string | null;
}

async function workflowRun(args: ParsedArgs, root: string): Promise<void> {
	const file = args._[2];
	if (!file) {
		logError("Missing workflow file. Usage: ruah workflow run <file.md>");
		process.exit(1);
	}

	const dryRun = args.flags["dry-run"];
	const json = args.flags.json;

	const workflow = parseWorkflow(file);
	const validation = validateDAG(workflow.tasks);
	if (!validation.valid) {
		logError("Workflow validation failed:");
		for (const err of validation.errors) logError(`  ${err}`);
		process.exit(1);
	}

	const plan = getExecutionPlan(workflow.tasks);
	const state = loadState(root);
	const config = loadConfig(root);
	const baseBranch =
		workflow.config.base || config.baseBranch || state.baseBranch;

	if (json && dryRun) {
		console.log(
			JSON.stringify(
				{ workflow: workflow.name, stages: plan, baseBranch },
				null,
				2,
			),
		);
		return;
	}

	log(`Workflow: ${heading(workflow.name)}`);
	log(`Base: ${baseBranch}`);
	log(`Tasks: ${workflow.tasks.length}`);
	log(`Stages: ${plan.length}`);
	console.log("");
	console.log(formatExecutionPlan(plan));
	console.log("");

	if (dryRun) {
		logInfo("Dry run — no tasks will be executed");
		return;
	}

	// Detect crag for gate enforcement
	const crag = detectCrag(root);
	let governance = null;
	if (crag.detected) {
		governance = readCragGovernance(root);
		logInfo("crag detected — gates will run after each stage");
	}

	const results: ExecResult[] = [];

	for (let i = 0; i < plan.length; i++) {
		const stage = plan[i];
		log(`Stage ${i + 1}/${plan.length} — ${stage.length} task(s)`);

		// Create worktrees and check locks
		const stageTasks: StageTask[] = [];
		for (const taskDef of stage) {
			if (taskDef.files.length > 0) {
				const lockResult = acquireLocks(state, taskDef.name, taskDef.files);
				if (!lockResult.success) {
					logError(
						`Lock conflict for "${taskDef.name}": ${lockResult.conflicts.map((c) => c.pattern).join(", ")}`,
					);
					process.exit(1);
				}
			}

			const { worktreePath, branchName } = createWorktree(
				taskDef.name,
				baseBranch,
				root,
			);
			state.tasks[taskDef.name] = {
				name: taskDef.name,
				status: "in-progress",
				baseBranch,
				branch: branchName,
				worktree: worktreePath,
				files: taskDef.files,
				executor: taskDef.executor,
				prompt: taskDef.prompt,
				parent: null,
				children: [],
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				completedAt: null,
				mergedAt: null,
			};
			addHistoryEntry(state, "task.created", { task: taskDef.name });
			saveState(root, state);

			stageTasks.push({ def: taskDef, worktreePath });
		}

		// Execute tasks (parallel if configured and stage has multiple)
		const execPromises = stageTasks.map(
			async ({ def, worktreePath }): Promise<ExecResult> => {
				logInfo(`  Running: ${def.name} (${def.executor || "script"})`);
				const result = await executeTask(def, worktreePath, {
					silent: true,
				});

				if (result.success) {
					state.tasks[def.name].status = "done";
					state.tasks[def.name].completedAt = new Date().toISOString();
					addHistoryEntry(state, "task.done", { task: def.name });
					logSuccess(`  ${def.name}: completed`);
				} else {
					state.tasks[def.name].status = "failed";
					addHistoryEntry(state, "task.failed", { task: def.name });
					logError(
						`  ${def.name}: failed — ${result.error || `exit ${result.exitCode}`}`,
					);
				}

				saveState(root, state);
				return {
					name: def.name,
					success: result.success,
					exitCode: result.exitCode,
					error: result.error,
				};
			},
		);

		let execResults: ExecResult[];
		if (workflow.config.parallel && stageTasks.length > 1) {
			execResults = await Promise.all(execPromises);
		} else {
			execResults = [];
			for (const p of execPromises) {
				execResults.push(await p);
			}
		}

		// Check for failures
		const failures = execResults.filter((r) => !r.success);
		if (failures.length > 0) {
			logError(`Stage ${i + 1} failed. Halting workflow.`);
			results.push(...execResults);
			break;
		}

		// Run crag gates if available
		if (governance) {
			for (const { def, worktreePath } of stageTasks) {
				const gateResult = runGates(governance, worktreePath);
				if (!gateResult.passed) {
					logError(`Gate failed for "${def.name}". Halting workflow.`);
					process.exit(1);
				}
			}
			logSuccess("  Gates passed");
		}

		// Merge each task
		for (const { def } of stageTasks) {
			const mergeResult = mergeWorktree(def.name, baseBranch, root);
			if (mergeResult.success) {
				state.tasks[def.name].status = "merged";
				state.tasks[def.name].mergedAt = new Date().toISOString();
				releaseLocks(state, def.name);
				removeWorktree(def.name, root);
				addHistoryEntry(state, "task.merged", { task: def.name });
				logSuccess(`  ${def.name}: merged`);
			} else {
				logError(
					`  ${def.name}: merge conflict — ${mergeResult.conflicts.join(", ")}`,
				);
				process.exit(1);
			}
		}

		saveState(root, state);
		results.push(...execResults);
	}

	console.log("");
	const merged = results.filter((r) => r.success).length;
	const failed = results.filter((r) => !r.success).length;
	if (failed === 0) {
		logSuccess(
			`Workflow "${workflow.name}" complete. ${merged}/${results.length} tasks merged.`,
		);
	} else {
		logError(
			`Workflow "${workflow.name}" incomplete. ${merged} merged, ${failed} failed.`,
		);
	}

	if (json) {
		console.log(JSON.stringify({ workflow: workflow.name, results }, null, 2));
	}
}

function workflowPlan(args: ParsedArgs, _root: string): void {
	const file = args._[2];
	if (!file) {
		logError("Missing workflow file. Usage: ruah workflow plan <file.md>");
		process.exit(1);
	}

	const json = args.flags.json;
	const workflow = parseWorkflow(file);
	const validation = validateDAG(workflow.tasks);

	if (!validation.valid) {
		logError("Workflow validation failed:");
		for (const err of validation.errors) logError(`  ${err}`);
		process.exit(1);
	}

	const plan = getExecutionPlan(workflow.tasks);

	if (json) {
		console.log(
			JSON.stringify(
				{
					workflow: workflow.name,
					config: workflow.config,
					tasks: workflow.tasks,
					stages: plan,
				},
				null,
				2,
			),
		);
		return;
	}

	log(`Workflow: ${heading(workflow.name)}`);
	log(`Base: ${workflow.config.base}`);
	log(`Parallel: ${workflow.config.parallel}`);
	log(`Tasks: ${workflow.tasks.length}`);
	console.log("");
	console.log(formatExecutionPlan(plan));

	for (const task of workflow.tasks) {
		console.log("");
		log(`${heading(task.name)}`);
		if (task.files.length) logInfo(`  Files: ${task.files.join(", ")}`);
		if (task.executor) logInfo(`  Executor: ${task.executor}`);
		if (task.depends.length) logInfo(`  Depends: ${task.depends.join(", ")}`);
		if (task.prompt)
			logInfo(
				`  Prompt: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? "..." : ""}`,
			);
	}
}

function workflowList(args: ParsedArgs, root: string): void {
	const dir = join(root, ".ruah", "workflows");
	const workflows = listWorkflows(dir);
	const json = args.flags.json;

	if (json) {
		console.log(JSON.stringify(workflows, null, 2));
		return;
	}

	if (workflows.length === 0) {
		logInfo("No workflows found in .ruah/workflows/");
		return;
	}

	log("Workflows:");
	for (const w of workflows) {
		logInfo(`  ${w.name} (${w.path})`);
	}
}
