# WAT321 - Claude Code Project Instructions

## Read Order
1. This file (rules and conventions)
2. `AIDOCS/WD_WAT321_MEMORY.md` (architecture, engine design, key decisions)
3. `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` (deep details: formulas, thresholds, edge cases)
4. `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` (current dev state)

## Project
VS Code extension providing real-time AI usage status bar widgets (Claude + Codex). Six read-only core widgets.

## Product Principles
- **No data collection** - no telemetry, no tracking, no analytics. All data stays local
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only
- **Visible when relevant, hidden when not** - fully hide widgets for a provider whose CLI is not installed
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures
- **Zero bloat** - everything WAT321 writes is tiny, disposable, and clearable via the reset command

## Key Rules
- **Never writes outside `~/.wat321/`.** All widgets are strictly read-only. Everything WAT321 writes is a disposable cache inside its own folder
- **API rate limiting** - keep polling >=122s, cooldown >=61s. Never bypass cooldown
- **No bundler** - tsc only, no external runtime deps
- **CHANGELOG.md must be updated before any version bump.** Use `/wat321-publish` skill
- **Release notes are human-readable, not technical.** CHANGELOG reads like "what you'll notice"
- **Commit messages are descriptive, not versioned.** Only changelog and version-bump commits mention the version
- **No em dashes** - use hyphens throughout
- **Error messages are passive** - friendly, short, no jargon

## Code Style
- **No version numbers, timestamps, or release narrative in code comments.** History belongs in commits and CHANGELOG
- **Comments are future-facing:** what the code does, WHY, and what constraints to preserve
- **Semantic file names** - `compactDetector.ts`, `rolloutDiscovery.ts`, not generic catch-alls
- **Scale intelligently** - extract shared helpers when duplication is genuine, but keep each service readable end-to-end

## Conventions
- `package.json` `displayName` is `"WAT321"` only
- AIDOCS/ and WDDOCS/ are gitignored
- Branch naming: `WAT321_vX.X.X` - branch = version = changelog, always in sync
- Debug via F5 (Extension Development Host)
- Use `/wat321-publish` for the full release flow
- README screenshots: retina-sharp pattern (2x file resolution). See `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md`
