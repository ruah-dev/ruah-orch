# Contributing to ruah

Thanks for your interest in contributing! ruah is a multi-agent orchestration CLI — here's how to get involved.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/ruah-dev/ruah-orch.git
cd ruah

# Install dev dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Typecheck
npm run typecheck

# Lint
npm run lint
```

## Project Structure

```
src/
  cli.ts                  Entry point, arg parser, command router
  commands/
    init.ts               ruah init — initialize .ruah/ in a repo
    setup.ts              ruah setup — register with AI agents
    task.ts               ruah task — create/start/done/merge/cancel/list
    workflow.ts           ruah workflow — run/plan/list DAG workflows
    status.ts             ruah status — dashboard
  core/
    state.ts              State management, file locks, overlap detection
    git.ts                Git worktree operations
    executor.ts           Executor adapters (claude-code, aider, codex, etc.)
    workflow.ts           Markdown workflow parser, DAG validation
    integrations.ts       governance integration
    update-notifier.ts    npm update check (zero-dep, cached)
  utils/
    format.ts             Terminal colors, formatting helpers
test/
  *.test.ts               Tests (node:test built-in runner)
```

## Development Guidelines

### Zero Runtime Dependencies

This is a hard constraint. ruah ships with zero `dependencies` in package.json. Dev dependencies are fine — anything under `devDependencies` is acceptable. But nothing in `dependencies`.

If you need functionality that typically comes from a package, implement it with Node.js built-ins.

### TypeScript Strict Mode

The codebase uses `strict: true`. All code must pass `tsc --noEmit` with no errors. No `any` types except in test files where partial objects use `as unknown as Type`.

### Testing

Tests use Node.js built-in test runner (`node:test`). No test frameworks.

```bash
# Run all tests
npm test

# Run a single test file
npx tsc -p tsconfig.test.json && node --test dist-test/test/state.test.js
```

Every new feature or bug fix should include tests. The test suite currently has 80 tests across 6 files.

### Linting & Formatting

We use [Biome](https://biomejs.dev/) for linting and formatting.

```bash
# Check
npm run lint

# Auto-fix
npm run format
```

### Commit Convention

```
type(scope): description

Co-Authored-By: Your Name <email>
```

Types: `feat`, `fix`, `docs`, `refactor`, `style`, `test`, `chore`

Examples:
- `feat: add task retry command`
- `fix(workflow): handle empty task list in DAG validation`
- `docs: update CLI reference with new flags`

### Branch Strategy

Trunk-based development on `main`. For contributions:

1. Fork the repo
2. Create a feature branch from `main`
3. Make your changes
4. Ensure all checks pass: `npm run typecheck && npm run lint && npm test`
5. Open a PR against `main`

## What to Contribute

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/ruah-dev/ruah-orch/labels/good%20first%20issue).

### Roadmap Items

These are planned features that would be great contributions:

- **Task retry** — `ruah task retry <name>` to re-execute failed tasks
- **Task logs** — capture and replay executor stdout/stderr
- **Watch mode** — live terminal dashboard for task status
- **Task timeouts** — TTL per task with auto-cancel
- **Config file** — `.ruahrc` for project defaults
- **New executor adapters** — add support for more AI coding tools

### Bug Reports

Open an issue with:
- ruah version (`ruah --version`)
- Node.js version (`node --version`)
- OS
- Steps to reproduce
- Expected vs actual behavior

### Feature Requests

Open an issue describing:
- The use case
- How you'd expect it to work
- Why existing features don't cover it

## Running the CLI Locally

During development, run directly from the compiled output:

```bash
npm run build
node dist/cli.js --help
node dist/cli.js init
node dist/cli.js status
```

Or link it globally:

```bash
npm link
ruah --help
```

## Release Process

Releases are automated. Maintainers tag and push:

```bash
npm version patch   # or minor, major
git push --tags
```

GitHub Actions handles: typecheck → lint → test → npm publish → GitHub Release.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
