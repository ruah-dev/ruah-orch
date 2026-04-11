import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE_NAME = "@ruah-dev/orch";

function resolveCliEntrypoint() {
	try {
		const packageJsonPath = require.resolve("@ruah-dev/cli/package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.ruah;
		return resolve(dirname(packageJsonPath), bin ?? "dist/cli.js");
	} catch {
		return null;
	}
}

export function getGlobalBinDir(env = process.env, platform = process.platform) {
	const prefix = env.npm_config_prefix;
	if (!prefix) {
		return null;
	}
	return platform === "win32" ? prefix : join(prefix, "bin");
}

export function buildUnixLauncher(cliPath) {
	const escapedPath = cliPath.replace(/'/g, `'\"'\"'`);
	return `#!/usr/bin/env sh\nexec node '${escapedPath}' \"$@\"\n`;
}

export function installGlobalLauncher(options = {}) {
	const {
		env = process.env,
		platform = process.platform,
		log = console,
		cliPath = resolveCliEntrypoint(),
	} = options;

	if (
		env.npm_config_global !== "true" &&
		env.npm_config_location !== "global"
	) {
		return { status: "skipped", reason: "not-global" };
	}

	if (!cliPath) {
		log.warn(
			`[${PACKAGE_NAME}] Installed without @ruah-dev/cli. Install @ruah-dev/cli directly for the top-level \`ruah\` command.`,
		);
		return { status: "skipped", reason: "missing-cli" };
	}

	const binDir = getGlobalBinDir(env, platform);
	if (!binDir) {
		log.warn(
			`[${PACKAGE_NAME}] Installed @ruah-dev/cli but could not determine the global bin directory. Reinstall @ruah-dev/cli directly if \`ruah\` is missing.`,
		);
		return { status: "skipped", reason: "missing-bin-dir" };
	}

	const launcherPath = join(binDir, platform === "win32" ? "ruah.cmd" : "ruah");

	try {
		mkdirSync(binDir, { recursive: true });

		if (existsSync(launcherPath)) {
			return { status: "exists", launcherPath };
		}

		if (platform === "win32") {
			writeFileSync(launcherPath, `@ECHO OFF\r\nnode "${cliPath}" %*\r\n`, "utf8");
			return { status: "installed", launcherPath };
		}

		writeFileSync(launcherPath, buildUnixLauncher(cliPath), "utf8");
		chmodSync(launcherPath, 0o755);
		return { status: "installed", launcherPath };
	} catch (error) {
		if (error?.code === "EEXIST" && existsSync(launcherPath)) {
			return { status: "exists", launcherPath };
		}

		log.warn(
			`[${PACKAGE_NAME}] Could not install the global \`ruah\` launcher at ${launcherPath}: ${error.message}`,
		);
		return { status: "skipped", reason: "launcher-install-failed", launcherPath, error };
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	installGlobalLauncher();
}
