# Copilot Instructions — @ruah-dev/orch

> Generated from governance.md

Multi-agent orchestration CLI. Workspace isolation, DAG scheduling, file locking, merge coordination.

## Runtimes

node

## Quality Gates

When you propose changes, the following checks must pass before commit:

- **lint & format**: `npx @biomejs/biome check --write .`
- **lint & format**: `npx @biomejs/biome check .`
- **test**: `node --test test/*.test.js`

## Expectations for AI-Assisted Code

1. **Run gates before suggesting a commit.** If you cannot run them (no shell access), explicitly remind the human to run them.
2. **Respect classifications.** `MANDATORY` gates must pass. `OPTIONAL` gates should pass but may be overridden with a note. `ADVISORY` gates are informational only.
3. **Respect workspace paths.** When a gate is scoped to a subdirectory, run it from that directory.
4. **No hardcoded secrets.** Never commit values matching `sk_live`, `sk_test`, `AKIA`, or `password = "…"`.
5. **Conventional commits** for all changes.
6. **Conservative changes.** Do not rewrite unrelated files. Do not add new dependencies without explaining why.

## Tool Context

The `governance.md` file is the authoritative source for quality gates and conventions.
