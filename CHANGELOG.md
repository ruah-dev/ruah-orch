# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-04-06

### Added
- **`ruah workflow resume`** — halted workflows can now continue from preserved task state instead of recreating already-completed or recoverable work.
- **Planner history scoring** — stage planning now considers prior contract violations and merge conflicts when deciding whether to parallelize or serialize work.

### Changed
- **Executor safety** — raw shell execution is now explicit via the `raw` executor; unknown executors no longer fall back to arbitrary shell commands.
- **Script argument parsing** — the `script` executor now preserves quoted arguments instead of splitting only on whitespace.
- **Recovery UX** — workflow failure and explain output now shows the exact `task takeover` and `workflow resume` commands to run next.

## [0.4.0] - 2026-04-06

### Added
- **Contract enforcement** — workflow tasks running with modification contracts are now validated after execution, with read-only edits, out-of-contract changes, and non-append shared-file edits blocked before merge.
- **Concurrency-safe state writes** — `.ruah/state.json` now uses a process lock, stale-lock recovery, and optimistic revision checks so concurrent commands fail cleanly instead of silently overwriting state.
- **Version parity test** — CLI version output is now checked against package metadata so release drift is caught in tests.

### Changed
- **CLI version source of truth** — `ruah --version` and update checks now read directly from package metadata instead of a hardcoded string.
- **Lock overlap detection** — task and planner overlap checks now resolve against repo files when available, falling back only when the repo cannot provide concrete matches.
- **README guarantees** — absolute conflict language was softened to match the current enforcement model.

## [0.3.0] - 2026-04-06

### Added
- **Smart planner** — overlap analyzer that decides per-stage: parallel, parallel-with-contracts, or serial. Agents receive modification contracts in `.ruah-task.md` specifying owned, shared-append, and read-only file boundaries.
- **`ruah clean`** — remove stale tasks and orphaned locks from aborted workflows. Supports `--dry-run` and `--force` flags.
- **Parallelism cap** — `maxParallel` config option (default: 5) limits concurrent tasks per stage.
- **Runtime conflict detection** — `checkMergeConflicts()` uses `git merge-tree` for read-only conflict checks between branches.
- **`on_conflict` strategy** — per-task and per-workflow conflict handling: `fail` (default), `rebase`, or `retry`.
- **Codex MCP adapter** — `codex-mcp` executor connects to Codex MCP server via JSON-RPC, falls back to CLI.

### Fixed
- Workflow abort now auto-cleans failed stage tasks instead of leaving orphaned locks

## [0.2.0] - 2026-04-06

### Added
- **`ruah task retry <name>`** — re-execute failed tasks without recreating worktrees. Supports `--dry-run` and `--no-exec` flags.
- **`ruah config`** — display resolved project configuration
- **Config file support** — load project defaults from `.ruahrc` (JSON) or `package.json` `"ruah"` section. Supports `baseBranch`, `executor`, `timeout`, `files`, `skipGates`, and `parallel`. `.ruahrc` takes precedence.
- **`ruah workflow create <name>`** — scaffold workflow markdown files from a built-in template with config, parallel tasks, and dependency examples. Supports `--force` to overwrite.

### Changed
- Task create and workflow run now read defaults from config file when CLI flags are not provided

## [0.1.1] - 2026-04-06

### Added
- **`ruah setup`** — registers ruah with AI coding agents (Claude Code, Cursor, Windsurf, Cody, Continue) so they auto-detect and use it
- **Update notifications** — non-blocking npm registry check every 24 hours, cached in `~/.ruah/`, disable with `RUAH_NO_UPDATE_CHECK=1`
- **CI/CD pipelines** — GitHub Actions for gates (lint + typecheck + test), PR checks, and auto-publish on tag push
- **GitHub Releases** — auto-created with release notes on version tag push

### Changed
- **Full TypeScript rewrite** — all 11 source files and 6 test files converted to strict TypeScript
- Compiled output ships in `dist/` instead of raw `src/`
- CI upgraded to Node 20
- Biome config added (`biome.json`) to exclude compiled output from linting

## [0.1.0] - 2026-04-05

### Added
- **Task lifecycle** — `create`, `start`, `done`, `merge`, `cancel` with git worktree isolation per task
- **Workflow engine** — markdown-defined DAGs with parallel execution and dependency ordering
- **File locks** — advisory glob-based locks preventing edit conflicts between agents
- **Executor adapters** — built-in support for Claude Code, Aider, Codex, OpenCode, and shell scripts
- **Subagent spawning** — agents can create subtasks that branch from the parent's worktree
- **crag integration** — auto-enforces governance gates (MANDATORY/OPTIONAL/ADVISORY) on merge
- **arhy integration** — detects `.arhy` contract files for file boundary inference
- **JSON output** — every command supports `--json` for programmatic consumption
- **Status dashboard** — `ruah status` shows tasks, locks, worktrees, and integrations
- Zero runtime dependencies
