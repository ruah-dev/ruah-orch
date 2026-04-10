import type { ParsedArgs } from "../cli.js";
import { artifactPresent } from "../core/artifact.js";
import { claimSetToFiles } from "../core/claims.js";
import { loadConfig } from "../core/config.js";
import { getCurrentBranch, getRepoRoot, listWorktrees } from "../core/git.js";
import { detectGovernance, readGovernance } from "../core/integrations.js";
import { reconcileStateWithGit } from "../core/reconcile.js";
import type { Task } from "../core/state.js";
import { loadState } from "../core/state.js";
import {
	formatLocks,
	formatTaskList,
	heading,
	log,
	logInfo,
	logSuccess,
} from "../utils/format.js";

interface WorkflowSummary {
	name: string;
	path: string;
	stageCount: number;
	taskNames: string[];
	counts: Record<string, number>;
}

function summarizeWorkflows(tasks: Task[]): WorkflowSummary[] {
	const summaries = new Map<string, WorkflowSummary>();

	for (const task of tasks) {
		if (!task.workflow) continue;
		const key = `${task.workflow.path}:${task.workflow.name}`;
		const existing = summaries.get(key);
		if (existing) {
			existing.taskNames.push(task.name);
			existing.stageCount = Math.max(existing.stageCount, task.workflow.stage);
			existing.counts[task.status] = (existing.counts[task.status] || 0) + 1;
			continue;
		}

		summaries.set(key, {
			name: task.workflow.name,
			path: task.workflow.path,
			stageCount: task.workflow.stage,
			taskNames: [task.name],
			counts: {
				[task.status]: 1,
			},
		});
	}

	return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function run(args: ParsedArgs): Promise<void> {
	const root = getRepoRoot();
	const json = args.flags.json;
	const config = loadConfig(root);

	const state = loadState(root);
	const reconciliation = reconcileStateWithGit(root, state);
	const branch = getCurrentBranch();
	const worktrees = listWorktrees(root);
	const gov = detectGovernance(root);
	const tasks = Object.values(state.tasks);
	const active = tasks.filter((t) => t.status === "in-progress").length;
	const done = tasks.filter((t) => t.status === "done").length;
	const merged = tasks.filter((t) => t.status === "merged").length;
	const failed = tasks.filter((t) => t.status === "failed").length;
	const created = tasks.filter((t) => t.status === "created").length;
	const workflows = summarizeWorkflows(tasks);

	if (json) {
		console.log(
			JSON.stringify(
				{
					baseBranch: state.baseBranch,
					currentBranch: branch,
					governanceDetected: gov.detected,
					governancePath: gov.path,
					engine: {
						workspaceBackend: config.workspaceBackend || "worktree",
						captureArtifacts: config.captureArtifacts ?? true,
						enableCompatibilityChecks:
							config.enableCompatibilityChecks ?? false,
						enablePlannerV2: config.enablePlannerV2 ?? false,
					},
					taskCounts: {
						total: tasks.length,
						created,
						active,
						done,
						merged,
						failed,
					},
					tasks: Object.fromEntries(
						Object.entries(state.tasks).map(([name, task]) => [
							name,
							{
								...task,
								workspace: task.workspace || null,
								claims: task.claims || null,
								artifactPresent: artifactPresent(task.artifact),
								integrationStatus: task.integration?.status || "unknown",
								files: task.files || claimSetToFiles(task.claims),
							},
						]),
					),
					artifacts: state.artifacts,
					locks: state.locks,
					workflows,
					worktrees: worktrees.map((w) => ({
						path: w.path,
						branch: w.branch,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	log(`Base branch: ${state.baseBranch}`);
	log(`Current branch: ${branch}`);

	// governance status
	if (gov.detected) {
		const governance = readGovernance(root);
		if (governance) {
			const mandatory = governance.gates.filter(
				(g) => g.classification === "MANDATORY",
			).length;
			const optional = governance.gates.filter(
				(g) => g.classification === "OPTIONAL",
			).length;
			const advisory = governance.gates.filter(
				(g) => g.classification === "ADVISORY",
			).length;
			logSuccess(
				`governance: detected (${gov.path}) — ${governance.gates.length} gates (${mandatory} mandatory, ${optional} optional, ${advisory} advisory)`,
			);
		} else {
			logSuccess(`governance: detected (${gov.path})`);
		}
	} else {
		logInfo("governance: not detected");
	}

	// Tasks
	const total = tasks.length;
	if (total > 0) {
		const parts: string[] = [];
		if (active) parts.push(`${active} active`);
		if (created) parts.push(`${created} created`);
		if (done) parts.push(`${done} done`);
		if (merged) parts.push(`${merged} merged`);
		if (failed) parts.push(`${failed} failed`);
		log(
			parts.length > 0
				? `Tasks: ${total} total (${parts.join(", ")})`
				: `Tasks: ${total} total`,
		);
	} else {
		log("Tasks: none");
	}

	if (reconciliation.merged.length > 0) {
		logInfo(
			`Auto-reconciled merged task(s): ${reconciliation.merged.join(", ")}`,
		);
	}
	if (reconciliation.cleanedCancelled.length > 0) {
		logInfo(
			`Cleaned cancelled task(s): ${reconciliation.cleanedCancelled.join(", ")}`,
		);
	}

	console.log("");
	log(heading("Tasks:"));
	console.log(formatTaskList(state.tasks));

	// File locks
	if (Object.keys(state.locks).length > 0) {
		console.log("");
		log(heading("File locks:"));
		console.log(formatLocks(state.locks));
	}

	if (workflows.length > 0) {
		console.log("");
		log(heading("Workflows:"));
		for (const workflow of workflows) {
			const counts = Object.entries(workflow.counts)
				.map(([status, count]) => `${count} ${status}`)
				.join(", ");
			logInfo(
				`  ${workflow.name} (${workflow.taskNames.length} task(s), ${counts})`,
			);
			logInfo(`  Path: ${workflow.path}`);
		}
	}

	// Active worktrees
	if (worktrees.length > 0) {
		console.log("");
		log(heading("Worktrees:"));
		for (const w of worktrees) {
			logInfo(`  ${w.branch} → ${w.path}`);
		}
	}
}
