# WAT321 — Claude Code Project Instructions

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
- Codex tools are scaffolded but not activated yet

## Conventions
- AIDOCS/ and WDDOCS/ are gitignored — not in repo
- Branch naming: `WAT321_vX.X.X`
- Status bar item names: `WAT321: <Tool Name>`
- Debug via F5 → Extension Development Host
