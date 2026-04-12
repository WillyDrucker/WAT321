# WAT321 - Claude Code Project Instructions

## Read Order
1. This file (rules and conventions)
2. `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` (architecture, file layout, shared services, display modes, all reference material)
3. `WDDOCS/WAT321_FRAMEWORK/WAT321_FRAMEWORK_README.md` (per-tool framework detail)
4. `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` (current dev state)

## Project
VS Code extension providing real-time AI usage status bar widgets (Claude + Codex).

## Product Principles
- **Read-only** - never modify user files. Only writes are disposable caches, claims, and stamps in `~/.wat321/`
- **No data collection** - no telemetry, no tracking, no analytics. All data stays local
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only
- **Visible when relevant, hidden when not** - show a friendly status on error, but fully hide widgets for a provider whose CLI is not installed
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures
- **Fail silently on first attempt** - absorb the first transient error, surface it only if it persists
- **Zero bloat** - everything WAT321 writes is tiny, disposable, and clearable via the reset command

## Key Rules
- **No user file modifications** - never write to `~/.claude/`, `~/.codex/`, or any user config
- **API rate limiting** - keep polling >=122s, cooldown >=61s. Never bypass cooldown
- **No bundler** - tsc only, no external runtime deps
- **CHANGELOG.md must be updated before any version bump.** Use `/wat321-publish` skill
- **Commit messages are descriptive, not versioned.** Only changelog and version-bump commits mention the version
- **No em dashes** - use hyphens throughout
- **Error messages are passive** - friendly, short, no jargon

## Conventions
- `package.json` `displayName` is `"WAT321"` only - never add "Willy's AI Tools" or any suffix (gets truncated in VS Code UI)
- AIDOCS/ and WDDOCS/ are gitignored - not in repo
- Branch naming: `WAT321_vX.X.X`
- **Branch = version = changelog** - always in sync
- Claude uses `5hr` in identifiers and display text; Codex uses `5hr` in identifiers, `5 hour` in display text.
  - **This drift is intentional and load-bearing.** Do not "fix" it - the display strings match what each CLI shows its own users. Locked.
- Debug via F5 - Extension Development Host
- Use `/wat321-publish` for the full release flow
