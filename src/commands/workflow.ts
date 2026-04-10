import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedArgs } from "../cli.js";
import { buildTaskArtifact, type TaskArtifact } from "../core/artifact.js";
import { claimSetFromFiles } from "../core/claims.js";
import { loadConfig } from "../core/config.js";
import {
	formatContractViolationReport,
	validateContractChanges,
} from "../core/contract-validator.js";
import type { TaskDef } from "../core/executor.js";
import { executeTask } from "../core/executor.js";
import { getCurrentBranch, getRepoRoot } from "../core/git.js";
import {
	compareArtifacts,
	compareArtifactToBase,
} from "../core/integration.js";
import {
	detectGovernance,
	readGovernance,
	runGates,
} from "../core/integrations.js";
import type { SmartPlan, StageDecision } from "../core/planner.js";
import { createSmartPlan } from "../core/planner.js";
import {
	acquireLocks,
	addHistoryEntry,
	loadState,
	releaseLocks,
	removeTask,
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
	getWorkspaceProvider,
	type WorkspaceHandle,
} from "../core/workspace.js";
import {
	formatExecutionPlan,
	heading,
	log,
	logError,
	logInfo,
	logSuccess,
	logWarn,
} from "../utils/format.js";

export async function run(args: ParsedArgs): Promise<void> {
	const sub = args._[1];
	if (!sub) {
		logError("Missing subcommand. Usage: ruah workflow <run|plan|list|create>");
		process.exit(1);
	}

	const root = getRepoRoot();

	switch (sub) {
		case "run":
			return workflowRun(args, root);
		case "explain":
			return workflowExplain(args, root);
		case "plan":
			return workflowPlan(args, root);
		case "list":
			return workflowList(args, root);
		case "create":
			return workflowCreate(args, root);
		default:
			logError(`Unknown workflow subcommand: ${sub}`);
			process.exit(1);
	}
}

interface StageTask {
	def: WorkflowTask;
	workspace: WorkspaceHandle;
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
	const workflowPath = resolve(file);

	const dryRun = args.flags["dry-run"];
	const debugExec = args.flags["debug-exec"] === true;
	const json = args.flags.json;

	const workflow = parseWorkflow(workflowPath);
	const validation = validateDAG(workflow.tasks);
	if (!validation.valid) {
		logError("Workflow validation failed:");
		for (const err of validation.errors) logError(`  ${err}`);
		process.exit(1);
	}

	const plan = getExecutionPlan(workflow.tasks);
	const state = loadState(root);
	if (!state.artifacts) {
		state.artifacts = {};
	}
	const artifacts = state.artifacts;
	const config = loadConfig(root);
	const provider = getWorkspaceProvider();
	const baseBranch =
		workflow.config.base || config.baseBranch || state.baseBranch;
	const strictLocks =
		args.flags["strict-locks"] === true || config.strictLocks === true;

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

	// Smart planner: analyze overlaps and decide parallel/serial per stage
	let smartPlan: SmartPlan | null = null;
	if (workflow.config.parallel) {
		smartPlan = createSmartPlan(plan, root, config.maxParallel);
		logInfo(
			`Planner: ${smartPlan.summary.parallelStages} parallel, ${smartPlan.summary.contractStages} contract, ${smartPlan.summary.serialStages} serial stage(s)`,
		);
		if (smartPlan.summary.overlapCount > 0) {
			logWarn(
				`Planner: ${smartPlan.summary.overlapCount} file overlap(s) detected`,
			);
		}
	}

	log(`Workflow: ${heading(workflow.name)}`);
	log(`Base: ${baseBranch}`);
	log(`Tasks: ${workflow.tasks.length}`);
	log(`Stages: ${plan.length}`);
	console.log("");
	console.log(formatExecutionPlan(plan));
	console.log("");

	if (dryRun) {
		if (smartPlan) {
			for (let i = 0; i < smartPlan.refinedStages.length; i++) {
				const decision = smartPlan.refinedStages[i];
				logInfo(`  Stage ${i + 1}: ${decision.strategy} — ${decision.reason}`);
			}
		}
		logInfo("Dry run — no tasks will be executed");
		return;
	}

	if (debugExec) {
		logInfo("Execution debug enabled — streaming child session output");
	}

	// Detect governance for gate enforcement
	const gov = detectGovernance(root);
	let governance = null;
	if (gov.detected) {
		governance = readGovernance(root);
		logInfo("Governance detected — gates will run after each stage");
	}

	const results: ExecResult[] = [];

	for (let i = 0; i < plan.length; i++) {
		const stage = plan[i];
		const decision: StageDecision | undefined = smartPlan?.refinedStages[i];
		const stageStrategy = decision?.strategy || "parallel";

		log(
			`Stage ${i + 1}/${plan.length} — ${stage.length} task(s) [${stageStrategy}]`,
		);
		if (decision && stageStrategy !== "parallel") {
			logInfo(`  ${decision.reason}`);
		}

		// If serial, process tasks one at a time in the planner's order
		const stageOrder: WorkflowTask[][] =
			stageStrategy === "serial" && decision?.serialOrder
				? decision.serialOrder
				: [stage];

		for (const substage of stageOrder) {
			// Create workspaces and check locks
			const stageTasks: StageTask[] = [];
			for (const taskDef of substage) {
				if (taskDef.files.length > 0) {
					const lockResult = acquireLocks(
						state,
						taskDef.name,
						taskDef.files,
						undefined,
						root,
						strictLocks,
					);
					if (!lockResult.success) {
						if (lockResult.ambiguous) {
							logError(
								`Strict lock validation failed for "${taskDef.name}": ${lockResult.conflicts.map((c) => c.requested).join(", ")}`,
							);
							logInfo(
								"Use concrete file globs or disable strict locks for exploratory tasks.",
							);
							process.exit(1);
						}
						logError(
							`Lock conflict for "${taskDef.name}": ${lockResult.conflicts.map((c) => c.pattern).join(", ")}`,
						);
						process.exit(1);
					}
				}

				const workspace = provider.create(taskDef.name, baseBranch, root);
				const branchName =
					workspace.metadata?.branchName ||
					workspace.headRef ||
					`ruah/${taskDef.name}`;
				state.tasks[taskDef.name] = {
					name: taskDef.name,
					status: "in-progress",
					baseBranch,
					workspace,
					claims: claimSetFromFiles(taskDef.files),
					artifact: null,
					integration: {
						status: "unknown",
						conflictsWith: [],
					},
					branch: branchName,
					worktree: workspace.root,
					files: taskDef.files,
					lockMode: "write",
					executor: taskDef.executor,
					prompt: taskDef.prompt,
					parent: null,
					children: [],
					depends: [...taskDef.depends],
					createdAt: new Date().toISOString(),
					startedAt: new Date().toISOString(),
					completedAt: null,
					mergedAt: null,
					workflow: {
						name: workflow.name,
						path: workflowPath,
						stage: i + 1,
						depends: [...taskDef.depends],
					},
				};
				addHistoryEntry(state, "task.created", { task: taskDef.name });
				saveState(root, state);

				stageTasks.push({ def: taskDef, workspace });
			}

			// Build TaskDef with contract (if planner assigned one)
			const execPromises = stageTasks.map(
				async ({ def, workspace }): Promise<ExecResult> => {
					logInfo(`  Running: ${def.name} (${def.executor || "script"})`);

					// Inject contract from smart planner
					const contract = decision?.contracts?.get(def.name) ?? null;
					const taskDefWithContract: TaskDef = {
						...def,
						contract,
					};

					const result = await executeTask(
						taskDefWithContract,
						workspace.root,
						{
							debug: debugExec,
							silent: true,
						},
					);

					let contractValidation = null;
					if (result.success && contract) {
						contractValidation = validateContractChanges(
							contract,
							workspace.root,
							root,
							baseBranch,
						);
					}

					if (
						result.success &&
						(!contractValidation || contractValidation.valid)
					) {
						const task = state.tasks[def.name];
						task.status = "done";
						task.completedAt = new Date().toISOString();
						task.workspace = {
							...workspace,
							headRef: provider.currentHead(workspace, root),
						};
						if (config.captureArtifacts !== false) {
							task.artifact = buildTaskArtifact(provider, {
								taskName: def.name,
								workspace: task.workspace,
								baseRef: baseBranch,
								repoRoot: root,
								claims: task.claims,
								validation: {
									executorSuccess: true,
									contractSuccess:
										!contractValidation || contractValidation.valid,
								},
							});
							artifacts[def.name] = task.artifact;
						}
						addHistoryEntry(state, "task.done", { task: def.name });
						logSuccess(`  ${def.name}: completed`);
					} else {
						state.tasks[def.name].status = "failed";
						addHistoryEntry(state, "task.failed", {
							task: def.name,
							reason: contractValidation ? "contract-violation" : "executor",
						});
						if (contractValidation && !contractValidation.valid) {
							logError(`  ${def.name}: contract violation`);
							for (const line of formatContractViolationReport(
								contractValidation,
							)) {
								logWarn(`    ${line}`);
							}
						} else {
							logError(
								`  ${def.name}: failed — ${result.error || `exit ${result.exitCode}`}`,
							);
						}
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

			// Decide parallel vs serial execution for this substage
			let execResults: ExecResult[];
			const canRunParallel =
				stageStrategy !== "serial" && stageTasks.length > 1;
			if (canRunParallel) {
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
				const failedTaskNames = new Set(
					failures.map((failure) => failure.name),
				);
				// Clean up tasks from this stage that won't be merged
				for (const { def } of stageTasks) {
					const task = state.tasks[def.name];
					if (!task || task.status === "merged") {
						continue;
					}
					if (failedTaskNames.has(def.name)) {
						logWarn(`  Preserved failed task for takeover: ${def.name}`);
						logInfo(
							`    Next: ruah task takeover ${def.name} --executor ${task.executor || "<cmd>"}`,
						);
						continue;
					}
					if (task) {
						provider.remove(
							task.workspace || {
								id: task.name,
								kind: "worktree",
								root: task.worktree || "",
								baseRef: task.baseBranch,
								headRef: task.branch,
								metadata: task.branch ? { branchName: task.branch } : undefined,
							},
							root,
						);
						releaseLocks(state, def.name);
						task.status = "cancelled";
						logWarn(`  Cleaned up: ${def.name}`);
					}
				}
				saveState(root, state);
				results.push(...execResults);
				break;
			}

			if (config.enableCompatibilityChecks) {
				const completedArtifacts = stageTasks
					.map(({ def }) => state.tasks[def.name]?.artifact)
					.filter((artifact): artifact is TaskArtifact => !!artifact);

				for (const artifact of completedArtifacts) {
					const baseCompatibility = compareArtifactToBase(
						artifact,
						baseBranch,
						root,
					);
					const task = state.tasks[artifact.taskName];
					task.integration = {
						status: baseCompatibility.staleBase
							? "stale"
							: baseCompatibility.clean
								? "clean"
								: "conflict",
						conflictsWith: baseCompatibility.conflictingFiles,
						lastCheckedAt: baseCompatibility.checkedAt,
					};
				}

				for (let left = 0; left < completedArtifacts.length; left++) {
					for (
						let right = left + 1;
						right < completedArtifacts.length;
						right++
					) {
						const compatibility = compareArtifacts(
							completedArtifacts[left],
							completedArtifacts[right],
							root,
						);
						if (!compatibility.clean) {
							const leftTask = state.tasks[completedArtifacts[left].taskName];
							const rightTask = state.tasks[completedArtifacts[right].taskName];
							leftTask.integration = {
								status: "conflict",
								conflictsWith: compatibility.conflictingFiles,
								lastCheckedAt: compatibility.checkedAt,
							};
							rightTask.integration = {
								status: "conflict",
								conflictsWith: compatibility.conflictingFiles,
								lastCheckedAt: compatibility.checkedAt,
							};
							saveState(root, state);
							logError(
								`Compatibility check failed for "${leftTask.name}" and "${rightTask.name}" — ${compatibility.conflictingFiles.join(", ")}`,
							);
							process.exit(1);
						}
					}
				}
			}

			// Run governance gates if available
			if (governance) {
				for (const { def, workspace } of stageTasks) {
					const gateResult = runGates(governance, workspace.root);
					if (!gateResult.passed) {
						logError(`Gate failed for "${def.name}". Halting workflow.`);
						process.exit(1);
					}
				}
				logSuccess("  Gates passed");
			}

			// Merge each task
			for (const { def, workspace } of stageTasks) {
				const mergeResult = provider.merge(workspace, baseBranch, root);
				if (mergeResult.success) {
					const mergedAt = new Date().toISOString();
					addHistoryEntry(state, "task.merged", {
						task: def.name,
						target: baseBranch,
						mergedAt,
					});
					provider.remove(workspace, root);
					removeTask(state, def.name);
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

function workflowExplain(args: ParsedArgs, root: string): void {
	const ref = args._[2];
	if (!ref) {
		logError(
			"Missing workflow reference. Usage: ruah workflow explain <name|file.md>",
		);
		process.exit(1);
	}

	const resolvedRef = resolve(ref);
	const state = loadState(root);
	const tasks = Object.values(state.tasks)
		.filter((task) => task.workflow)
		.filter(
			(task) =>
				task.workflow?.name === ref || task.workflow?.path === resolvedRef,
		)
		.sort((a, b) => {
			const stageDiff = (a.workflow?.stage || 0) - (b.workflow?.stage || 0);
			return stageDiff !== 0 ? stageDiff : a.name.localeCompare(b.name);
		});

	if (tasks.length === 0) {
		logError(`No workflow state found for "${ref}"`);
		process.exit(1);
	}

	const workflow = tasks[0].workflow;
	log(`Workflow: ${heading(workflow?.name || ref)}`);
	if (workflow?.path) {
		logInfo(`Path: ${workflow.path}`);
	}

	const blocking = tasks.filter(
		(task) =>
			task.status === "failed" ||
			task.status === "created" ||
			task.status === "in-progress",
	);
	logInfo(`Blocking tasks: ${blocking.length}`);

	for (const task of tasks) {
		logInfo(`  Stage ${task.workflow?.stage}: ${task.name} (${task.status})`);
		if (task.status === "failed") {
			logInfo(
				`    Next: ruah task takeover ${task.name} --executor ${task.executor || "<cmd>"}`,
			);
		} else if (task.status === "created" || task.status === "in-progress") {
			logInfo(`    Next: ruah task start ${task.name}`);
		} else if (task.status === "done") {
			logInfo(`    Next: ruah task merge ${task.name}`);
		}
	}
}

function workflowPlan(args: ParsedArgs, root: string): void {
	const file = args._[2];
	if (!file) {
		logError("Missing workflow file. Usage: ruah workflow plan <file.md>");
		process.exit(1);
	}

	const json = args.flags.json;
	const workflow = parseWorkflow(file);
	const config = loadConfig(root);
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

	// Smart planner overlap analysis
	if (workflow.config.parallel) {
		console.log("");
		log(heading("Overlap Analysis"));
		const smartPlan = createSmartPlan(plan, root, config.maxParallel);

		if (smartPlan.overlaps.length === 0) {
			logSuccess("No file overlaps — all stages safe to parallelize");
		} else {
			logWarn(`${smartPlan.overlaps.length} overlap(s) detected:`);
			for (const overlap of smartPlan.overlaps) {
				logWarn(
					`  ${overlap.taskA} ↔ ${overlap.taskB}: ${overlap.overlappingPatterns.join(", ")} (ratio: ${overlap.overlapRatio.toFixed(2)}, risk: ${overlap.riskScore.toFixed(1)})`,
				);
			}
		}

		console.log("");
		log(heading("Stage Strategies"));
		for (let i = 0; i < smartPlan.refinedStages.length; i++) {
			const decision = smartPlan.refinedStages[i];
			const icon =
				decision.strategy === "parallel"
					? "✓"
					: decision.strategy === "parallel-with-contracts"
						? "◐"
						: "⊘";
			logInfo(
				`  Stage ${i + 1}: ${icon} ${decision.strategy} — ${decision.reason}`,
			);

			if (decision.contracts) {
				for (const [taskName, contract] of decision.contracts) {
					const owned = contract.owned.length;
					const shared = contract.sharedAppend.length;
					const ro = contract.readOnly.length;
					logInfo(
						`    ${taskName}: ${owned} owned, ${shared} shared-append, ${ro} read-only`,
					);
				}
			}
		}
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

function workflowCreate(args: ParsedArgs, root: string): void {
	const name = args._[2];
	if (!name) {
		logError("Missing workflow name. Usage: ruah workflow create <name>");
		process.exit(1);
	}

	const dir = join(root, ".ruah", "workflows");
	mkdirSync(dir, { recursive: true });

	const filePath = join(dir, `${name}.md`);

	if (existsSync(filePath) && !args.flags.force) {
		logError(`Workflow "${name}" already exists at ${filePath}`);
		logInfo("Use --force to overwrite");
		process.exit(1);
	}

	const baseBranch = getCurrentBranch(root);
	const template = generateTemplate(name, baseBranch);
	writeFileSync(filePath, template, "utf-8");

	logSuccess(`Workflow "${name}" created`);
	log(`File: ${filePath}`);
	logInfo("Edit the file to define your tasks, then run:");
	logInfo(`  ruah workflow run ${filePath}`);
}

function generateTemplate(name: string, baseBranch: string): string {
	return `# Workflow: ${name}

## Config
- base: ${baseBranch}
- parallel: true

## Tasks

### task-1
- files: src/feature-a/**
- executor: claude-code
- depends: []
- prompt: |
    Implement feature A.

### task-2
- files: src/feature-b/**
- executor: claude-code
- depends: []
- prompt: |
    Implement feature B.

### integration
- files: test/**
- executor: claude-code
- depends: [task-1, task-2]
- prompt: |
    Write integration tests for features A and B.
`;
}
