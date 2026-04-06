import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ConflictStrategy = "fail" | "rebase" | "retry";

export interface WorkflowConfig {
	base: string;
	parallel: boolean;
	onConflict: ConflictStrategy;
}

export interface WorkflowTask {
	name: string;
	files: string[];
	executor: string | null;
	depends: string[];
	prompt: string;
	onConflict: ConflictStrategy;
}

export interface Workflow {
	name: string;
	config: WorkflowConfig;
	tasks: WorkflowTask[];
}

export interface DAGValidation {
	valid: boolean;
	errors: string[];
}

export interface WorkflowEntry {
	name: string;
	path: string;
}

export function parseWorkflow(filePath: string): Workflow {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");

	let name = "unnamed";
	const config: WorkflowConfig = {
		base: "main",
		parallel: false,
		onConflict: "fail",
	};
	const tasks: WorkflowTask[] = [];

	let section: "config" | "tasks" | null = null;
	let currentTask: WorkflowTask | null = null;
	let inPrompt = false;
	let promptIndent = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Workflow name from H1
		const h1 = trimmed.match(/^#\s+Workflow:\s*(.+)$/);
		if (h1) {
			name = h1[1].trim();
			continue;
		}

		// Section headers
		if (/^##\s+Config/i.test(trimmed)) {
			if (currentTask) {
				finishTask(currentTask, tasks);
				currentTask = null;
			}
			section = "config";
			inPrompt = false;
			continue;
		}
		if (/^##\s+Tasks/i.test(trimmed)) {
			if (currentTask) {
				finishTask(currentTask, tasks);
				currentTask = null;
			}
			section = "tasks";
			inPrompt = false;
			continue;
		}

		// Config section
		if (section === "config") {
			const configMatch = trimmed.match(/^-\s+(\w+):\s*(.+)$/);
			if (configMatch) {
				const key = configMatch[1].toLowerCase();
				const val = configMatch[2].trim();
				if (key === "base") config.base = val;
				if (key === "parallel") config.parallel = val === "true";
				if (key === "on_conflict" || key === "onconflict") {
					const strategy = val as ConflictStrategy;
					if (["fail", "rebase", "retry"].includes(strategy)) {
						config.onConflict = strategy;
					}
				}
			}
			continue;
		}

		// Tasks section
		if (section === "tasks") {
			// New task (H3)
			const h3 = trimmed.match(/^###\s+(.+)$/);
			if (h3) {
				if (currentTask) finishTask(currentTask, tasks);
				currentTask = {
					name: h3[1].trim(),
					files: [],
					executor: null,
					depends: [],
					prompt: "",
					onConflict: "fail",
				};
				inPrompt = false;
				continue;
			}

			if (!currentTask) continue;

			// Collecting multi-line prompt
			if (inPrompt) {
				// Prompt continues until a line that looks like a new property or section
				if (/^-\s+\w+:/.test(trimmed) || /^###\s+/.test(trimmed)) {
					inPrompt = false;
					// Re-process this line
					i--;
					continue;
				}
				// Dedent based on first prompt line
				const lineContent =
					line.length > promptIndent ? line.slice(promptIndent) : trimmed;
				currentTask.prompt += (currentTask.prompt ? "\n" : "") + lineContent;
				continue;
			}

			// Task properties
			const propMatch = trimmed.match(/^-\s+(\w+):\s*(.*)$/);
			if (propMatch) {
				const key = propMatch[1].toLowerCase();
				const val = propMatch[2].trim();

				if (key === "files") {
					currentTask.files = val
						.split(",")
						.map((f) => f.trim())
						.filter(Boolean);
				} else if (key === "executor") {
					currentTask.executor = val;
				} else if (key === "depends") {
					const depStr = val.replace(/^\[|\]$/g, "");
					currentTask.depends = depStr
						? depStr
								.split(",")
								.map((d) => d.trim())
								.filter(Boolean)
						: [];
				} else if (key === "on_conflict" || key === "onconflict") {
					const strategy = val as ConflictStrategy;
					if (["fail", "rebase", "retry"].includes(strategy)) {
						currentTask.onConflict = strategy;
					}
				} else if (key === "prompt") {
					if (val === "|" || val === "") {
						// Multi-line prompt starts on next line
						inPrompt = true;
						// Detect indent from next non-empty line
						for (let j = i + 1; j < lines.length; j++) {
							if (lines[j].trim()) {
								promptIndent = lines[j].search(/\S/);
								break;
							}
						}
					} else {
						currentTask.prompt = val;
					}
				}
			}
		}
	}

	if (currentTask) finishTask(currentTask, tasks);

	return { name, config, tasks };
}

function finishTask(task: WorkflowTask, tasks: WorkflowTask[]): void {
	task.prompt = task.prompt.trim();
	tasks.push(task);
}

export function validateDAG(tasks: WorkflowTask[]): DAGValidation {
	const names = new Set(tasks.map((t) => t.name));
	const errors: string[] = [];

	// Check missing dependencies
	for (const task of tasks) {
		for (const dep of task.depends) {
			if (!names.has(dep)) {
				errors.push(
					`Task "${task.name}" depends on "${dep}" which does not exist`,
				);
			}
		}
	}

	// Detect cycles via topological sort
	const visited = new Set<string>();
	const stack = new Set<string>();
	const taskMap = Object.fromEntries(tasks.map((t) => [t.name, t]));

	function dfs(name: string): void {
		if (stack.has(name)) {
			errors.push(`Circular dependency detected involving "${name}"`);
			return;
		}
		if (visited.has(name)) return;

		stack.add(name);
		const task = taskMap[name];
		if (task) {
			for (const dep of task.depends) {
				if (names.has(dep)) dfs(dep);
			}
		}
		stack.delete(name);
		visited.add(name);
	}

	for (const task of tasks) {
		dfs(task.name);
	}

	return { valid: errors.length === 0, errors };
}

export function getExecutionPlan(tasks: WorkflowTask[]): WorkflowTask[][] {
	const taskMap = Object.fromEntries(tasks.map((t) => [t.name, t]));
	const remaining = new Set(tasks.map((t) => t.name));
	const completed = new Set<string>();
	const stages: WorkflowTask[][] = [];

	while (remaining.size > 0) {
		// Find tasks whose dependencies are all satisfied
		const ready: WorkflowTask[] = [];
		for (const name of remaining) {
			const task = taskMap[name];
			const depsReady = task.depends.every((d) => completed.has(d));
			if (depsReady) ready.push(task);
		}

		if (ready.length === 0) {
			// Stuck — remaining tasks have unmet deps (cycle should have been caught by validateDAG)
			break;
		}

		stages.push(ready);
		for (const task of ready) {
			remaining.delete(task.name);
			completed.add(task.name);
		}
	}

	return stages;
}

export function listWorkflows(dir: string): WorkflowEntry[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ name: basename(f, ".md"), path: join(dir, f) }));
	} catch {
		return [];
	}
}
