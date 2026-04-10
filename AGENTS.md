# AGENTS.md

> Generated from governance.md

## Project: @ruah-dev/orch

Multi-agent orchestration CLI. Workspace isolation, DAG scheduling, file locking, merge coordination.

## Quality Gates

All changes must pass these checks before commit:

### Lint & format
1. `npx @biomejs/biome check --write .`
2. `npx @biomejs/biome check .`

### Test
1. `node --test test/*.test.js`

## Coding Standards

- Runtimes: node
- Follow conventional commits (feat:, fix:, docs:, etc.)
- No hardcoded secrets — grep for sk_live, AKIA, password= before commit

## Architecture

Run `/pre-start-context` at the start of every session to discover the project stack, load governance rules, and prepare for work.

## Validation

Run `/post-start-validation` after completing any task to validate changes, run gates, capture knowledge, and commit.
