import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WorkflowTask } from "../src/core/workflow.js";
import {
	getExecutionPlan,
	parseWorkflow,
	validateDAG,
} from "../src/core/workflow.js";

function tmpDir(): string {
	const dir = join(tmpdir(), `ruah-wf-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeWorkflow(dir: string, content: string): string {
	const path = join(dir, "test.md");
	writeFileSync(path, content, "utf-8");
	return path;
}

describe("parseWorkflow", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("extracts name, config, and tasks", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: my-feature

## Config
- base: develop
- parallel: true

## Tasks

### auth
- files: src/auth/**
- executor: claude-code
- depends: []
- prompt: Implement auth

### tests
- files: tests/**
- executor: script
- depends: [auth]
- prompt: Run tests
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.name, "my-feature");
		assert.equal(wf.config.base, "develop");
		assert.equal(wf.config.parallel, true);
		assert.equal(wf.tasks.length, 2);
		assert.equal(wf.tasks[0].name, "auth");
		assert.deepEqual(wf.tasks[0].files, ["src/auth/**"]);
		assert.equal(wf.tasks[0].executor, "claude-code");
		assert.deepEqual(wf.tasks[0].depends, []);
		assert.equal(wf.tasks[0].prompt, "Implement auth");
		assert.equal(wf.tasks[1].name, "tests");
		assert.deepEqual(wf.tasks[1].depends, ["auth"]);
	});

	it("parses multi-line prompts", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: test

## Config
- base: main

## Tasks

### backend
- files: src/**
- executor: claude-code
- depends: []
- prompt: |
    Build the backend API.
    Follow existing patterns.
    Add proper error handling.
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.tasks.length, 1);
		assert.ok(wf.tasks[0].prompt.includes("Build the backend API."));
		assert.ok(wf.tasks[0].prompt.includes("Follow existing patterns."));
		assert.ok(wf.tasks[0].prompt.includes("Add proper error handling."));
	});

	it("handles empty depends list", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: test

## Config
- base: main

## Tasks

### solo
- files: src/**
- executor: script
- depends: []
- prompt: Do stuff
`,
		);

		const wf = parseWorkflow(path);
		assert.deepEqual(wf.tasks[0].depends, []);
	});
});

describe("validateDAG", () => {
	it("valid DAG passes", () => {
		const tasks = [
			{ name: "a", depends: [] },
			{ name: "b", depends: ["a"] },
			{ name: "c", depends: ["a"] },
			{ name: "d", depends: ["b", "c"] },
		] as unknown as WorkflowTask[];
		const result = validateDAG(tasks);
		assert.ok(result.valid);
	});

	it("catches missing dependency reference", () => {
		const tasks = [
			{ name: "a", depends: ["nonexistent"] },
		] as unknown as WorkflowTask[];
		const result = validateDAG(tasks);
		assert.ok(!result.valid);
		assert.ok(result.errors[0].includes("nonexistent"));
	});

	it("catches circular dependencies", () => {
		const tasks = [
			{ name: "a", depends: ["b"] },
			{ name: "b", depends: ["a"] },
		] as unknown as WorkflowTask[];
		const result = validateDAG(tasks);
		assert.ok(!result.valid);
		assert.ok(result.errors.some((e) => e.includes("Circular")));
	});

	it("catches self-dependency", () => {
		const tasks = [{ name: "a", depends: ["a"] }] as unknown as WorkflowTask[];
		const result = validateDAG(tasks);
		assert.ok(!result.valid);
	});
});

describe("getExecutionPlan", () => {
	it("returns correct topological order", () => {
		const tasks = [
			{ name: "a", depends: [] },
			{ name: "b", depends: ["a"] },
			{ name: "c", depends: ["b"] },
		] as unknown as WorkflowTask[];
		const plan = getExecutionPlan(tasks);
		assert.equal(plan.length, 3);
		assert.equal(plan[0][0].name, "a");
		assert.equal(plan[1][0].name, "b");
		assert.equal(plan[2][0].name, "c");
	});

	it("groups independent tasks for parallel execution", () => {
		const tasks = [
			{ name: "a", depends: [] },
			{ name: "b", depends: [] },
			{ name: "c", depends: ["a", "b"] },
		] as unknown as WorkflowTask[];
		const plan = getExecutionPlan(tasks);
		assert.equal(plan.length, 2);
		assert.equal(plan[0].length, 2); // a and b in parallel
		assert.equal(plan[1].length, 1); // c after both
		assert.equal(plan[1][0].name, "c");
	});

	it("handles single task", () => {
		const tasks = [{ name: "solo", depends: [] }] as unknown as WorkflowTask[];
		const plan = getExecutionPlan(tasks);
		assert.equal(plan.length, 1);
		assert.equal(plan[0][0].name, "solo");
	});

	it("handles diamond dependency", () => {
		const tasks = [
			{ name: "a", depends: [] },
			{ name: "b", depends: ["a"] },
			{ name: "c", depends: ["a"] },
			{ name: "d", depends: ["b", "c"] },
		] as unknown as WorkflowTask[];
		const plan = getExecutionPlan(tasks);
		assert.equal(plan.length, 3);
		assert.equal(plan[0].length, 1); // a
		assert.equal(plan[1].length, 2); // b, c parallel
		assert.equal(plan[2].length, 1); // d
	});
});

describe("on_conflict parsing", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses on_conflict from config section", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: conflict-test

## Config
- base: main
- on_conflict: rebase

## Tasks

### task1
- files: src/**
- executor: claude-code
- depends: []
- prompt: Do work
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.config.onConflict, "rebase");
	});

	it("parses on_conflict from task section", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: conflict-test

## Config
- base: main

## Tasks

### task1
- files: src/**
- executor: claude-code
- depends: []
- on_conflict: retry
- prompt: Do work
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.tasks[0].onConflict, "retry");
	});

	it("defaults to fail when not specified", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: default-test

## Config
- base: main

## Tasks

### task1
- files: src/**
- executor: claude-code
- depends: []
- prompt: Do work
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.config.onConflict, "fail");
		assert.equal(wf.tasks[0].onConflict, "fail");
	});

	it("ignores invalid on_conflict values", () => {
		const path = writeWorkflow(
			dir,
			`# Workflow: invalid-test

## Config
- base: main
- on_conflict: explode

## Tasks

### task1
- files: src/**
- executor: claude-code
- depends: []
- on_conflict: kaboom
- prompt: Do work
`,
		);

		const wf = parseWorkflow(path);
		assert.equal(wf.config.onConflict, "fail");
		assert.equal(wf.tasks[0].onConflict, "fail");
	});
});
