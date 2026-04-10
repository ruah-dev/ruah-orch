# ruah

[![npm version](https://img.shields.io/npm/v/@ruah-dev/orch)](https://www.npmjs.com/package/@ruah-dev/orch)
[![license](https://img.shields.io/npm/l/@ruah-dev/orch)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

**Multi-agent orchestration that actually coordinates code changes.**

When multiple AI agents work on the same repo, their edits collide. `ruah` gives each task an isolated workspace, tracks claims over the files it is allowed to touch, captures durable artifacts for what changed, and merges everything back in dependency order.

`ruah` uses Git worktrees for isolated task execution and is structured around workspace providers, claims, artifacts, and compatibility checks.

```
  agent 1 ──→ workspace A ──→ src/auth/**  🔒
  agent 2 ──→ workspace B ──→ src/ui/**    🔒
  agent 3 ──→ workspace C ──→ tests/**     🔒
                      │
                      └─→ artifacts + compatibility signals
```

Zero runtime dependencies. Works with Claude Code, Aider, Codex, Cursor, Windsurf, and any CLI.

## What's Included

- task orchestration with isolated workspaces
- canonical claims for owned/shared/read-only file access
- durable task artifacts in state
- compatibility-check engine primitives
- workflow planning with claim-aware contracts
- backward-compatible state migration toward the engine model

## See It

```bash
npx @ruah-dev/cli demo
```

<p align="center">
  <img src="https://raw.githubusercontent.com/ruah-dev/ruah-orch/main/.github/demo.gif" alt="ruah demo" width="100%" />
</p>

Creates a temp repo, shows worktree isolation, file locking, conflict detection, and DAG scheduling — then cleans up. Takes 3 seconds.

## Use It

```bash
# Initialize in any git repo
npx @ruah-dev/cli init

# Create isolated tasks with file locks
ruah task create auth --files "src/auth/**" --executor claude-code --prompt "Add authentication"
ruah task create ui   --files "src/ui/**"   --executor aider       --prompt "Build dashboard"

# Both run in parallel — separate workspaces, isolated edit scopes
ruah task start auth
ruah task start ui

# Merge back (runs governance gates if available)
ruah task done auth && ruah task merge auth
ruah task done ui   && ruah task merge ui
```

Or define a full workflow as a DAG:

```bash
ruah workflow run .ruah/workflows/feature.md
```

## Why Not Just Branches Or Worktrees Alone?

Branches isolate history. Worktrees isolate checkouts. Neither is enough on its own to coordinate concurrent agent execution inside one repo.

- ruah gives each task its own workspace, so agents do not share a checkout
- ruah rejects overlapping lock scopes before agents start
- ruah captures artifacts for what each task actually changed
- ruah can expose compatibility signals and preserved artifacts through state/JSON output
- ruah can validate contract violations before merge instead of discovering them at the end

## Guarantees / Non-Guarantees

ruah currently guarantees:

- workspace isolation per task
- process-safe state writes with stale-write rejection
- lock conflict checks at task creation, resolved against repo files when available
- contract enforcement for read-only and shared-append workflow stages
- durable artifact capture for completed tasks
- backward-compatible migration of older state into the canonical engine model

ruah does not yet guarantee:

- semantic conflict freedom inside arbitrary overlapping code
- perfect prediction for brand-new files that do not exist when locks are taken
- automatic workflow recovery for every interrupted executor without operator input

## How It Works

### 1. Workspace Isolation

Each task gets its own workspace. Currently, that workspace is a Git worktree. The orchestration layer talks to a workspace provider instead of calling raw worktree operations directly.

```
created → in-progress → done → merged
   │          │
   │          └→ failed
   └→ cancelled
```

### 2. Claims And File Locks

Claim scopes are checked at task creation. Overlapping patterns are rejected before any agent starts, using repo files when available:

```bash
ruah task create auth  --files "src/auth/**"   # ✓ locked
ruah task create login --files "src/auth/**"   # ✗ conflict with auth
ruah task create api   --files "src/api/**"    # ✓ no overlap
```

### 3. Workflow DAG And Contracts

Markdown files define task graphs. Independent tasks run in parallel, dependent tasks wait.

```markdown
# Workflow: new-feature

## Config
- base: main
- parallel: true

## Tasks

### backend
- files: src/api/**
- executor: claude-code
- depends: []
- prompt: |
    Build the backend API endpoints.

### frontend
- files: src/ui/**
- executor: claude-code
- depends: []
- prompt: |
    Build the frontend components.

### tests
- files: tests/**
- executor: claude-code
- depends: [backend, frontend]
- prompt: |
    Write integration tests.
```

The DAG is validated (cycle detection, missing refs) before execution. When `parallel: true` is set, `ruah` analyzes claims and overlaps and decides per-stage: full parallel, parallel with modification contracts, or serial. Contracted stages are validated after execution so read-only changes and non-append edits fail before merge.

### 4. Artifacts And Engine State

Successful tasks now persist artifacts into `.ruah/state.json`, including:

- changed files
- patch
- commit metadata
- claims used by the task
- validation results

`ruah status --json` exposes those artifacts and engine flags so higher-level tooling can inspect the orchestration state directly.

### Recovery Example

When a workflow stops on a failed task:

```bash
ruah workflow explain .ruah/workflows/feature.md
ruah task takeover backend --executor codex
ruah workflow resume .ruah/workflows/feature.md
```

`workflow explain` shows the blocking task and the exact takeover and resume commands to run.

### 5. Subagent Spawning

Any running agent can spawn child tasks. Children branch from the parent — not from main — and merge back into the parent first.

```bash
# Inside a running agent:
ruah task create auth-api --parent auth --files "src/auth/api/**" --executor codex
ruah task create auth-ui  --parent auth --files "src/auth/ui/**"  --executor aider

# Children merge into parent, then parent merges into main
```

Parent merge is blocked until all children are merged or cancelled. Each agent receives `RUAH_TASK`, `RUAH_PARENT_TASK`, `RUAH_WORKTREE`, `RUAH_FILES`, and `RUAH_ROOT` as environment variables.

### 6. Executor Adapters

Built-in support for common AI agents.

| Executor | Agent |
|----------|-------|
| `claude-code` | Claude Code CLI |
| `aider` | Aider |
| `codex` | OpenAI Codex CLI |
| `open-code` | OpenCode |
| `script` | Any shell command |
| `raw` | Explicit shell execution via `sh -lc` / `cmd /c` |

### 7. Governance

Auto-detects `.claude/governance.md`. When found, gates run before every merge:

- **MANDATORY** — blocks merge on failure
- **OPTIONAL** — warns, continues
- **ADVISORY** — logs only

### 8. AI Agent Setup

Register ruah with all agents in one command:

```bash
ruah setup
```

Writes integration files for Claude Code, Cursor, Windsurf, Cody, and Continue. After setup, agents auto-detect ruah and know how to orchestrate tasks.

## CLI Reference

```
ruah init [--force]                        Initialize in a git repo
ruah setup [--force]                       Register with AI agents
ruah demo [--fast]                         Interactive demo

ruah task create <name> [options]          Create task with isolated worktree
  --files <globs>                            File patterns to lock
  --base <branch>                            Base branch
  --executor <cmd>                           Agent to run
  --prompt <text>                            Instructions for agent
  --parent <task>                            Create as subtask
  --depends <tasks>                          Upstream dependencies (comma-separated)
  --read-only                                Read-only lock (no conflicts)
ruah task start <name> [--no-exec] [--dry-run] [--force]
ruah task done <name>
ruah task merge <name> [--dry-run] [--skip-gates]
ruah task list [--json]
ruah task claimable [--json]              List tasks ready to claim (deps satisfied)
ruah task children <name> [--json]
ruah task cancel <name>
ruah task retry <name> [--no-exec] [--dry-run]

ruah workflow run <file.md> [--dry-run] [--json]
ruah workflow resume <name|file>
ruah workflow explain <name|file>
ruah workflow plan <file.md> [--json]
ruah workflow list [--json]
ruah workflow create <name> [--force]

ruah status [--json]
ruah config
ruah doctor [--json]
ruah clean [--dry-run] [--force]
```

Every command supports `--json` for programmatic consumption.

## Engine Config

`ruah` can read engine defaults from `.ruahrc` or `package.json#ruah`:

```json
{
  "ruah": {
    "workspaceBackend": "worktree",
    "captureArtifacts": true,
    "enableCompatibilityChecks": true,
    "enablePlannerV2": true,
    "executor": "claude-code"
  }
}
```

`worktree` is the shipped backend.

## Install

Stable release:

```bash
npm install -g @ruah-dev/cli
```

Standalone package:

```bash
npm install -g @ruah-dev/orch
ruah-orch <command>

# or run without installing
npx @ruah-dev/orch <command>
```

**Requirements:** Node.js 18+, Git. Zero runtime dependencies.

## Ecosystem

```
ruah  — top-level CLI router                          (@ruah-dev/cli)
orch  — multi-agent orchestration                     (@ruah-dev/orch)
conv  — API spec → agent tool surfaces                (@ruah-dev/conv)
```

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT
