import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- crag Integration ---

export interface CragDetection {
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

export interface ArhyDetection {
	detected: boolean;
	files: string[];
}

export interface ArhyField {
	name: string;
	type: string;
}

export interface ArhyEntity {
	name: string;
	fields: ArhyField[];
	actions: string[];
	events: string[];
}

export interface ArhyContract {
	entities: ArhyEntity[];
}

const GOVERNANCE_PATHS = [".claude/governance.md", "governance.md"];

export function detectCrag(root: string): CragDetection {
	for (const rel of GOVERNANCE_PATHS) {
		const abs = join(root, rel);
		if (existsSync(abs)) {
			return { detected: true, path: rel, absolute: abs };
		}
	}
	return { detected: false, path: null, absolute: null };
}

export function readCragGovernance(root: string): Governance | null {
	const crag = detectCrag(root);
	if (!crag.detected || !crag.absolute) return null;

	const content = readFileSync(crag.absolute, "utf-8");
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

// --- arhy Integration ---

export function detectArhy(root: string): ArhyDetection {
	try {
		const files = readdirSync(root).filter((f) => f.endsWith(".arhy"));
		if (files.length > 0) {
			return { detected: true, files: files.map((f) => join(root, f)) };
		}
	} catch {
		// ignore
	}
	return { detected: false, files: [] };
}

export function readArhyContract(filePath: string): ArhyContract | null {
	if (!existsSync(filePath)) return null;

	const content = readFileSync(filePath, "utf-8");
	return parseArhyContract(content);
}

export function parseArhyContract(content: string): ArhyContract {
	const entities: ArhyEntity[] = [];
	let current: ArhyEntity | null = null;

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Entity definition
		const entityMatch = trimmed.match(/^entity\s+(\w+)\s*\{?\s*$/);
		if (entityMatch) {
			if (current) entities.push(current);
			current = {
				name: entityMatch[1],
				fields: [],
				actions: [],
				events: [],
			};
			continue;
		}

		// Closing brace
		if (trimmed === "}") {
			if (current) entities.push(current);
			current = null;
			continue;
		}

		if (!current) continue;

		// Action
		const actionMatch = trimmed.match(/^action\s+(\w+)/);
		if (actionMatch) {
			current.actions.push(actionMatch[1]);
			continue;
		}

		// Event
		const eventMatch = trimmed.match(/^event\s+(\w+)/);
		if (eventMatch) {
			current.events.push(eventMatch[1]);
			continue;
		}

		// Field (simple: name: type)
		const fieldMatch = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
		if (fieldMatch) {
			current.fields.push({
				name: fieldMatch[1],
				type: fieldMatch[2].trim(),
			});
		}
	}

	if (current) entities.push(current);
	return { entities };
}

export function inferFileBoundaries(
	contract: ArhyContract | null,
): Record<string, string[]> {
	if (!contract?.entities) return {};

	const boundaries: Record<string, string[]> = {};
	for (const entity of contract.entities) {
		const lower = entity.name.toLowerCase();
		const plural = lower.endsWith("s") ? lower : `${lower}s`;
		boundaries[entity.name] = [
			`src/${lower}/**`,
			`src/${plural}/**`,
			`src/models/${lower}.*`,
			`src/controllers/${lower}.*`,
			`src/routes/${lower}.*`,
		];
	}
	return boundaries;
}
