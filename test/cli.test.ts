import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(__dirname, "..", "src", "cli.js");
const PACKAGE_JSON = existsSync(join(__dirname, "..", "package.json"))
	? join(__dirname, "..", "package.json")
	: join(__dirname, "..", "..", "package.json");
const PACKAGE_VERSION = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8"))
	.version as string;

function ruah(args: string, cwd: string): string {
	try {
		return execSync(`node "${CLI}" ${args}`, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			env: { ...process.env, NO_COLOR: "1", RUAH_NO_UPDATE_CHECK: "1" },
		});
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string };
		return (e.stdout || "") + (e.stderr || "");
	}
}

function tmpGitRepo(): string {
	const dir = join(tmpdir(), `ruah-cli-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@test.com"', {
		cwd: dir,
		stdio: "pipe",
	});
	execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "hello", "utf-8");
	execSync('git add . && git commit -m "init"', { cwd: dir, stdio: "pipe" });
	return dir;
}

async function waitForTask(
	statePath: string,
	taskName: string,
	timeoutMs = 1000,
): Promise<Record<string, unknown> | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		if (state.tasks[taskName]) {
			return state.tasks[taskName];
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const state = JSON.parse(readFileSync(statePath, "utf-8"));
	return state.tasks[taskName];
}

describe("CLI integration", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpGitRepo();
	});

	afterEach(() => {
		try {
			execSync("git worktree prune", { cwd: repo, stdio: "pipe" });
		} catch {}
		rmSync(repo, { recursive: true, force: true });
	});

	it("--help prints usage", () => {
		const out = ruah("--help", repo);
		assert.ok(out.includes("multi-agent orchestration"));
		assert.ok(out.includes("init [--force]"));
	});

	it("--version prints version", () => {
		const out = ruah("--version", repo);
		assert.ok(out.includes(`ruah-orch ${PACKAGE_VERSION}`));
	});

	it("init creates .ruah directory structure", () => {
		const out = ruah("init", repo);
		assert.ok(out.includes("initialized"));
		assert.ok(existsSync(join(repo, ".ruah", "state.json")));
		assert.ok(existsSync(join(repo, ".ruah", "worktrees")));
		assert.ok(
			existsSync(join(repo, ".ruah", "workflows", "example-feature.md")),
		);
	});

	it("init detects governance when governance.md present", () => {
		mkdirSync(join(repo, ".claude"), { recursive: true });
		writeFileSync(
			join(repo, ".claude", "governance.md"),
			"# Gov\n## Gates\n### Test\n- echo pass  # [MANDATORY]",
			"utf-8",
		);
		const out = ruah("init", repo);
		assert.ok(out.includes("Governance detected"));
	});

	it("task create creates worktree and sets locks", () => {
		ruah("init", repo);
		const out = ruah(
			'task create auth --files "src/auth/**" --executor claude-code',
			repo,
		);
		assert.ok(out.includes('Task "auth" created'));
		assert.ok(out.includes("ruah/auth"));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.ok(state.tasks.auth);
		assert.deepEqual(state.locks.auth, ["src/auth/**"]);
	});

	it("task create rejects conflicting file locks", () => {
		ruah("init", repo);
		ruah('task create a --files "src/auth/**"', repo);
		const out = ruah('task create b --files "src/auth/**"', repo);
		assert.ok(out.includes("lock conflict") || out.includes("overlaps"));
	});

	it("task list --json outputs valid JSON", () => {
		ruah("init", repo);
		ruah('task create test --files "src/**"', repo);
		const out = ruah("task list --json", repo);
		const parsed = JSON.parse(out);
		assert.ok(parsed.test);
		assert.equal(parsed.test.name, "test");
	});

	it("status --json outputs valid JSON with governanceDetected", () => {
		ruah("init", repo);
		const out = ruah("status --json", repo);
		const parsed = JSON.parse(out);
		assert.equal(typeof parsed.governanceDetected, "boolean");
		assert.equal(parsed.engine.workspaceBackend, "worktree");
		assert.equal(typeof parsed.engine.captureArtifacts, "boolean");
		assert.ok(parsed.baseBranch);
		assert.ok(parsed.taskCounts);
	});

	it("doctor --json reports repo health", () => {
		ruah("init", repo);
		const out = ruah("doctor --json", repo);
		const parsed = JSON.parse(out);
		assert.equal(parsed.currentBranch, "main");
		assert.ok(Array.isArray(parsed.checks));
		assert.ok(
			parsed.checks.some((check: { name: string }) => check.name === "git"),
		);
	});

	it("task cancel cleans up worktree and locks", () => {
		ruah("init", repo);
		ruah('task create cancel-me --files "src/x/**"', repo);
		const out = ruah("task cancel cancel-me", repo);
		assert.ok(out.includes("cancelled"));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(state.tasks["cancel-me"].status, "cancelled");
		assert.ok(!state.locks["cancel-me"]);
	});

	it("full lifecycle: create → start → done → merge", () => {
		ruah("init", repo);
		ruah('task create lifecycle --files "src/**"', repo);
		ruah("task start lifecycle --no-exec", repo);
		ruah("task done lifecycle", repo);
		const out = ruah("task merge lifecycle", repo);
		assert.ok(out.includes("merged"));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(state.tasks.lifecycle, undefined);
		assert.ok(!state.locks.lifecycle);
	});

	it("status auto-reconciles done tasks merged outside ruah", () => {
		ruah("init", repo);
		ruah('task create external-merge --files "README.md"', repo);
		ruah("task start external-merge --no-exec", repo);

		const statePath = join(repo, ".ruah", "state.json");
		const before = JSON.parse(readFileSync(statePath, "utf-8"));
		const task = before.tasks["external-merge"];

		writeFileSync(
			join(task.worktree, "README.md"),
			"changed externally",
			"utf-8",
		);
		execSync('git add README.md && git commit -m "external change"', {
			cwd: task.worktree,
			stdio: "pipe",
		});

		// Mark task as done before the external merge
		ruah("task done external-merge", repo);

		execSync(`git checkout ${before.baseBranch}`, { cwd: repo, stdio: "pipe" });
		execSync(
			`git merge ${task.branch} --no-ff -m "manual merge outside ruah"`,
			{
				cwd: repo,
				stdio: "pipe",
			},
		);

		const out = ruah("status --json", repo);
		const parsed = JSON.parse(out);

		assert.equal(parsed.tasks["external-merge"], undefined);
		assert.ok(
			!parsed.worktrees.some((w: { branch?: string }) =>
				w.branch?.includes("ruah/external-merge"),
			),
		);

		const after = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(after.tasks["external-merge"], undefined);
		assert.equal(after.locks["external-merge"], undefined);
	});

	it("status does not auto-reconcile in-progress or created tasks", () => {
		ruah("init", repo);
		ruah('task create fresh-task --files "README.md"', repo);

		// Task exists before status
		const statePath = join(repo, ".ruah", "state.json");
		const before = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.ok(before.tasks["fresh-task"]);

		// Running status should NOT remove the task
		ruah("status --json", repo);

		const after = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.ok(after.tasks["fresh-task"], "fresh task should survive status");
		assert.equal(after.tasks["fresh-task"].status, "created");
	});

	it("status prunes merged tasks already persisted in state", () => {
		ruah("init", repo);
		ruah('task create old-merged --files "README.md"', repo);

		const statePath = join(repo, ".ruah", "state.json");
		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		state.tasks["old-merged"].status = "merged";
		state.tasks["old-merged"].mergedAt = new Date().toISOString();
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

		const out = ruah("status --json", repo);
		const parsed = JSON.parse(out);

		assert.equal(parsed.tasks["old-merged"], undefined);
		const after = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(after.tasks["old-merged"], undefined);
	});

	it("status prunes cancelled tasks whose worktrees are no longer used", () => {
		ruah("init", repo);
		ruah('task create old-cancelled --files "README.md"', repo);
		ruah("task cancel old-cancelled", repo);

		const out = ruah("status --json", repo);
		const parsed = JSON.parse(out);

		assert.equal(parsed.tasks["old-cancelled"], undefined);

		const statePath = join(repo, ".ruah", "state.json");
		const after = JSON.parse(readFileSync(statePath, "utf-8"));
		assert.equal(after.tasks["old-cancelled"], undefined);
	});

	it("subtask create branches from parent", () => {
		ruah("init", repo);
		ruah('task create parent-task --files "src/**"', repo);
		ruah("task start parent-task --no-exec", repo);
		const out = ruah(
			'task create child-task --parent parent-task --files "src/child/**"',
			repo,
		);
		assert.ok(out.includes("Parent: parent-task"));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(state.tasks["child-task"].parent, "parent-task");
		assert.ok(state.tasks["parent-task"].children.includes("child-task"));
		// Subtask baseBranch should be parent's branch, not main
		assert.ok(state.tasks["child-task"].baseBranch.includes("ruah/"));
	});

	it("subtask merge goes into parent branch, not base", () => {
		ruah("init", repo);
		ruah('task create parent2 --files "src/**"', repo);
		ruah("task start parent2 --no-exec", repo);
		ruah('task create child2 --parent parent2 --files "src/child/**"', repo);
		ruah("task start child2 --no-exec", repo);
		ruah("task done child2", repo);
		const out = ruah("task merge child2", repo);
		assert.ok(
			out.toLowerCase().includes("parent"),
			`Expected "parent" in output: ${out}`,
		);
		assert.ok(
			out.toLowerCase().includes("merged"),
			`Expected "merged" in output: ${out}`,
		);
	});

	it("parent merge blocked with unmerged children", () => {
		ruah("init", repo);
		ruah('task create parent3 --files "src/**"', repo);
		ruah("task start parent3 --no-exec", repo);
		ruah('task create child3 --parent parent3 --files "src/child/**"', repo);
		ruah("task done parent3", repo);

		const out = ruah("task merge parent3", repo);
		assert.ok(
			out.toLowerCase().includes("subtask"),
			`Expected merge to be blocked with subtask message: ${out}`,
		);
	});

	it("cancel parent cascades to children", () => {
		ruah("init", repo);
		ruah('task create parent4 --files "src/**"', repo);
		ruah("task start parent4 --no-exec", repo);
		ruah('task create child4 --parent parent4 --files "src/child/**"', repo);
		const out = ruah("task cancel parent4", repo);
		assert.ok(out.includes("cancelled"));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(state.tasks.child4.status, "cancelled");
		assert.equal(state.tasks.parent4.status, "cancelled");
	});

	it("task children lists subtasks", () => {
		ruah("init", repo);
		ruah('task create parent5 --files "src/**"', repo);
		ruah("task start parent5 --no-exec", repo);
		ruah('task create child5a --parent parent5 --files "src/a/**"', repo);
		ruah('task create child5b --parent parent5 --files "src/b/**"', repo);
		const out = ruah("task children parent5 --json", repo);
		const children = JSON.parse(out);
		assert.equal(children.length, 2);
		const names = children.map((c: { name: string }) => c.name);
		assert.ok(names.includes("child5a"));
		assert.ok(names.includes("child5b"));
	});

	it("subtask file locks must be within parent scope", () => {
		ruah("init", repo);
		ruah('task create parent6 --files "src/auth/**"', repo);
		ruah("task start parent6 --no-exec", repo);

		// This should fail — "lib/**" is outside parent's "src/auth/**" scope
		const out = ruah(
			'task create child6 --parent parent6 --files "lib/**"',
			repo,
		);
		assert.ok(
			out.toLowerCase().includes("scope") ||
				out.toLowerCase().includes("conflict"),
			`Expected scope/conflict error: ${out}`,
		);
	});

	it("task takeover lets another executor adopt an active worktree", () => {
		ruah("init", repo);
		ruah('task create handoff --files "src/**" --executor claude-code', repo);
		ruah("task start handoff --no-exec", repo);

		const out = ruah(
			'task takeover handoff --executor codex --prompt "echo resumed" --no-exec',
			repo,
		);
		assert.ok(out.includes('Task "handoff" taken over'));

		const state = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		);
		assert.equal(state.tasks.handoff.status, "in-progress");
		assert.equal(state.tasks.handoff.executor, "codex");
		assert.equal(state.tasks.handoff.prompt, "echo resumed");
		assert.ok(
			state.history.some(
				(entry: { action: string }) => entry.action === "task.taken_over",
			),
		);
	});

	it("workflow run persists workflow metadata for later takeover", async () => {
		ruah("init", repo);
		const baseBranch = JSON.parse(
			readFileSync(join(repo, ".ruah", "state.json"), "utf-8"),
		).baseBranch;
		const workflowPath = join(repo, ".ruah", "workflows", "handoff.md");
		writeFileSync(
			workflowPath,
			`# Workflow: Handoff Test

## Config
- base: ${baseBranch}
- parallel: false

## Tasks

### recoverable
- files: README.md
- executor: script
- depends: []
- prompt: false
`,
			"utf-8",
		);

		ruah(`workflow run ${workflowPath}`, repo);

		const statePath = join(repo, ".ruah", "state.json");
		const recoverable = await waitForTask(statePath, "recoverable");
		assert.ok(recoverable);
		assert.equal(recoverable.status, "failed");
		assert.deepEqual(recoverable.workflow, {
			name: "Handoff Test",
			path: workflowPath,
			stage: 1,
			depends: [],
		});
	});

	it("workflow plan applies configured maxParallel batching", () => {
		ruah("init", repo);
		writeFileSync(join(repo, ".ruahrc"), JSON.stringify({ maxParallel: 2 }));
		const workflowPath = join(repo, ".ruah", "workflows", "batched.md");
		writeFileSync(
			workflowPath,
			`# Workflow: Batching Test

## Config
- base: main
- parallel: true

## Tasks

### one
- files: src/one.ts
- executor: claude-code
- depends: []
- prompt: Task one

### two
- files: src/two.ts
- executor: claude-code
- depends: []
- prompt: Task two

### three
- files: src/three.ts
- executor: claude-code
- depends: []
- prompt: Task three

### four
- files: src/four.ts
- executor: claude-code
- depends: []
- prompt: Task four
`,
			"utf-8",
		);

		const out = ruah(`workflow plan ${workflowPath}`, repo);
		assert.ok(out.includes("batch 1/2 (capped at 2 parallel)"));
		assert.ok(out.includes("batch 2/2 (capped at 2 parallel)"));
	});

	it("workflow run --debug-exec streams prefixed task output", () => {
		ruah("init", repo);
		const workflowPath = join(repo, ".ruah", "workflows", "debug-exec.md");
		writeFileSync(
			workflowPath,
			`# Workflow: Debug Exec

## Config
- base: main
- parallel: true

## Tasks

### one
- files: src/one.ts
- executor: script
- depends: []
- prompt: node -e "process.stdout.write('one-ready\\\\n')"

### two
- files: src/two.ts
- executor: script
- depends: []
- prompt: node -e "process.stdout.write('two-ready\\\\n')"
`,
			"utf-8",
		);

		const out = ruah(`workflow run ${workflowPath} --debug-exec`, repo);
		assert.ok(out.includes("Execution debug enabled"));
		assert.ok(out.includes("Spawn one: node -e"));
		assert.ok(out.includes("Spawn two: node -e"));
		assert.ok(out.includes("[one stdout] one-ready"));
		assert.ok(out.includes("[two stdout] two-ready"));
	});
});
