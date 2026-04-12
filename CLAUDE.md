# WAT321 - Claude Code Project Instructions

## Read Order
1. This file (rules and conventions)
2. `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` (architecture, references, constraints)
3. `WDDOCS/WAT321_FRAMEWORK/WAT321_FRAMEWORK_README.md` (framework details)

## Project
VS Code extension providing real-time AI usage status bar widgets (Claude + Codex).

## Product Principles
- **Read-only** - never modify user files. Only writes are disposable stamps in `~/.wat321/`
- **No data collection** - no telemetry, no tracking, no analytics. All data stays local
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only
- **Always visible** - never hide a widget on error. Show a friendly status so the user knows what's happening
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures
- **Zero bloat** - all stored files (stamps, flags) are tiny, disposable, and removable via the clear command
- **Fail silently on first attempt** - absorb the first transient error, surface it only if it persists

## Key Rules
- **No user file modifications** - never write to ~/.claude/, ~/.codex/, or any user config
- **API rate limiting** - keep polling >=122s, cooldown >=61s. Never bypass cooldown
- **No bundler** - tsc only, no external runtime deps
- **CHANGELOG.md must be updated before any version bump.** Use `/wat321-publish` skill
- **Commit messages are descriptive, not versioned.** Only changelog and version bump commits mention the version
- **No em dashes** - use hyphens throughout
- **Error messages are passive** - friendly, short, no jargon

## Architecture
- Each tool gets its own folder under `src/`
- Shared services in `src/shared/` - one polling path per API provider
- All six tools active: Claude (5hr, weekly, session tokens) + Codex (5 hour, weekly, session tokens)
- Settings gate: `wat321.enableClaude` (default true), `wat321.enableCodex` (default false)
- Display modes: Full / Compact / Minimal (instant switching via rebroadcast)
- Dynamic enable/disable - no window reload needed
- All widgets are display-only - no click commands (except clear settings)
- Session token tooltips use `isTrusted: false` for security
- Build pipeline: clean -> lint -> tsc

## Conventions
- `package.json` `displayName` is `"WAT321"` only - never add "Willy's AI Tools" or any suffix (gets truncated in VS Code UI)
- AIDOCS/ and WDDOCS/ are gitignored - not in repo
- Branch naming: `WAT321_vX.X.X`
- **Branch = version = changelog** - always in sync
- Claude uses `5hr` in identifiers and display text
- Codex uses `5hr` in identifiers, `5 hour` in display text
- Debug via F5 - Extension Development Host
- Use `/wat321-publish` for the full release flow
