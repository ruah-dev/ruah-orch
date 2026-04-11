import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	buildUnixLauncher,
	getGlobalBinDir,
	installGlobalLauncher,
} from "../postinstall.mjs";

test("getGlobalBinDir resolves unix global bins", () => {
	assert.equal(
		getGlobalBinDir(
			{ npm_config_prefix: "/tmp/ruah", npm_config_global: "true" },
			"darwin",
		),
		"/tmp/ruah/bin",
	);
});

test("buildUnixLauncher delegates to node", () => {
	const launcher = buildUnixLauncher("/tmp/ruah cli/dist/cli.js");
	assert.match(launcher, /exec node '/);
	assert.match(launcher, /dist\/cli\.js/);
});

test("installGlobalLauncher creates a missing unix bin directory", () => {
	const prefix = mkdtempSync(join(tmpdir(), "ruah-orch-postinstall-"));
	const result = installGlobalLauncher({
		env: {
			npm_config_global: "true",
			npm_config_prefix: prefix,
		},
		platform: "darwin",
		cliPath: "/tmp/ruah-cli/dist/cli.js",
		log: { warn() {} },
	});

	const launcherPath = join(prefix, "bin", "ruah");
	assert.equal(result.status, "installed");
	assert.equal(result.launcherPath, launcherPath);
	assert.equal(existsSync(launcherPath), true);
	assert.match(readFileSync(launcherPath, "utf8"), /ruah-cli\/dist\/cli\.js/);
});

test("installGlobalLauncher preserves an existing launcher", () => {
	const prefix = mkdtempSync(join(tmpdir(), "ruah-orch-postinstall-"));
	const launcherPath = join(prefix, "bin", "ruah");

	mkdirSync(dirname(launcherPath), { recursive: true });
	writeFileSync(launcherPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");

	const result = installGlobalLauncher({
		env: {
			npm_config_global: "true",
			npm_config_prefix: prefix,
		},
		platform: "darwin",
		cliPath: "/tmp/ruah-cli/dist/cli.js",
		log: { warn() {} },
	});

	assert.equal(result.status, "exists");
	assert.equal(
		readFileSync(launcherPath, "utf8"),
		"#!/usr/bin/env sh\nexit 0\n",
	);
});
