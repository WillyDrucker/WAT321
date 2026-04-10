# WAT321 — Claude Code Project Instructions

## Read Order
1. This file (rules and conventions)
2. `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` (architecture, references, constraints)
3. `WDDOCS/WAT321_FRAMEWORK/WAT321_FRAMEWORK_README.md` (framework details)

## Project
VS Code extension providing real-time AI usage status bar widgets (Claude + Codex).

## Key Rules
- **No user file modifications** — tools must be read-only. Never write to ~/.claude/ or any user config.
- **API rate limiting** — Anthropic usage API locks out for 15min on >1 req/min. Keep polling ≥122s, cooldown ≥61s. Never bypass cooldown on manual refresh.
- **No bundler** — tsc only, no webpack/esbuild. No external runtime deps.
- **CHANGELOG.md must be updated before any version bump.** Use `/wat321-publish` skill for the full checklist.

## Architecture
- Each tool gets its own folder under `src/`
- Shared services in `src/shared/` — one polling path per API provider
- All six tools active: Claude (5hr, weekly, session tokens) + Codex (5 hour, weekly, session tokens)
- Settings gate: `wat321.enableClaude` (default true), `wat321.enableCodex` (default false). Gate prevents services from starting when disabled.
- Claude tools visible by default, Codex tools hidden by default
- All widgets are display-only — no click-to-refresh commands
- Session token tooltips use `isTrusted: false` for security

## Conventions
- AIDOCS/ and WDDOCS/ are gitignored — not in repo
- Branch naming: `WAT321_vX.X.X`
- **Branch = version = changelog.** Branch `WAT321_v1.0.1` means `package.json` version is `1.0.1` and `CHANGELOG.md` has a `[1.0.1]` entry. These must always be in sync.
- Status bar item names: `WAT321: <Tool Name>`
- Debug via F5 → Extension Development Host
- Use `/wat321-publish` for the full release flow
