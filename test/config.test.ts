import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/core/config.js";

function tmpRoot(): string {
	const dir = join(tmpdir(), `ruah-test-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("config", () => {
	let root: string;

	beforeEach(() => {
		root = tmpRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns empty config when no files exist", () => {
		const config = loadConfig(root);
		assert.deepEqual(config, {});
	});

	it("loads .ruahrc when present", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({
				baseBranch: "develop",
				executor: "aider",
				timeout: 600,
			}),
		);
		const config = loadConfig(root);
		assert.equal(config.baseBranch, "develop");
		assert.equal(config.executor, "aider");
		assert.equal(config.timeout, 600);
	});

	it("loads ruah section from package.json", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "test",
				ruah: { baseBranch: "staging", executor: "codex" },
			}),
		);
		const config = loadConfig(root);
		assert.equal(config.baseBranch, "staging");
		assert.equal(config.executor, "codex");
	});

	it(".ruahrc takes precedence over package.json", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({ baseBranch: "develop" }),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "test",
				ruah: { baseBranch: "staging" },
			}),
		);
		const config = loadConfig(root);
		assert.equal(config.baseBranch, "develop");
	});

	it("ignores invalid types in config", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({
				baseBranch: 123,
				executor: true,
				timeout: "abc",
			}),
		);
		const config = loadConfig(root);
		assert.equal(config.baseBranch, undefined);
		assert.equal(config.executor, undefined);
		assert.equal(config.timeout, undefined);
	});

	it("throws on malformed .ruahrc JSON", () => {
		writeFileSync(join(root, ".ruahrc"), "not json {{{");
		assert.throws(() => loadConfig(root), /Invalid \.ruahrc/);
	});

	it("loads files array from config", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({ files: ["src/**", "lib/**"] }),
		);
		const config = loadConfig(root);
		assert.deepEqual(config.files, ["src/**", "lib/**"]);
	});

	it("filters non-string entries from files array", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({ files: ["src/**", 42, null, "lib/**"] }),
		);
		const config = loadConfig(root);
		assert.deepEqual(config.files, ["src/**", "lib/**"]);
	});

	it("ignores package.json without ruah section", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "test", version: "1.0.0" }),
		);
		const config = loadConfig(root);
		assert.deepEqual(config, {});
	});

	it("validates boolean fields", () => {
		writeFileSync(
			join(root, ".ruahrc"),
			JSON.stringify({ skipGates: true, parallel: false }),
		);
		const config = loadConfig(root);
		assert.equal(config.skipGates, true);
		assert.equal(config.parallel, false);
	});

	it("ignores negative timeout", () => {
		writeFileSync(join(root, ".ruahrc"), JSON.stringify({ timeout: -10 }));
		const config = loadConfig(root);
		assert.equal(config.timeout, undefined);
	});
});
