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

	return config;
}
