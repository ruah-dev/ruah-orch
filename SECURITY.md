# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in ruah, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **phuzum23@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested fix (optional)

You will receive an acknowledgment within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security Considerations

ruah is a local CLI tool that orchestrates git worktrees and spawns child processes. Key security areas:

### Process Execution

ruah spawns executor processes (Claude Code, Aider, Codex, etc.) using `child_process.spawn` with array-form arguments — never string concatenation. This prevents shell injection. Unknown executor names are still spawned as commands, so users should only run trusted executors.

### File System

ruah operates within the git repository it's initialized in. Worktrees are created under `.ruah/worktrees/`. State is stored in `.ruah/state.json`. No files are written outside the repository root.

### No Network Access

ruah makes no network requests during normal operation. The only network call is the optional update notifier (checking npm registry for new versions), which can be disabled with `RUAH_NO_UPDATE_CHECK=1`.

### No Secrets

ruah never reads, stores, or transmits credentials, API keys, or tokens. Governance gate commands are executed as-is from `.claude/governance.md` — ensure your gate commands are safe.

### Dependencies

ruah has **zero runtime dependencies**. The attack surface from supply chain compromises is limited to dev dependencies (TypeScript, Biome, @types/node) which are not shipped in the published package.
