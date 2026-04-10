import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Governance } from "../src/core/integrations.js";
import {
	buildGateCommands,
	detectGovernance,
	parseGovernance,
	runGates,
} from "../src/core/integrations.js";

function tmpDir(): string {
	const dir = join(tmpdir(), `ruah-int-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("governance detection", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpDir();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns false when governance.md absent", () => {
		const result = detectGovernance(dir);
		assert.ok(!result.detected);
	});

	it("detects .claude/governance.md", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(join(dir, ".claude", "governance.md"), "# Gov", "utf-8");
		const result = detectGovernance(dir);
		assert.ok(result.detected);
		assert.equal(result.path, ".claude/governance.md");
	});

	it("detects root governance.md", () => {
		writeFileSync(join(dir, "governance.md"), "# Gov", "utf-8");
		const result = detectGovernance(dir);
		assert.ok(result.detected);
		assert.equal(result.path, "governance.md");
	});
});

describe("parseGovernance", () => {
	it("extracts gates with classifications", () => {
		const content = `# Governance

## Gates (run in order)
### Lint
- npx eslint src/ --max-warnings 0          # [MANDATORY]

### Type check
- npx tsc --noEmit                           # [MANDATORY]

### Format check
- npx prettier --check src/                  # [OPTIONAL]

### Audit
- npm audit                                  # [ADVISORY]
`;

		const result = parseGovernance(content);
		assert.equal(result.gates.length, 4);
		assert.equal(result.gates[0].command, "npx eslint src/ --max-warnings 0");
		assert.equal(result.gates[0].classification, "MANDATORY");
		assert.equal(result.gates[0].section, "Lint");
		assert.equal(result.gates[2].classification, "OPTIONAL");
		assert.equal(result.gates[3].classification, "ADVISORY");
	});

	it("defaults to MANDATORY when no classification", () => {
		const content = `## Gates
### Build
- npm run build
`;
		const result = parseGovernance(content);
		assert.equal(result.gates.length, 1);
		assert.equal(result.gates[0].classification, "MANDATORY");
	});

	it("handles path annotations on sections", () => {
		const content = `## Gates
### Frontend (path: packages/frontend)
- npm test  # [MANDATORY]
`;
		const result = parseGovernance(content);
		assert.equal(result.gates[0].path, "packages/frontend");
		assert.equal(result.gates[0].section, "Frontend");
	});
});

describe("buildGateCommands", () => {
	it("produces correct command list with cwd", () => {
		const governance: Governance = {
			gates: [
				{
					command: "npm test",
					classification: "MANDATORY",
					section: "Tests",
					path: null,
				},
				{
					command: "npm run lint",
					classification: "OPTIONAL",
					section: "Lint",
					path: "frontend",
				},
			],
		};
		const commands = buildGateCommands(governance, "/work");
		assert.equal(commands.length, 2);
		assert.equal(commands[0].cwd, "/work");
		assert.equal(commands[1].cwd, join("/work", "frontend"));
	});
});

describe("runGates", () => {
	it("passes when all commands succeed", () => {
		const governance: Governance = {
			gates: [
				{
					command: "true",
					classification: "MANDATORY",
					section: "Pass",
					path: null,
				},
			],
		};
		const result = runGates(governance, "/tmp");
		assert.ok(result.passed);
		assert.equal(result.results.length, 1);
		assert.ok(result.results[0].success);
	});

	it("fails on mandatory gate failure", () => {
		const governance: Governance = {
			gates: [
				{
					command: "false",
					classification: "MANDATORY",
					section: "Fail",
					path: null,
				},
			],
		};
		const result = runGates(governance, "/tmp");
		assert.ok(!result.passed);
		assert.ok(result.failedGate);
	});

	it("continues on optional gate failure", () => {
		const governance: Governance = {
			gates: [
				{
					command: "false",
					classification: "OPTIONAL",
					section: "Opt",
					path: null,
				},
				{
					command: "true",
					classification: "MANDATORY",
					section: "Must",
					path: null,
				},
			],
		};
		const result = runGates(governance, "/tmp");
		assert.ok(result.passed);
		assert.ok(!result.results[0].success);
		assert.ok(result.results[1].success);
	});

	it("continues on advisory gate failure", () => {
		const governance: Governance = {
			gates: [
				{
					command: "false",
					classification: "ADVISORY",
					section: "Adv",
					path: null,
				},
			],
		};
		const result = runGates(governance, "/tmp");
		assert.ok(result.passed);
	});
});
