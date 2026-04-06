import type { ParsedArgs } from "../cli.js";
import { getCurrentBranch, getRepoRoot, listWorktrees } from "../core/git.js";
import {
	detectArhy,
	detectCrag,
	readCragGovernance,
} from "../core/integrations.js";
import { loadState } from "../core/state.js";
import {
	formatLocks,
	formatTaskList,
	heading,
	log,
	logInfo,
	logSuccess,
} from "../utils/format.js";

export async function run(args: ParsedArgs): Promise<void> {
	const root = getRepoRoot();
	const json = args.flags.json;

	const state = loadState(root);
	const branch = getCurrentBranch();
	const worktrees = listWorktrees(root);
	const crag = detectCrag(root);
	const arhy = detectArhy(root);

	const tasks = Object.values(state.tasks);
	const active = tasks.filter((t) => t.status === "in-progress").length;
	const done = tasks.filter((t) => t.status === "done").length;
	const merged = tasks.filter((t) => t.status === "merged").length;
	const failed = tasks.filter((t) => t.status === "failed").length;
	const created = tasks.filter((t) => t.status === "created").length;

	if (json) {
		console.log(
			JSON.stringify(
				{
					baseBranch: state.baseBranch,
					currentBranch: branch,
					cragDetected: crag.detected,
					cragPath: crag.path,
					arhyDetected: arhy.detected,
					taskCounts: {
						total: tasks.length,
						created,
						active,
						done,
						merged,
						failed,
					},
					tasks: state.tasks,
					locks: state.locks,
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

	// crag status
	if (crag.detected) {
		const governance = readCragGovernance(root);
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
				`crag: detected (${crag.path}) — ${governance.gates.length} gates (${mandatory} mandatory, ${optional} optional, ${advisory} advisory)`,
			);
		} else {
			logSuccess(`crag: detected (${crag.path})`);
		}
	} else {
		logInfo("crag: not detected");
	}

	// arhy status
	if (arhy.detected) {
		logInfo(`arhy: detected (${arhy.files.length} contract file(s))`);
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
		log(`Tasks: ${total} total (${parts.join(", ")})`);
	} else {
		log("Tasks: none");
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

	// Active worktrees
	if (worktrees.length > 0) {
		console.log("");
		log(heading("Worktrees:"));
		for (const w of worktrees) {
			logInfo(`  ${w.branch} → ${w.path}`);
		}
	}
}
