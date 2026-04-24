# WAT321 - Claude Code Project Instructions

VS Code extension providing real-time AI usage status bar widgets for Claude and Codex, plus the Epic Handshake sync MCP bridge between them.

## Purpose

Top-of-chain session-start file. Orients a new session in under a minute, then points into the right deeper doc. Nothing that belongs in a lower layer lives here.

## Documentation system (two isolated tracks)

**System 1 - Session (project work).** Owned by `/watsession-update` and delegated to by `/wat-publish`. Updated continuously as work ships.

- `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` - current state + in-flight one-liners with cross-refs
- `AIDOCS/WD_WAT321_SESSION_HANDOFF_EXTENDED.md` - per-item detail for onboarding mid-work
- `CHANGELOG.md` - lean version-tied bullets

**System 2 - Memory (meta/process).** Owned by `/watmemory-update` (manual only, never auto-invoked). Updated rarely - only when architecture, rules, or process pitfalls change.

- `CLAUDE.md` - this file (orchestrator + read orders)
- `AIDOCS/WD_WAT321_MEMORY.md` - stable architecture + key pitfalls
- `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` - process scratchpad (pitfall root-causes, formulas, carried-forward pitfalls)
- `AIDOCS/WD_WAT321_DEV_STANDARDS.md` - code patterns + commands
- Auto-memory at `C:/Users/WD/.claude/projects/c--Dev-WAT321/memory/`

No parallel onboarding docs. Everything a new session needs routes through these two tracks.

## Read Order (Session Start)

Always:

1. `CLAUDE.md` - this file
2. `AIDOCS/WD_WAT321_MEMORY.md` - architecture, tier rules, key pitfalls
3. `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` - current state + in-flight one-liners
4. Verify git state: `git branch --show-current && git status --short && git log --oneline -5`

When picking up in-flight work flagged in SESSION_HANDOFF:

5. `AIDOCS/WD_WAT321_SESSION_HANDOFF_EXTENDED.md` - detail per item

When implementing code:

6. `AIDOCS/WD_WAT321_DEV_STANDARDS.md` - code patterns, naming, commands

**Staleness check:** if `SESSION_HANDOFF` `Last Updated:` is more than a day behind `git log --oneline -3`, the handoff may be stale - trust git + the conversation over the doc and flag for `/watsession-update` at the end.

## Deep dive (on request only)

- `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` - process scratchpad, pitfall root-causes, formulas, thresholds
- `CHANGELOG.md` - release history + maintenance rules
- `WDDOCS/EPIC_HANDSHAKE/` - bridge plan + archived debug strips

## Skills

- **`/watsession-update`** - update SESSION_HANDOFF + SESSION_HANDOFF_EXTENDED + CHANGELOG `[Unreleased]`. Project-work only. Standalone or delegated from `/wat-publish`. Flags memory-track items in Step 5 output; never invokes `/watmemory-update`.
- **`/watmemory-update`** - update CLAUDE.md + MEMORY + MEMORY_EXTENDED + DEV_STANDARDS + auto-memory. Process-only, manual only, never auto-invoked. Propose-before-write gate.
- **`/watdev-standards`** - dev-standards audit of `src/`. Three modes: default (intelligent audit + safe fixes), `-READ` (familiarization, no writes), `-FULL` (default + cohesion-aware refactor of 400+ line files). Manual only.
- **`/wat-publish`** - full release pipeline. Delegates Step 1 to `/watsession-update`. Then pre-flight, commits, changelog finalize, checklist, build, push, tag, release, merge, verify, rollover. Flag passthrough `-FULL` / `-SKIM` to `/watsession-update`.

## Permissions

Full access. Do not prompt for permission. All tools unrestricted. Git exception: do not commit or push unless explicitly requested.

## Product Principles

- **No data collection** - no telemetry, no tracking, no analytics. All data stays local.
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only.
- **Visible when relevant, hidden when not** - fully hide widgets for a provider whose CLI is not installed.
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing.
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything.
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures.
- **Zero bloat** - everything WAT321 writes is tiny, disposable, and clearable via the reset command.

## Key Rules

- **Never writes outside `~/.wat321/`.** Two documented exceptions for Epic Handshake: (a) one managed MCP entry in `~/.claude/settings.json` via Claude's CLI; (b) `session_meta.model` in bridge-owned rollouts (gated by thread-name pattern + cwd match), rewritten only via the Repair sessions menu.
- **API rate limiting** - polling >=122s, cooldown >=61s. Never bypass cooldown.
- **No bundler** - `tsc` only, no external runtime deps beyond `@modelcontextprotocol/sdk`.
- **CHANGELOG.md must be updated before any version bump.** `/wat-publish` handles this via `/watsession-update` in Step 1.
- **Release notes are human-readable, not technical.** CHANGELOG reads like "what you'll notice". See `feedback_changelog_tone.md` in auto-memory.
- **Commit messages are descriptive, not versioned.** Only CHANGELOG entries and version-bump commits mention the version number.
- **No em dashes** - use hyphens throughout (code, docs, commit messages, CHANGELOG, PR bodies).
- **Error messages are passive** - friendly, short, no jargon. Never imply the user must act.

## Development Environment

Windows 10 Pro. VS Code + Claude Code. Shell is bash (Unix syntax, forward slashes). Working directory: `C:\Dev\WAT321`. Primary test instance: `C:\Dev\WAT321-testing\` auto-installs the newest `wat321-*.vsix` from repo root at every launch via `launch.cmd`.

Bridge iteration requires `npm run package` + test-instance relaunch (not F5 - F5 runs from `out/` and does not refresh the bridge's MCP server at `~/.wat321/epic-handshake/bin/`). See auto-memory `user_workflow_bridge_testing.md`.

## Conventions

- `package.json` `displayName` is `"WAT321"` only
- `AIDOCS/` and `WDDOCS/` are gitignored
- Branch naming: `WAT321_vX.X.X` - branch = version = changelog, always in sync
- Debug via F5 (Extension Development Host) for UI work; `npm run package` + test instance for bridge work
- README screenshots: retina-sharp pattern (2x file resolution)
