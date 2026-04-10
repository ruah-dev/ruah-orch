# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0-alpha] - 2026-04-08

### Added
- **Workspace provider abstraction** — task and workflow execution now run through a canonical workspace provider contract, with `worktree` as the current production backend.
- **Canonical task engine model** — tasks now track workspace metadata, claims, artifacts, and integration status in addition to the legacy `branch`, `worktree`, and `files` fields.
- **Artifact capture** — successful tasks persist durable task artifacts with changed files, patches, commit metadata, claims, and validation results.
- **Compatibility engine primitives** — Git-backed artifact/base and artifact/artifact comparison helpers classify clean, conflicting, and stale execution states.
- **State migration layer** — `.ruah/state.json` now migrates older task records forward into the canonical engine shape while preserving backward readability.
- **Engine JSON visibility** — `ruah status --json`, `ruah doctor --json`, and `ruah config` now expose engine configuration, artifact presence, and canonical workspace metadata.
- **Release-grade engine tests** — added direct test coverage for state migration, workspace provider behavior, artifact capture, and compatibility checks.

### Changed
- **Planner and contract system** now operate on canonical claims while preserving the previous path-based behavior when compatibility signals are absent.
- **Task and workflow commands** now use workspace handles internally instead of directly coupling orchestration logic to raw worktree calls.
- **README positioning** now reflects `ruah` as an alpha orchestration engine, not only a worktree wrapper.

### Notes
- `worktree` remains the only shipped backend in `1.0.0-alpha`.
- Legacy task fields remain readable for backward compatibility during the engine transition.

## [0.4.3] - 2026-04-07

### Added
- **Read-only locks** — `ruah task create audit --files "src/**" --read-only` creates tasks that never conflict with any lock. Read-only tasks get worktree snapshot isolation, so they can safely overlap with readers and writers. This prevents the "bypass ruah with raw agents" escape hatch when dispatching audit/analysis tasks.
- **`lockMode` field on Task** — `"read" | "write"` (defaults to `"write"`). Tracked in `state.lockModes` for conflict resolution. Backward-compatible — existing tasks default to write.

### Changed
- **Lock conflict resolution** — `acquireLocks` now checks lock modes: read↔read and read↔write skip conflict checks entirely (snapshot isolation via worktree). Only write↔write still conflicts.
- **`releaseLocks`** now cleans up `lockModes` alongside `locks` and `lockSnapshots`.

## [0.4.2] - 2026-04-07

### Added
- **Dependency gate on `task start`** — tasks with upstream dependencies are blocked from starting until all deps are `done` or `merged`, preventing deadlocks when multiple agents independently claim adjacent DAG tasks. Use `--force` to override.
- **`ruah task claimable`** — new subcommand listing all `created` tasks whose upstream dependencies are fully satisfied — the set of tasks an agent can safely claim right now. Supports `--json`.
- **`--depends` flag on `task create`** — `ruah task create integration --depends backend,frontend` adds explicit upstream dependencies to ad-hoc tasks outside workflows. References are validated at creation time.
- **`depends` field on Task** — first-class dependency tracking on every task, not just workflow metadata. Backfilled from `workflow.depends` for existing state files.

### Changed
- **Workflow runner** now propagates `depends` from workflow task definitions onto created Task objects, so dependency info is available for distributed claiming even after the centralized runner creates tasks.
- **State parser** backfills `depends: []` on tasks from older state files for backward compatibility.

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
- **governance integration** — auto-enforces governance gates (MANDATORY/OPTIONAL/ADVISORY) on merge
- **arhy integration** — detects `.arhy` contract files for file boundary inference
- **JSON output** — every command supports `--json` for programmatic consumption
- **Status dashboard** — `ruah status` shows tasks, locks, worktrees, and integrations
- Zero runtime dependencies
