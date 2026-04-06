import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "../cli.js";
import { getCurrentBranch, getRepoRoot, isGitRepo } from "../core/git.js";
import { detectCrag } from "../core/integrations.js";
import {
	ensureStateDir,
	loadState,
	saveState,
	statePath,
} from "../core/state.js";
import { label, log, logError, logInfo, logSuccess } from "../utils/format.js";

const GITIGNORE = `worktrees/
state.json
`;

const EXAMPLE_WORKFLOW = `# Workflow: example-feature

## Config
- base: main
- parallel: true

## Tasks

### backend-api
- files: src/api/**, src/models/**
- executor: claude-code
- depends: []
- prompt: |
    Implement the backend API endpoints.
    Follow existing patterns in the codebase.

### frontend-ui
- files: src/components/**, src/pages/**
- executor: claude-code
- depends: []
- prompt: |
    Build the frontend UI components.
    Use existing design system components.

### integration-tests
- files: tests/**
- executor: claude-code
- depends: [backend-api, frontend-ui]
- prompt: |
    Write integration tests for the new feature.
    Cover both API and UI interactions.
`;

export async function run(args: ParsedArgs): Promise<void> {
	const force = args.flags.force;

	if (!isGitRepo()) {
		logError("Not a git repository. Run git init first.");
		process.exit(1);
	}

	const root = getRepoRoot();
	const stateFile = statePath(root);

	if (existsSync(stateFile) && !force) {
		logError(".ruah already initialized. Use --force to reinitialize.");
		process.exit(1);
	}

	const branch = getCurrentBranch();

	// Create directory structure
	ensureStateDir(root);

	// Write initial state
	const state = loadState(root);
	state.baseBranch = branch;
	saveState(root, state);

	// Write .gitignore
	writeFileSync(join(root, ".ruah", ".gitignore"), GITIGNORE, "utf-8");

	// Write example workflow
	const workflowPath = join(root, ".ruah", "workflows", "example-feature.md");
	if (!existsSync(workflowPath) || force) {
		writeFileSync(workflowPath, EXAMPLE_WORKFLOW, "utf-8");
	}

	logSuccess(`${label()} initialized`);
	log(`Base branch: ${branch}`);
	logInfo("State: .ruah/state.json");
	logInfo("Workflows: .ruah/workflows/");
	logInfo("Worktrees: .ruah/worktrees/");

	// Detect crag
	const crag = detectCrag(root);
	if (crag.detected) {
		logSuccess(
			`crag detected (${crag.path}) — gates will be enforced on merge`,
		);
	} else {
		logInfo("crag not detected — operating standalone");
	}

	console.log("");
	log("Next steps:");
	logInfo('ruah task create <name> --files "src/**" --executor claude-code');
	logInfo("ruah workflow run .ruah/workflows/example-feature.md");
}
