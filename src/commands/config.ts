import type { ParsedArgs } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { getRepoRoot } from "../core/git.js";
import { heading, log, logInfo } from "../utils/format.js";

export async function run(_args: ParsedArgs): Promise<void> {
	const root = getRepoRoot();
	const config = loadConfig(root);

	log(heading("Configuration"));

	for (const [key, value] of Object.entries(config)) {
		log(`  ${key}: ${JSON.stringify(value)}`);
	}

	logInfo("");
	logInfo(
		"Config source precedence: .ruahrc, then package.json#ruah, then defaults.",
	);
}
