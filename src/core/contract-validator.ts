import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ClaimSet,
	claimMatchesPattern,
	claimSetFromSource,
} from "./claims.js";
import { listChangedFilesAgainstBase, readFileAtRef } from "./git.js";
import type { FileContract } from "./planner.js";

export type ContractViolationType =
	| "outside-contract"
	| "read-only"
	| "shared-append";

export interface ContractViolation {
	type: ContractViolationType;
	file: string;
	pattern: string | null;
	details: string;
}

export interface ContractValidationResult {
	valid: boolean;
	changedFiles: string[];
	violations: ContractViolation[];
}

function findMatchingPattern(
	patterns: string[],
	filePath: string,
): string | null {
	return (
		patterns.find((pattern) => claimMatchesPattern(pattern, filePath)) ?? null
	);
}

function countLines(content: string): number {
	if (content.length === 0) return 0;
	const normalized = content.replace(/\r\n/g, "\n");
	if (normalized.endsWith("\n")) {
		return normalized.slice(0, -1).split("\n").length;
	}
	return normalized.split("\n").length;
}

function validateAppendOnlyChange(
	baseRef: string,
	filePath: string,
	worktreePath: string,
	repoRoot: string,
): { ok: boolean; details?: string } {
	const original = readFileAtRef(baseRef, filePath, repoRoot);
	if (original === null) {
		return { ok: true };
	}

	const currentPath = join(worktreePath, filePath);
	if (!existsSync(currentPath)) {
		return {
			ok: false,
			details: "shared file was deleted or moved",
		};
	}

	const current = readFileSync(currentPath, "utf-8");
	if (current === original) return { ok: true };

	if (!current.startsWith(original)) {
		return {
			ok: false,
			details: "modifies existing content instead of only appending",
		};
	}

	if (countLines(current) < countLines(original)) {
		return {
			ok: false,
			details: "removes existing content instead of only appending",
		};
	}

	return { ok: true };
}

function isClaimSet(value: FileContract | ClaimSet): value is ClaimSet {
	return "ownedPaths" in value;
}

function contractToClaims(contract: FileContract | ClaimSet): ClaimSet {
	if (isClaimSet(contract)) {
		return claimSetFromSource(contract);
	}

	return claimSetFromSource(
		contract.claims || {
			owned: contract.owned,
			sharedAppend: contract.sharedAppend,
			readOnly: contract.readOnly,
		},
	);
}

export function validateContractChanges(
	contract: FileContract | ClaimSet,
	worktreePath: string,
	repoRoot: string,
	baseRef: string,
): ContractValidationResult {
	const changedFiles = listChangedFilesAgainstBase(baseRef, worktreePath);
	const violations: ContractViolation[] = [];
	const claims = contractToClaims(contract);

	for (const file of changedFiles) {
		const ownedPattern = findMatchingPattern(claims.ownedPaths, file);
		if (ownedPattern) {
			continue;
		}

		const readOnlyPattern = findMatchingPattern(claims.readOnlyPaths, file);
		if (readOnlyPattern) {
			violations.push({
				type: "read-only",
				file,
				pattern: readOnlyPattern,
				details: "read-only file was modified",
			});
			continue;
		}

		const sharedPattern = findMatchingPattern(claims.sharedPaths, file);
		if (sharedPattern) {
			const appendCheck = validateAppendOnlyChange(
				baseRef,
				file,
				worktreePath,
				repoRoot,
			);
			if (!appendCheck.ok) {
				violations.push({
					type: "shared-append",
					file,
					pattern: sharedPattern,
					details: appendCheck.details || "shared file was not append-only",
				});
			}
			continue;
		}

		violations.push({
			type: "outside-contract",
			file,
			pattern: null,
			details: "changed file is outside the task contract",
		});
	}

	return {
		valid: violations.length === 0,
		changedFiles,
		violations,
	};
}

export function formatContractViolationReport(
	result: ContractValidationResult,
): string[] {
	return result.violations.map((violation) => {
		const pattern = violation.pattern ? ` (${violation.pattern})` : "";
		return `${violation.file}${pattern}: ${violation.details}`;
	});
}
