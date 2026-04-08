import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuahConfig {
	/** Default base branch for new tasks (default: from state, typically "main") */
	baseBranch?: string;
	/** Default executor for new tasks */
	executor?: string;
	/** Default task timeout in seconds */
	timeout?: number;
	/** Default file patterns */
	files?: string[];
	/** Skip crag gates by default */
	skipGates?: boolean;
	/** Parallel execution in workflows */
	parallel?: boolean;
	/** Maximum number of tasks to run in parallel per stage (default: 5) */
	maxParallel?: number;
	/** Reject lock globs that cannot be resolved to concrete repo files */
	strictLocks?: boolean;
	/** Execution workspace backend */
	workspaceBackend?: "worktree";
	/** Persist task artifacts after successful execution */
	captureArtifacts?: boolean;
	/** Enable speculative compatibility checks */
	enableCompatibilityChecks?: boolean;
	/** Enable planner v2 compatibility-aware scheduling */
	enablePlannerV2?: boolean;
}

const EMPTY_CONFIG: RuahConfig = {};

/**
 * Load config from .ruahrc (JSON) or package.json "ruah" section.
 * .ruahrc takes precedence over package.json.
 * Returns empty config if neither exists.
 */
export function loadConfig(root: string): RuahConfig {
	// Try .ruahrc first
	const rcPath = join(root, ".ruahrc");
	if (existsSync(rcPath)) {
		try {
			const raw = readFileSync(rcPath, "utf-8");
			return validateConfig(JSON.parse(raw));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Invalid .ruahrc: ${msg}`);
		}
	}

	// Try package.json "ruah" section
	const pkgPath = join(root, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const raw = readFileSync(pkgPath, "utf-8");
			const pkg = JSON.parse(raw);
			if (pkg.ruah && typeof pkg.ruah === "object") {
				return validateConfig(pkg.ruah);
			}
		} catch {
			// package.json parse error — ignore ruah section
		}
	}

	return EMPTY_CONFIG;
}

function validateConfig(raw: unknown): RuahConfig {
	if (!raw || typeof raw !== "object") return EMPTY_CONFIG;

	const obj = raw as Record<string, unknown>;
	const config: RuahConfig = {};

	if (typeof obj.baseBranch === "string") config.baseBranch = obj.baseBranch;
	if (typeof obj.executor === "string") config.executor = obj.executor;
	if (typeof obj.timeout === "number" && obj.timeout > 0)
		config.timeout = obj.timeout;
	if (Array.isArray(obj.files)) {
		config.files = obj.files.filter((f): f is string => typeof f === "string");
	}
	if (typeof obj.skipGates === "boolean") config.skipGates = obj.skipGates;
	if (typeof obj.parallel === "boolean") config.parallel = obj.parallel;
	if (typeof obj.maxParallel === "number" && obj.maxParallel > 0)
		config.maxParallel = Math.floor(obj.maxParallel);
	if (typeof obj.strictLocks === "boolean")
		config.strictLocks = obj.strictLocks;
	if (obj.workspaceBackend === "worktree")
		config.workspaceBackend = obj.workspaceBackend;
	if (typeof obj.captureArtifacts === "boolean")
		config.captureArtifacts = obj.captureArtifacts;
	if (typeof obj.enableCompatibilityChecks === "boolean")
		config.enableCompatibilityChecks = obj.enableCompatibilityChecks;
	if (typeof obj.enablePlannerV2 === "boolean")
		config.enablePlannerV2 = obj.enablePlannerV2;

	return config;
}
