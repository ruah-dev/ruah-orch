# ruah

Multi-agent orchestration CLI. Workspace isolation, DAG scheduling, file locking, merge coordination.

When multiple AI agents (Claude Code, Aider, Codex, etc.) work on the same codebase simultaneously, their edits collide. ruah solves this with git worktrees for isolation, a DAG scheduler for task ordering, advisory file locks to prevent conflicts, and dependency-ordered merging.

## Install

```bash
npm install -g @levi-tc/ruah
```

## Quick Start

```bash
# Initialize in any git repo
ruah init

# Register with AI agents (Claude Code, Cursor, Windsurf, etc.)
ruah setup

# Create isolated tasks with file locks
ruah task create auth --files "src/auth/**" --executor claude-code --prompt "Implement authentication"
ruah task create api --files "src/api/**" --executor aider --prompt "Build REST API"

# Start tasks (each runs in its own worktree)
ruah task start auth
ruah task start api

# When done, merge back (runs governance gates if available)
ruah task done auth
ruah task merge auth

# Or run a full workflow from a file
ruah workflow run .ruah/workflows/feature.md
```

## Features

### Task Lifecycle

Full lifecycle management with git worktree isolation per task.

```
created → in-progress → done → merged
   │          │
   │          └→ failed
   └→ cancelled
```

- Each task gets its own branch and worktree — zero interference between agents
- Advisory file locks prevent two tasks from editing the same files
- Cascading cancel: cancelling a parent cancels all subtasks
- JSON output on every command for programmatic consumption

### Workflow Engine

Markdown files define a DAG of tasks with dependencies. Independent tasks run in parallel, dependent tasks wait for their prerequisites.

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

The DAG is validated (cycle detection, missing dependency checks) before execution.

### File Locks

Advisory locks checked at task creation. Overlapping file patterns are rejected:

```bash
ruah task create auth --files "src/auth/**"   # ✓
ruah task create login --files "src/auth/**"  # ✗ conflict
ruah task create api --files "src/api/**"     # ✓ no overlap
```

Glob-based pattern matching with directory containment detection.

### Executor Adapters

Built-in adapters for common AI coding agents:

| Executor | Tool |
|----------|------|
| `claude-code` | Claude Code CLI |
| `aider` | Aider |
| `codex` | OpenAI Codex CLI |
| `open-code` | OpenCode CLI |
| `script` | Any shell command |

Unknown executor names are treated as raw shell commands.

### Subagent Spawning

Any agent running inside a task can spawn subtasks. Subtasks get their own worktrees, branched from the parent's branch — not from base.

```bash
# Parent creates subtasks (from within a running agent's CLI)
ruah task create auth-api --parent auth --files "src/auth/api/**" --executor codex --prompt "Build auth API"
ruah task create auth-ui --parent auth --files "src/auth/ui/**" --executor aider --prompt "Build auth UI"

# Subtasks run in parallel
ruah task start auth-api
ruah task start auth-ui

# Subtasks merge into parent branch
ruah task done auth-api && ruah task merge auth-api
ruah task done auth-ui && ruah task merge auth-ui

# Parent merges into base (all children must be merged first)
ruah task done auth && ruah task merge auth
```

**How it works:**
- `--parent <task>` branches from the parent's worktree branch, not base
- Subtask file locks must be within the parent's lock scope
- Subtask merges go into the parent branch (gates deferred to parent merge)
- Parent merge is blocked until all children are merged or cancelled
- Each executor receives env vars: `RUAH_TASK`, `RUAH_PARENT_TASK`, `RUAH_ROOT`, `RUAH_FILES`, `RUAH_WORKTREE`
- A `.ruah-task.md` is written into each worktree with subtask spawning instructions

**Works with any CLI** — the env vars and task file are executor-agnostic. Claude Code, Codex, Aider, OpenCode, or any custom script can read them and call `ruah task create --parent $RUAH_TASK`.

### crag Integration

Auto-detects crag by looking for `.claude/governance.md`. When found, gates are enforced on `task merge` and `workflow run`:

- **MANDATORY** gates block the merge on failure
- **OPTIONAL** gates warn but continue
- **ADVISORY** gates log results only

Use `--skip-gates` for emergencies.

### arhy Integration

Detects `.arhy` contract files for system boundary definitions. Used for inferring file lock boundaries from entity contracts.

### AI Agent Setup

Register ruah with all AI coding agents in your project:

```bash
ruah setup
```

This writes integration files for:
- **Claude Code** — skill in `.claude/skills/ruah-orchestrator/`
- **Cursor** — rule in `.cursor/rules/ruah.mdc`
- **Windsurf** — appends to `.windsurfrules`
- **Cody** — instructions in `.sourcegraph/ruah-instructions.md`
- **Continue** — rule in `.continue/rules/ruah.md`

After setup, AI agents auto-detect ruah and know how to use it.

### Update Notifications

ruah checks npm for updates once every 24 hours (non-blocking, cached in `~/.ruah/`). When a new version is available, a banner appears after command output. Disable with `RUAH_NO_UPDATE_CHECK=1`.

## CLI Reference

```
ruah init [--force]
ruah setup [--force]
ruah task create <name> [--files <globs>] [--base <branch>] [--executor <cmd>] [--prompt <text>] [--parent <task>]
ruah task start <name> [--no-exec] [--dry-run]
ruah task done <name>
ruah task merge <name> [--dry-run] [--skip-gates]
ruah task list [--json]
ruah task children <name> [--json]
ruah task cancel <name>
ruah workflow run <file.md> [--dry-run] [--json]
ruah workflow plan <file.md> [--json]
ruah workflow list [--json]
ruah status [--json]
```

Every command supports `--json` for programmatic consumption by agents.

## Roadmap

Planned features for upcoming releases:

- [ ] **Task retry** — `ruah task retry <name>` to re-execute failed tasks without recreating worktrees
- [ ] **Task logs** — `ruah task log <name>` to view execution output from completed/failed tasks
- [ ] **Watch mode** — `ruah watch` for live task status dashboard in the terminal
- [ ] **Task timeouts** — TTL per task with configurable auto-cancel on expiry
- [ ] **Webhook notifications** — notify external services (Slack, Discord, n8n) on task state changes
- [ ] **Config file** — `.ruahrc` or `package.json` `"ruah"` section for project defaults (base branch, default executor, timeout)
- [ ] **Plugin executors** — user-defined executor adapters loaded from config
- [ ] **Conflict resolution strategies** — configurable merge conflict handling (fail, ours, manual)
- [ ] **Task priority** — weighted scheduling within workflow stages
- [ ] **Workflow templates** — `ruah workflow create <name>` to scaffold workflow files from templates

## Releasing

Releases are automated via GitHub Actions. To publish a new version:

```bash
npm version patch   # or minor, major
git push --tags
```

This triggers the release pipeline which runs typecheck + lint + tests, publishes to npm, and creates a GitHub release with auto-generated notes.

> **First-time setup:** Add your npm token as `NPM_TOKEN` in GitHub repo settings → Secrets and variables → Actions.

## Ecosystem

```
crag   = governance + discovery + skills + compilation  (@whitehatd/crag)
ruah   = multi-agent orchestration                      (@levi-tc/ruah)
arhy   = system contracts                               (@levi-tc/arhy)
```

## Requirements

- Node.js 18+
- Git (for worktrees)
- TypeScript (dev only — ships compiled JS)
- Zero runtime npm dependencies

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
