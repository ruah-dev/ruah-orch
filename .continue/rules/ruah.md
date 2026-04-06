# ruah — Multi-Agent Orchestration

This project uses `ruah` for multi-agent orchestration.

## Available Commands
- `ruah status --json` — project status with task counts
- `ruah task create <name> --files "..." --executor claude-code --prompt "..."` — create isolated task
- `ruah task start <name>` — start task execution in worktree
- `ruah task done <name>` — mark complete
- `ruah task merge <name>` — merge back (runs governance gates)
- `ruah workflow run <file.md>` — execute DAG workflow
- `ruah task create <child> --parent <parent> --files "..." --prompt "..."` — spawn subtask

## Key Concepts
- Each task runs in an isolated git worktree
- File locks prevent edit conflicts between tasks
- Workflows define task DAGs in markdown
- Subtasks branch from parent (not base), merge into parent
