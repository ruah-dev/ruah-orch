import type { ParsedArgs } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { getRepoRoot } from "../core/git.js";
import { heading, log, logInfo } from "../utils/format.js";

export async function run(_args: ParsedArgs): Promise<void> {
	const root = getRepoRoot();
	const config = loadConfig(root);

	log(heading("Configuration"));

	const entries = Object.entries(config);
	if (entries.length === 0) {
		logInfo(
			'No configuration found. Create .ruahrc or add "ruah" to package.json.',
		);
		logInfo("");
		logInfo("Example .ruahrc:");
		logInfo("  {");
		logInfo('    "baseBranch": "main",');
		logInfo('    "executor": "claude-code",');
		logInfo('    "timeout": 300');
		logInfo("  }");
		return;
	}

	for (const [key, value] of entries) {
		log(`  ${key}: ${JSON.stringify(value)}`);
	}
}
