import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- Governance Integration ---

export interface GovernanceDetection {
	detected: boolean;
	path: string | null;
	absolute: string | null;
}

export interface Gate {
	command: string;
	classification: "MANDATORY" | "OPTIONAL" | "ADVISORY";
	section: string | null;
	path: string | null;
}

export interface Governance {
	gates: Gate[];
}

export interface GateCommand extends Gate {
	cwd: string;
}

export interface GateRunResult extends GateCommand {
	success: boolean;
	error?: string;
}

export interface GateResult {
	passed: boolean;
	results: GateRunResult[];
	failedGate?: GateRunResult;
}

const GOVERNANCE_PATHS = [".claude/governance.md", "governance.md"];

export function detectGovernance(root: string): GovernanceDetection {
	for (const rel of GOVERNANCE_PATHS) {
		const abs = join(root, rel);
		if (existsSync(abs)) {
			return { detected: true, path: rel, absolute: abs };
		}
	}
	return { detected: false, path: null, absolute: null };
}

export function readGovernance(root: string): Governance | null {
	const gov = detectGovernance(root);
	if (!gov.detected || !gov.absolute) return null;

	const content = readFileSync(gov.absolute, "utf-8");
	return parseGovernance(content);
}

export function parseGovernance(content: string): Governance {
	const gates: Gate[] = [];
	let inGates = false;
	let currentSection: string | null = null;
	let currentPath: string | null = null;

	for (const line of content.split("\n")) {
		// Detect ## Gates section
		if (/^##\s+Gates/i.test(line)) {
			inGates = true;
			continue;
		}

		// Exit gates section on next ## heading
		if (inGates && /^##\s+/.test(line) && !/^##\s+Gates/i.test(line)) {
			inGates = false;
			continue;
		}

		if (!inGates) continue;

		// Parse ### subsection with optional path
		const sectionMatch = line.match(/^###\s+(.+?)(?:\s*\(path:\s*(.+?)\))?$/);
		if (sectionMatch) {
			currentSection = sectionMatch[1].trim();
			currentPath = sectionMatch[2]?.trim() || null;
			continue;
		}

		// Parse gate command: - <command>  # [CLASSIFICATION]
		const gateMatch = line.match(/^-\s+(.+?)(?:\s+#\s*\[(\w+)\])?\s*$/);
		if (gateMatch) {
			const command = gateMatch[1].trim();
			const classification = (
				gateMatch[2] || "MANDATORY"
			).toUpperCase() as Gate["classification"];

			if (!["MANDATORY", "OPTIONAL", "ADVISORY"].includes(classification))
				continue;

			gates.push({
				command,
				classification,
				section: currentSection,
				path: currentPath,
			});
		}
	}

	return { gates };
}

export function buildGateCommands(
	governance: Governance | null,
	worktreePath: string,
): GateCommand[] {
	if (!governance?.gates) return [];

	return governance.gates.map((gate) => ({
		command: gate.command,
		classification: gate.classification,
		section: gate.section,
		path: gate.path,
		cwd: gate.path ? join(worktreePath, gate.path) : worktreePath,
	}));
}

export function runGates(
	governance: Governance,
	worktreePath: string,
): GateResult {
	const commands = buildGateCommands(governance, worktreePath);
	const results: GateRunResult[] = [];
	let passed = true;

	for (const gate of commands) {
		try {
			execSync(gate.command, {
				cwd: gate.cwd,
				encoding: "utf-8",
				stdio: "pipe",
			});
			results.push({ ...gate, success: true });
		} catch (err: unknown) {
			const error =
				(err as { stderr?: string })?.stderr?.trim() ||
				(err instanceof Error ? err.message : String(err));
			const result: GateRunResult = {
				...gate,
				success: false,
				error,
			};
			results.push(result);

			if (gate.classification === "MANDATORY") {
				passed = false;
				return { passed, results, failedGate: result };
			}
			// OPTIONAL and ADVISORY: continue
		}
	}

	return { passed, results };
}
