import { matchesPattern, patternsOverlap } from "./state.js";

export interface ClaimSet {
	ownedPaths: string[];
	sharedPaths: string[];
	readOnlyPaths: string[];
	ownedSymbols?: string[];
	sharedInterfaces?: string[];
}

export interface ClaimBuckets {
	owned: string[];
	sharedAppend: string[];
	readOnly: string[];
}

export interface ClaimSource {
	owned?: string[] | null;
	sharedAppend?: string[] | null;
	readOnly?: string[] | null;
}

export interface ClaimScopeResult {
	ok: boolean;
	outOfScope: string[];
}

export interface ClaimMatchResult {
	bucket: "owned" | "shared-append" | "read-only" | null;
	pattern: string | null;
}

export interface CompatibilitySignal {
	clean: boolean;
	staleBase?: boolean;
	needsReplay?: boolean;
	conflictingFiles?: string[];
	comparedAgainst?: {
		baseRef?: string;
		taskName?: string;
	};
	checkedAt?: string;
}

function normalizePathPattern(value: string): string {
	return value.replace(/\\/g, "/").trim().replace(/\/+$/, "");
}

function unique(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const candidate = normalizePathPattern(value);
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		result.push(candidate);
	}
	return result;
}

export function emptyClaimSet(): ClaimSet {
	return {
		ownedPaths: [],
		sharedPaths: [],
		readOnlyPaths: [],
	};
}

export function normalizeClaimSet(input?: Partial<ClaimSet> | null): ClaimSet {
	if (!input) return emptyClaimSet();
	return {
		ownedPaths: unique(input.ownedPaths || []),
		sharedPaths: unique(input.sharedPaths || []),
		readOnlyPaths: unique(input.readOnlyPaths || []),
		ownedSymbols: input.ownedSymbols ? unique(input.ownedSymbols) : undefined,
		sharedInterfaces: input.sharedInterfaces
			? unique(input.sharedInterfaces)
			: undefined,
	};
}

export function claimSetFromFiles(
	files: string[] = [],
	lockMode: "read" | "write" = "write",
): ClaimSet {
	if (lockMode === "read") {
		return normalizeClaimSet({
			ownedPaths: [],
			sharedPaths: [],
			readOnlyPaths: files,
		});
	}

	return normalizeClaimSet({
		ownedPaths: files,
		sharedPaths: [],
		readOnlyPaths: [],
	});
}

export function claimSetFromPaths(paths: readonly string[] = []): ClaimSet {
	return normalizeClaimSet({ ownedPaths: [...paths] });
}

export function claimSetFromSource(
	source?: ClaimSource | ClaimSet | null,
): ClaimSet {
	if (!source) return emptyClaimSet();
	if (
		"ownedPaths" in source ||
		"sharedPaths" in source ||
		"readOnlyPaths" in source
	) {
		return normalizeClaimSet(source as Partial<ClaimSet>);
	}
	return normalizeClaimSet({
		ownedPaths: source.owned ?? [],
		sharedPaths: source.sharedAppend ?? [],
		readOnlyPaths: source.readOnly ?? [],
	});
}

export function claimSetToBuckets(claims?: ClaimSet | null): ClaimBuckets {
	if (!claims) {
		return {
			owned: [],
			sharedAppend: [],
			readOnly: [],
		};
	}
	return {
		owned: [...claims.ownedPaths],
		sharedAppend: [...claims.sharedPaths],
		readOnly: [...claims.readOnlyPaths],
	};
}

export function claimSetToFiles(claims?: ClaimSet | null): string[] {
	if (!claims) return [];
	return unique([
		...claims.ownedPaths,
		...claims.sharedPaths,
		...claims.readOnlyPaths,
	]);
}

export function claimedPaths(claims?: ClaimSet | null): string[] {
	return claimSetToFiles(claims);
}

export function claimPatterns(claims: ClaimSet): string[] {
	return claimSetToFiles(claims);
}

export function claimMatchesPattern(
	pattern: string,
	path: string,
	repoRoot?: string,
): boolean {
	return (
		patternsOverlap(pattern, path, repoRoot) || matchesPattern(pattern, path)
	);
}

export function findClaimMatch(
	claims: ClaimSet,
	path: string,
	repoRoot?: string,
): ClaimMatchResult {
	for (const pattern of claims.ownedPaths) {
		if (claimMatchesPattern(pattern, path, repoRoot)) {
			return { bucket: "owned", pattern };
		}
	}
	for (const pattern of claims.sharedPaths) {
		if (claimMatchesPattern(pattern, path, repoRoot)) {
			return { bucket: "shared-append", pattern };
		}
	}
	for (const pattern of claims.readOnlyPaths) {
		if (claimMatchesPattern(pattern, path, repoRoot)) {
			return { bucket: "read-only", pattern };
		}
	}
	return { bucket: null, pattern: null };
}

export function claimSetsOverlap(
	a: ClaimSet,
	b: ClaimSet,
	repoRoot?: string,
): string[] {
	const overlapping: string[] = [];
	const patternsA = claimPatterns(a);
	const patternsB = claimPatterns(b);

	for (const patternA of patternsA) {
		for (const patternB of patternsB) {
			if (!patternsOverlap(patternA, patternB, repoRoot)) continue;
			if (!overlapping.includes(patternA)) overlapping.push(patternA);
			if (!overlapping.includes(patternB)) overlapping.push(patternB);
		}
	}

	return overlapping;
}

export function claimSetWithinScope(
	parent: ClaimSet,
	child: ClaimSet,
	repoRoot?: string,
): ClaimScopeResult {
	const parentPatterns = claimPatterns(parent);
	const childPatterns = claimPatterns(child);

	if (parentPatterns.length === 0) {
		return { ok: true, outOfScope: [] };
	}

	const outOfScope: string[] = [];
	for (const requested of childPatterns) {
		const withinParent = parentPatterns.some((pattern) =>
			patternsOverlap(pattern, requested, repoRoot),
		);
		if (!withinParent) {
			outOfScope.push(requested);
		}
	}

	return { ok: outOfScope.length === 0, outOfScope };
}
