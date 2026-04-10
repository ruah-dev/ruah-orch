import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.js";

const NO_COLOR = process.env.NO_COLOR !== undefined;

function c(color: string, text: string): string {
	if (NO_COLOR) return text;
	const codes: Record<string, string> = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[32m",
		red: "\x1b[31m",
		yellow: "\x1b[33m",
		magenta: "\x1b[35m",
	};
	return `${codes[color] ?? ""}${text}${codes.reset}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function line(text = ""): void {
	console.log(text);
}

function step(text: string): void {
	console.log(`  ${c("cyan", "→")} ${text}`);
}

function ok(text: string): void {
	console.log(`  ${c("green", "✓")} ${text}`);
}

function dim(text: string): string {
	return c("dim", text);
}

function box(lines: string[]): void {
	const W = 60;
	console.log(`  ┌${"─".repeat(W)}┐`);
	for (const l of lines) {
		console.log(`  │ ${l}`);
	}
	console.log(`  └${"─".repeat(W)}┘`);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching ESC control char
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function pad(text: string, w: number): string {
	const visible = text.replace(ANSI_RE, "");
	const diff = w - visible.length;
	return diff > 0 ? `${text}${" ".repeat(diff)}` : text;
}

const W = 58; // inner width (box width 60 - 2 for padding)

export async function run(_args: ParsedArgs): Promise<void> {
	const fast = _args.flags.fast === true;
	const delay = fast ? 0 : 120;

	line();
	line(
		`  ${c("bold", c("cyan", "ruah"))} ${dim("— multi-agent orchestration")}`,
	);
	line();
	line(`  ${c("bold", "The problem:")} two AI agents edit the same file`);
	line(`  ${dim("→ merge conflict, lost work, broken code")}`);
	line();
	line(
		`  ${c("bold", "The fix:")} each agent gets its own worktree + file lock`,
	);
	line(`  ${dim("→ zero interference, clean merges, parallel speed")}`);
	line();

	await sleep(delay * 3);

	// ── Setup ──────────────────────────────────────────────
	step("Setting up demo repo...");
	const dir = join(tmpdir(), `ruah-demo-${randomBytes(4).toString("hex")}`);
	mkdirSync(dir, { recursive: true });

	try {
		execSync("git init", { cwd: dir, stdio: "pipe" });
		execSync('git config user.email "demo@ruah.dev"', {
			cwd: dir,
			stdio: "pipe",
		});
		execSync('git config user.name "ruah demo"', {
			cwd: dir,
			stdio: "pipe",
		});

		for (const f of [
			"src/auth/login.ts",
			"src/auth/session.ts",
			"src/ui/dashboard.tsx",
			"src/ui/sidebar.tsx",
			"tests/auth.test.ts",
			"tests/ui.test.ts",
		]) {
			mkdirSync(join(dir, f, ".."), { recursive: true });
			writeFileSync(join(dir, f), `// ${f}\n`, "utf-8");
		}
		execSync('git add . && git commit -m "init"', {
			cwd: dir,
			stdio: "pipe",
		});

		ok("Demo repo ready");
		await sleep(delay * 2);

		// ── Create Tasks ─────────────────────────────────────
		line();
		step("Creating 3 parallel tasks with file locks...");
		await sleep(delay);

		const tasks = [
			{ name: "auth-api", files: "src/auth/**", executor: "claude-code" },
			{ name: "dashboard-ui", files: "src/ui/**", executor: "aider" },
			{ name: "test-suite", files: "tests/**", executor: "codex" },
		];

		const taskLines: string[] = [];
		for (const t of tasks) {
			const name = c("bold", t.name.padEnd(14));
			const files = dim(t.files.padEnd(14));
			const lock = c("yellow", "🔒 locked");
			const ex = dim(`(${t.executor})`);
			taskLines.push(
				pad(`${c("green", "✓")} ${name} ${files} ${lock} ${ex}`, W),
			);
		}
		taskLines.push(
			pad(dim("Each task → own git worktree → zero interference"), W),
		);
		box(taskLines);
		await sleep(delay * 3);

		// ── Conflict Detection ───────────────────────────────
		line();
		step("What if a 4th agent tries to touch locked files?");
		await sleep(delay * 2);

		const conflictLines: string[] = [];
		conflictLines.push(
			pad(
				`${c("red", "✗")} ${c("bold", "api-v2")}         src/auth/**  ${c("red", "BLOCKED")}`,
				W,
			),
		);
		conflictLines.push(
			pad(
				`  ${dim("↳ conflicts with")} ${c("cyan", "auth-api")}${dim("'s lock")}`,
				W,
			),
		);
		conflictLines.push(
			pad(dim("File locks catch conflicts before agents start."), W),
		);
		box(conflictLines);
		await sleep(delay * 3);

		// ── Workflow DAG ─────────────────────────────────────
		line();
		step("Defining a workflow DAG...");
		await sleep(delay * 2);

		const dagLines: string[] = [];
		dagLines.push(pad(c("bold", "Workflow: new-feature"), W));
		dagLines.push(pad("", W));
		dagLines.push(pad(`  ${c("cyan", "auth-api")}    ──┐`, W));
		dagLines.push(
			pad(`                   ├──→  ${c("magenta", "test-suite")}`, W),
		);
		dagLines.push(pad(`  ${c("green", "dashboard-ui")} ──┘`, W));
		dagLines.push(pad("", W));
		dagLines.push(
			pad(
				`  ${c("bold", "Stage 1")} ${dim("(parallel)")}  auth-api, dashboard-ui`,
				W,
			),
		);
		dagLines.push(
			pad(
				`  ${c("bold", "Stage 2")} ${dim("(sequential)")} test-suite ${dim("→ after both")}`,
				W,
			),
		);
		dagLines.push(pad(dim("Define in markdown. ruah handles the rest."), W));
		box(dagLines);
		await sleep(delay * 2);

		// ── Real Commands ────────────────────────────────────
		line();
		line(`  ${c("bold", "Try it yourself:")}`);
		line(`    ${c("cyan", "$")} npx @ruah-dev/orch init`);
		line(
			`    ${c("cyan", "$")} ruah task create auth --files "src/auth/**" --executor claude-code`,
		);
		line(`    ${c("cyan", "$")} ruah workflow run feature.md`);
		line();

		// ── Cleanup ──────────────────────────────────────────
		rmSync(dir, { recursive: true, force: true });
		ok(`Demo repo cleaned up ${dim(`(was ${dir})`)}`);
		line();
	} catch (err) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
		throw err;
	}
}
