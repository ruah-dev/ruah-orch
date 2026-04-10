import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE_NAME = "@ruah-dev/orch";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = join(homedir(), ".ruah");
const CACHE_FILE = join(CACHE_DIR, "update-check.json");

interface CacheData {
	lastCheck: number;
	latestVersion: string | null;
}

function readCache(): CacheData | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as CacheData;
	} catch {
		return null;
	}
}

function writeCache(data: CacheData): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(data), "utf-8");
	} catch {
		// Silent — cache is best-effort
	}
}

function fetchLatestVersion(): Promise<string | null> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(null), 3000);

		const req = get(
			`https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
			{ headers: { Accept: "application/json" } },
			(res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => {
					data += chunk;
				});
				res.on("end", () => {
					clearTimeout(timeout);
					try {
						const json = JSON.parse(data) as { version?: string };
						resolve(json.version || null);
					} catch {
						resolve(null);
					}
				});
			},
		);

		req.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}

function compareVersions(current: string, latest: string): number {
	const a = current.split(".").map(Number);
	const b = latest.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((a[i] || 0) < (b[i] || 0)) return -1;
		if ((a[i] || 0) > (b[i] || 0)) return 1;
	}
	return 0;
}

export interface UpdateInfo {
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion: string;
}

export async function checkForUpdate(
	currentVersion: string,
): Promise<UpdateInfo | null> {
	const cache = readCache();
	const now = Date.now();

	// Use cache if fresh
	if (
		cache &&
		now - cache.lastCheck < CHECK_INTERVAL_MS &&
		cache.latestVersion
	) {
		if (compareVersions(currentVersion, cache.latestVersion) < 0) {
			return {
				updateAvailable: true,
				currentVersion,
				latestVersion: cache.latestVersion,
			};
		}
		return null;
	}

	// Fetch in background — don't block CLI
	const latest = await fetchLatestVersion();
	if (latest) {
		writeCache({ lastCheck: now, latestVersion: latest });
		if (compareVersions(currentVersion, latest) < 0) {
			return {
				updateAvailable: true,
				currentVersion,
				latestVersion: latest,
			};
		}
	}

	return null;
}

export function formatUpdateBanner(info: UpdateInfo): string {
	const yellow = "\x1b[33m";
	const cyan = "\x1b[36m";
	const bold = "\x1b[1m";
	const dim = "\x1b[2m";
	const reset = "\x1b[0m";

	return [
		"",
		`${yellow}╭──────────────────────────────────────────╮${reset}`,
		`${yellow}│${reset}  Update available: ${dim}${info.currentVersion}${reset} → ${bold}${cyan}${info.latestVersion}${reset}${" ".repeat(Math.max(0, 18 - info.currentVersion.length - info.latestVersion.length))}${yellow}│${reset}`,
		`${yellow}│${reset}  Run ${cyan}npm install -g @ruah-dev/orch${reset}       ${yellow}│${reset}`,
		`${yellow}╰──────────────────────────────────────────╯${reset}`,
		"",
	].join("\n");
}
