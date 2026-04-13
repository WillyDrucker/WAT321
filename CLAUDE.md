# WAT321 - Claude Code Project Instructions

## Read Order
1. This file (rules and conventions)
2. `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` (architecture, file layout, shared services, display modes, all reference material)
3. `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` (current dev state)

## Project
VS Code extension providing real-time AI usage status bar widgets (Claude + Codex).

## Two-Tier Tool Model
WAT321 has two distinct tool categories with different trust contracts:

**Read-only core (locked)** - the 6 existing widgets: Claude usage 5h/weekly, Codex usage 5h/weekly, Claude session tokens, Codex session tokens. These never modify user files. Only writes are disposable caches, claims, and stamps in `~/.wat321/`. This guarantee does not change.

**Experimental settings (opt-in)** - settings that may write outside `~/.wat321/` (currently only `wat321.experimental.forceClaudeAutoCompact`, which writes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json` through the service in `src/WAT321_EXPERIMENTAL_AUTOCOMPACT/`). These default to `false`, live under an **Experimental** label in settings, and route every write through the same four-tier sentinel + backup ring + install snapshot + default heal chain so any crash mid-arm self-heals on the next VS Code start.

## Product Principles
- **No data collection** - no telemetry, no tracking, no analytics. All data stays local
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only
- **Visible when relevant, hidden when not** - show a friendly status on error, but fully hide widgets for a provider whose CLI is not installed
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures
- **Fail silently on first attempt** - absorb the first transient error, surface it only if it persists
- **Zero bloat** - everything WAT321 writes is tiny, disposable, and clearable via the reset command

## Key Rules
- **Read-only core never writes outside `~/.wat321/`.** Experimental settings may, but only with a self-healing backup sentinel and a four-tier restore precedence chain
- **API rate limiting** - keep polling >=122s, cooldown >=61s. Never bypass cooldown
- **No bundler** - tsc only, no external runtime deps
- **CHANGELOG.md must be updated before any version bump.** Use `/wat321-publish` skill
- **Release notes are human-readable, not technical.** CHANGELOG entries should read like a friendly "what you'll notice" summary, not implementation notes. Say "Claude session tokens now keep showing your last session after a VS Code restart" instead of "fixed parseLastUsage null return on 30MB post-compact transcripts". Leave the technical detail for commit messages and code comments
- **Commit messages are descriptive, not versioned.** Only changelog and version-bump commits mention the version
- **No em dashes** - use hyphens throughout
- **Error messages are passive** - friendly, short, no jargon

## Conventions
- `package.json` `displayName` is `"WAT321"` only - never add "Willy's AI Tools" or any suffix (gets truncated in VS Code UI)
- AIDOCS/ and WDDOCS/ are gitignored - not in repo
- Branch naming: `WAT321_vX.X.X`
- **Branch = version = changelog** - always in sync
- Debug via F5 - Extension Development Host
- Use `/wat321-publish` for the full release flow
- Naming conventions, status bar label specs, tooltip formatters, and file-layout reference live in `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` - do not re-duplicate here
