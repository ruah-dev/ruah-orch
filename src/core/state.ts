import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TaskStatus } from "../utils/format.js";
import type { TaskArtifact } from "./artifact.js";
import { type ClaimSet, claimSetFromFiles, claimSetToFiles } from "./claims.js";
import { listRepoFiles } from "./git.js";
import { migrateStateShape } from "./state-migrations.js";
import type { WorkspaceHandle } from "./workspace.js";

export interface WorkflowRef {
	name: string;
	path: string;
	stage: number;
	depends: string[];
}

export type LockMode = "read" | "write";

export interface Task {
	name: string;
	status: TaskStatus;
	baseBranch: string;
	workspace?: WorkspaceHandle | null;
	claims?: ClaimSet | null;
	artifact?: TaskArtifact | null;
	integration?: {
		status: "unknown" | "clean" | "conflict" | "stale";
		conflictsWith: string[];
		lastCheckedAt?: string;
	} | null;
	branch: string;
	worktree: string;
	files: string[];
	/** Lock mode — "read" tasks never conflict (snapshot isolation via worktree) */
	lockMode: LockMode;
	executor: string | null;
	prompt: string | null;
	parent: string | null;
	children: string[];
	/** Explicit upstream dependencies — task cannot start until all are done/merged */
	depends: string[];
	repoRoot?: string;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	mergedAt: string | null;
	workflow?: WorkflowRef | null;
}

export interface HistoryEntry {
	timestamp: string;
	action: string;
	[key: string]: unknown;
}

export interface RuahState {
	version: number;
	revision: number;
	baseBranch: string;
	tasks: Record<string, Task>;
	artifacts: Record<string, TaskArtifact>;
	locks: Record<string, string[]>;
	/** Per-task lock mode: "read" or "write" (absent = "write" for backward compat) */
	lockModes: Record<string, LockMode>;
	lockSnapshots: Record<string, Record<string, string[]>>;
	history: HistoryEntry[];
}

export interface LockConflict {
	task: string;
	pattern: string;
	requested: string;
}

export interface LockResult {
	success: boolean;
	conflicts: LockConflict[];
	outOfScope?: boolean;
	ambiguous?: boolean;
}

const MAX_HISTORY = 200;
const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_POLL_MS = 50;

function defaultState(): RuahState {
	return {
		version: 1,
		revision: 0,
		baseBranch: "main",
		tasks: {},
		artifacts: {},
		locks: {},
		lockModes: {},
		lockSnapshots: {},
		history: [],
	};
}

export function ensureStateDir(root: string): string {
	const ruahDir = join(root, ".ruah");
	mkdirSync(ruahDir, { recursive: true });
	mkdirSync(join(ruahDir, "worktrees"), { recursive: true });
	mkdirSync(join(ruahDir, "workflows"), { recursive: true });
	return ruahDir;
}

export function statePath(root: string): string {
	return join(root, ".ruah", "state.json");
}

export function stateLockPath(root: string): string {
	return join(root, ".ruah", "state.lock");
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseState(raw: string, root: string): RuahState {
	const parsed = migrateStateShape(JSON.parse(raw) as Partial<RuahState>, root);
	const tasks = parsed.tasks || {};
	// Backfill fields for tasks created before dependency/lockMode tracking
	for (const task of Object.values(tasks)) {
		if (!task.depends) {
			(task as Task).depends = (task as Task).workflow?.depends ?? [];
		}
		if (!task.lockMode) {
			(task as Task).lockMode = "write";
		}
		if (!task.claims) {
			task.claims = claimSetFromFiles(task.files || [], task.lockMode);
		}
		if (!task.files) {
			task.files = claimSetToFiles(task.claims);
		}
		if (task.workspace) {
			task.worktree = task.workspace.root;
			task.branch =
				task.workspace.metadata?.branchName ||
				task.workspace.headRef ||
				task.branch;
		}
		if (!task.integration) {
			task.integration = {
				status: "unknown",
				conflictsWith: [],
			};
		}
		if (!task.artifact && parsed.artifacts?.[task.name]) {
			task.artifact = parsed.artifacts[task.name];
		}
	}
	return {
		...defaultState(),
		...parsed,
		revision: typeof parsed.revision === "number" ? parsed.revision : 0,
		tasks,
		artifacts: parsed.artifacts || {},
		locks: parsed.locks || {},
		lockModes: parsed.lockModes || {},
		lockSnapshots: parsed.lockSnapshots || {},
		history: parsed.history || [],
	};
}

function acquireStateWriteLock(root: string): () => void {
	const lockFile = stateLockPath(root);
	mkdirSync(dirname(lockFile), { recursive: true });
	const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;

	while (true) {
		try {
			const fd = openSync(lockFile, "wx");
			writeFileSync(
				fd,
				JSON.stringify({
					pid: process.pid,
					acquiredAt: new Date().toISOString(),
				}),
				"utf-8",
			);
			closeSync(fd);
			return () => {
				rmSync(lockFile, { force: true });
			};
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") {
				throw err;
			}

			try {
				const age = Date.now() - statSync(lockFile).mtimeMs;
				if (age > STATE_LOCK_STALE_MS) {
					rmSync(lockFile, { force: true });
					continue;
				}
			} catch {
				continue;
			}

			if (Date.now() >= deadline) {
				throw new Error(
					"State is locked by another ruah process. Wait for it to finish and retry.",
				);
			}
			sleep(STATE_LOCK_POLL_MS);
		}
	}
}

export function loadState(root: string): RuahState {
	const file = statePath(root);
	if (!existsSync(file)) {
		return defaultState();
	}
	const raw = readFileSync(file, "utf-8");
	return parseState(raw, root);
}

export function saveState(root: string, state: RuahState): void {
	const file = statePath(root);
	mkdirSync(dirname(file), { recursive: true });
	const releaseLock = acquireStateWriteLock(root);

	try {
		const current = existsSync(file)
			? parseState(readFileSync(file, "utf-8"), root)
			: defaultState();
		if (state.revision !== current.revision) {
			throw new Error(
				"State changed on disk while this command was running. Re-run the command.",
			);
		}

		migrateStateShape(state, root);

		const nextState: RuahState = {
			...state,
			version: 2,
			revision: current.revision + 1,
		};
		const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
		renameSync(tmp, file);
		state.revision = nextState.revision;
	} finally {
		releaseLock();
	}
}

export function addHistoryEntry(
	state: RuahState,
	action: string,
	details: Record<string, unknown> = {},
): void {
	state.history.push({
		timestamp: new Date().toISOString(),
		action,
		...details,
	});
	if (state.history.length > MAX_HISTORY) {
		state.history = state.history.slice(-MAX_HISTORY);
	}
}

export function acquireLocks(
	state: RuahState,
	taskName: string,
	filePatterns: string[],
	parentName?: string | null,
	repoRoot?: string,
	strict?: boolean,
	lockMode: LockMode = "write",
): LockResult {
	if (!filePatterns || filePatterns.length === 0) {
		return { success: true, conflicts: [] };
	}

	if (strict && repoRoot) {
		const ambiguousPatterns = filePatterns.filter(
			(pattern) =>
				hasGlobSyntax(pattern) &&
				resolvePatternMatches(pattern, repoRoot).length === 0,
		);
		if (ambiguousPatterns.length > 0) {
			return {
				success: false,
				conflicts: ambiguousPatterns.map((pattern) => ({
					task: taskName,
					pattern: "strict lock validation",
					requested: pattern,
				})),
				ambiguous: true,
			};
		}
	}

	// If this is a subtask, validate locks are within parent's scope
	if (parentName) {
		const parentLocks = state.locks[parentName];
		if (parentLocks && parentLocks.length > 0) {
			const outOfScope: string[] = [];
			for (const requested of filePatterns) {
				const withinParent = parentLocks.some((pl) =>
					patternsOverlap(pl, requested, repoRoot),
				);
				if (!withinParent) {
					outOfScope.push(requested);
				}
			}
			if (outOfScope.length > 0) {
				return {
					success: false,
					conflicts: outOfScope.map((p) => ({
						task: parentName,
						pattern: `parent scope: ${parentLocks.join(", ")}`,
						requested: p,
					})),
					outOfScope: true,
				};
			}
		}
	}

	// Read-only tasks never conflict — they operate on a worktree snapshot
	// and cannot interfere with readers or writers.
	// Write↔write still conflicts (existing behavior).
	const conflicts: LockConflict[] = [];
	if (lockMode === "write") {
		for (const [owner, owned] of Object.entries(state.locks)) {
			if (owner === taskName) continue;
			// Subtasks of the same parent don't conflict with the parent itself
			if (parentName && owner === parentName) continue;
			// Read-only lock holders don't block writers — snapshot isolation
			const ownerMode = state.lockModes[owner] || "write";
			if (ownerMode === "read") continue;
			// Sibling subtasks can conflict with each other
			for (const existing of owned) {
				for (const requested of filePatterns) {
					if (patternsOverlap(existing, requested, repoRoot)) {
						conflicts.push({ task: owner, pattern: existing, requested });
					}
				}
			}
		}
	}

	if (conflicts.length > 0) {
		return { success: false, conflicts };
	}

	state.locks[taskName] = filePatterns;
	state.lockModes[taskName] = lockMode;
	if (repoRoot) {
		state.lockSnapshots[taskName] = Object.fromEntries(
			filePatterns.map((pattern) => [
				pattern,
				resolvePatternMatches(pattern, repoRoot),
			]),
		);
	}
	return { success: true, conflicts: [] };
}

export function getChildren(state: RuahState, parentName: string): Task[] {
	return Object.values(state.tasks).filter((t) => t.parent === parentName);
}

export function getUnmergedChildren(
	state: RuahState,
	parentName: string,
): Task[] {
	return getChildren(state, parentName).filter(
		(t) => t.status !== "merged" && t.status !== "cancelled",
	);
}

export function getTaskLineage(state: RuahState, taskName: string): string[] {
	const lineage: string[] = [];
	let current: string | null = taskName;
	while (current) {
		const task: Task | undefined = state.tasks[current];
		if (!task) break;
		lineage.unshift(current);
		current = task.parent || null;
	}
	return lineage;
}

export function releaseLocks(state: RuahState, taskName: string): void {
	delete state.locks[taskName];
	if (state.lockModes) {
		delete state.lockModes[taskName];
	}
	if (state.lockSnapshots) {
		delete state.lockSnapshots[taskName];
	}
}

export function removeTask(state: RuahState, taskName: string): void {
	releaseLocks(state, taskName);

	for (const task of Object.values(state.tasks)) {
		if (task.children?.includes(taskName)) {
			task.children = task.children.filter((child) => child !== taskName);
		}
	}

	delete state.tasks[taskName];
}

function normalizePattern(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function hasGlobSyntax(value: string): boolean {
	return /[*?[\]{}]/.test(value);
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegex(char);
	}
	source += "$";
	return new RegExp(source);
}

function globPrefix(pattern: string): string {
	const match = pattern.match(/^[^*?[\]{}]*/);
	return (match?.[0] || "").replace(/\/+$/, "");
}

function filesIntersect(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const files = new Set(a);
	return b.some((file) => files.has(file));
}

function resolvePatternMatches(pattern: string, repoRoot?: string): string[] {
	if (!repoRoot) return [];
	const files = listRepoFiles(repoRoot);
	if (files.length === 0) return [];
	return files.filter((file) => matchesPattern(pattern, file));
}

export function matchesPattern(pattern: string, path: string): boolean {
	const normalizedPattern = normalizePattern(pattern);
	const normalizedPath = normalizePattern(path);

	if (!hasGlobSyntax(normalizedPattern)) {
		return (
			normalizedPattern === normalizedPath ||
			normalizedPath.startsWith(`${normalizedPattern}/`)
		);
	}

	return globToRegExp(normalizedPattern).test(normalizedPath);
}

// --- Dependency / Claimability ---

export interface ClaimCheck {
	claimable: boolean;
	/** Dependency task names that are not yet done/merged */
	blockedBy: string[];
}

const COMPLETED_STATUSES = new Set<TaskStatus>(["done", "merged"]);

/**
 * Check whether a task's upstream dependencies are all satisfied.
 * A task is claimable when every entry in its `depends` array is
 * done or merged (or has been removed from state, i.e. already merged
 * and cleaned up).
 */
export function isTaskClaimable(
	state: RuahState,
	taskName: string,
): ClaimCheck {
	const task = state.tasks[taskName];
	if (!task) return { claimable: false, blockedBy: [taskName] };

	const blockedBy: string[] = [];
	for (const dep of task.depends) {
		const depTask = state.tasks[dep];
		// If the dep no longer exists in state it was already merged + removed
		if (depTask && !COMPLETED_STATUSES.has(depTask.status as TaskStatus)) {
			blockedBy.push(dep);
		}
	}

	return { claimable: blockedBy.length === 0, blockedBy };
}

/**
 * Return all tasks in "created" status whose upstream dependencies are
 * fully satisfied — the set of tasks an agent can safely claim right now.
 */
export function getClaimableTasks(state: RuahState): Task[] {
	return Object.values(state.tasks).filter((task) => {
		if (task.status !== "created") return false;
		return isTaskClaimable(state, task.name).claimable;
	});
}

export function patternsOverlap(
	a: string,
	b: string,
	repoRoot?: string,
): boolean {
	if (a === b) return true;

	const normA = normalizePattern(a);
	const normB = normalizePattern(b);

	if (normA === normB) return true;

	const matchedA = resolvePatternMatches(normA, repoRoot);
	const matchedB = resolvePatternMatches(normB, repoRoot);
	if (matchedA.length > 0 && matchedB.length > 0) {
		return filesIntersect(matchedA, matchedB);
	}

	const aIsGlob = hasGlobSyntax(normA);
	const bIsGlob = hasGlobSyntax(normB);

	if (aIsGlob && bIsGlob) {
		const prefixA = globPrefix(normA);
		const prefixB = globPrefix(normB);
		if (!prefixA || !prefixB) return true;
		return (
			prefixA === prefixB ||
			prefixA.startsWith(`${prefixB}/`) ||
			prefixB.startsWith(`${prefixA}/`)
		);
	}

	if (aIsGlob) {
		return matchesPattern(normA, normB);
	}
	if (bIsGlob) {
		return matchesPattern(normB, normA);
	}

	return normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`);
}
