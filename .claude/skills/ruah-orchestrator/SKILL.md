---
name: ruah-orchestrator
description: Multi-agent orchestration with ruah — task management, workflow execution, file locking
activation: auto
---

# ruah — Multi-Agent Orchestration

ruah is installed and available in this project. Use it to orchestrate parallel AI agent work.

## Quick Reference

```bash
# Status
ruah status --json

# Create isolated tasks
ruah task create <name> --files "src/**" --executor claude-code --prompt "..."

# Start task (creates worktree, runs executor)
ruah task start <name>

# Lifecycle
ruah task done <name>
ruah task merge <name>

# Workflows (DAG-based)
ruah workflow run <file.md>
ruah workflow plan <file.md>

# Subagent spawning
ruah task create <child> --parent <parent> --files "src/sub/**" --executor claude-code --prompt "..."
```

## When to Use ruah

- Multiple files/modules need parallel independent work → create separate tasks
- A task can be split into subtasks → use `--parent` for hierarchical branching
- Quality gates needed before merge → ruah auto-detects governance.md
- Need isolated worktrees for conflict-free parallel edits

## Environment Variables (available in task worktrees)

- `RUAH_TASK` — current task name
- `RUAH_WORKTREE` — worktree path
- `RUAH_PARENT_TASK` — parent task (if subtask)
- `RUAH_FILES` — locked file patterns
- `RUAH_ROOT` — repo root

## JSON Output

Every command supports `--json` for structured output.
