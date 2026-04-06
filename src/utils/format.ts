export type TaskStatus =
	| "created"
	| "in-progress"
	| "done"
	| "merged"
	| "failed"
	| "cancelled";

export interface TaskLike {
	name: string;
	status: TaskStatus;
	files?: string[];
	executor?: string | null;
}

const COLORS: Record<string, string> = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	white: "\x1b[37m",
};

const NO_COLOR = process.env.NO_COLOR !== undefined;

function c(color: string, text: string): string {
	if (NO_COLOR) return text;
	return `${COLORS[color]}${text}${COLORS.reset}`;
}

const STATUS_ICONS: Record<TaskStatus, string> = {
	created: "○",
	"in-progress": "◐",
	done: "●",
	merged: "✓",
	failed: "✗",
	cancelled: "⊘",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
	created: "dim",
	"in-progress": "cyan",
	done: "green",
	merged: "green",
	failed: "red",
	cancelled: "yellow",
};

export function label(): string {
	return c("cyan", "ruah");
}

export function log(msg: string): void {
	console.log(`${c("cyan", "→")} ${msg}`);
}

export function logSuccess(msg: string): void {
	console.log(`${c("green", "✓")} ${msg}`);
}

export function logError(msg: string): void {
	console.error(`${c("red", "✗")} ${msg}`);
}

export function logWarn(msg: string): void {
	console.log(`${c("yellow", "!")} ${msg}`);
}

export function logInfo(msg: string): void {
	console.log(`${c("dim", "·")} ${msg}`);
}

export function formatStatus(status: TaskStatus): string {
	const icon = STATUS_ICONS[status] || "?";
	const color = STATUS_COLORS[status] || "dim";
	return c(color, `${icon} ${status}`);
}

export function formatTask(task: TaskLike): string {
	const status = formatStatus(task.status);
	const files =
		task.files && task.files.length > 0
			? c("dim", ` [${task.files.join(", ")}]`)
			: "";
	const executor = task.executor ? c("dim", ` (${task.executor})`) : "";
	return `  ${status.padEnd(25)} ${c("bold", task.name)}${files}${executor}`;
}

export function formatTaskList(
	tasks: Record<string, TaskLike> | null | undefined,
): string {
	if (!tasks || Object.keys(tasks).length === 0) {
		return c("dim", "  No tasks");
	}
	return Object.values(tasks).map(formatTask).join("\n");
}

export function formatLocks(
	locks: Record<string, string[]> | null | undefined,
): string {
	if (!locks || Object.keys(locks).length === 0) {
		return c("dim", "  No file locks");
	}
	return Object.entries(locks)
		.map(([task, patterns]) => `  ${c("cyan", task)}: ${patterns.join(", ")}`)
		.join("\n");
}

export function formatExecutionPlan(
	plan: Array<Array<{ name: string; depends?: string[] }>>,
): string {
	const lines: string[] = [];
	plan.forEach((stage, i) => {
		const stageLabel = c("bold", `Stage ${i + 1}`);
		const parallel = stage.length > 1 ? c("dim", " (parallel)") : "";
		lines.push(`${stageLabel}${parallel}`);
		stage.forEach((task) => {
			const deps = task.depends?.length
				? c("dim", ` → after ${task.depends.join(", ")}`)
				: "";
			lines.push(`  ${c("cyan", task.name)}${deps}`);
		});
	});
	return lines.join("\n");
}

export function heading(text: string): string {
	return c("bold", text);
}
