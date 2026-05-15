# WAT321 - Willy's AI Tools

**Purpose:** Top-of-chain orchestrator. Orients a new session in under a minute, then points into the right deeper doc. Nothing that belongs in a lower layer lives here.

VS Code extension providing real-time AI usage status bar widgets for Claude and Codex, plus the Epic Handshake sync MCP bridge between them. Marketplace: `WillyDrucker.wat321`. Repo: github.com/WillyDrucker/WAT321 (public).

## Documentation system

**Two tracks** - Session vs Memory. Both live in `AIDOCS/`. **`WDDOCS/` is on-demand reference** (brand, design, framework reference, observations). It may be partial or out of date - treat as occasional input, not canonical.

### System 1 - Session (project work)
Owned by `/321 -SessionUpdate` and `/321 -AutoPush`. Updated continuously as work ships.
- `AIDOCS/WAT321_SESSION.md` - current state + in-flight one-liners
- `AIDOCS/WAT321_SESSION_EXTENDED.md` - per-item detail
- `CHANGELOG.md` - version-tied bullets (human-readable, see auto-memory `feedback_changelog_tone`)

### System 2 - Memory (meta / process)
Owned by `/321 -MemoryUpdate` (manual only). Updated rarely.
- `CLAUDE.md` - this file (orchestrator + read orders)
- `AIDOCS/WAT321_MEMORY.md` - stable architecture + pitfall one-liners
- `AIDOCS/WAT321_MEMORY_EXTENDED.md` - root causes, debugging flows, process patterns
- `AIDOCS/WAT321_DEV-STANDARDS.md` - code conventions
- `AIDOCS/ENV/WAT321_ENV_DEVELOPMENT.md` - toolchain + local state + marketplace publishing prerequisites
- Auto-memory (working-copy only, lives outside this repo at `~/.claude/projects/c--Dev-WAT321/memory/` on each developer machine)

## Read Order (Session Start)

Always:
1. **`CLAUDE.md`** - this file
2. **`AIDOCS/WAT321_MEMORY.md`** - architecture, tier rules, key pitfalls. For root causes -> `WAT321_MEMORY_EXTENDED.md` on demand.
3. **`AIDOCS/WAT321_SESSION.md`** - current state + in-flight one-liners. For per-item detail -> `WAT321_SESSION_EXTENDED.md` on demand.
4. **Verify git state:** `git branch --show-current && git status --short && git log --oneline -5`

When picking up flagged in-flight work:
5. `AIDOCS/WAT321_SESSION_EXTENDED.md` - per-item detail

When implementing code:
6. `AIDOCS/WAT321_DEV-STANDARDS.md` - TypeScript patterns + commands

**Staleness check:** if `SESSION` `Last Updated:` is more than a day behind `git log --oneline -3`, trust git and flag for `/321 -SessionUpdate`.

## Deep Dive (on request only)

Not part of session start. Each AIDOCS file has its own See-also pointing into the relevant on-demand layers.

- `AIDOCS/WAT321_MEMORY_EXTENDED.md` - process scratchpad, pitfall root-causes
- `AIDOCS/ENV/WAT321_ENV_DEVELOPMENT.md` - toolchain, marketplace publishing, bridge MCP runtime
- `WDDOCS/EPIC_HANDSHAKE/` - bridge plan + debug strips
- `WDDOCS/FRAMEWORK_REFERENCE/` - architecture details (widget design, polling subsystem, two-tier model, etc.)
- `WDDOCS/BP/BP_POSITIONING.md` - brand positioning + marketplace voice
- `WDDOCS/DESIGN_FRAMEWORK/DESIGN_FRAMEWORK_README.md` - visual + interaction language
- `WDDOCS/PROJECTS/` - sibling 321 family project pointers
- `WDDOCS/OBSERVATIONS/` - field reports / anomalies worth keeping
- `WDDOCS/RELEASES/` - release-planning docs (V150, V160 phased work)
- `WDDOCS/SCRATCH/` - working files (icon assets, logs)
- `WDDOCS/ARCHIVED_FEATURES/` - retired feature code preserved for reference

## Skills

All skills route through `/321`. Type `/321` (or `/321 -Help`) for the menu.

- Router + dispatch: `.claude/skills/321/SKILL.md`
- Sub-skill bodies: `AIDOCS/SKILLS/SKILLS_{NAME}/WAT321_SKILLS_{NAME}.md`

Subcommands: `-SessionUpdate`, `-AutoPush`, `-MemoryUpdate`, `-DevStandards`. Full descriptions in the router's Quick reference table.

**`-AutoPush` is marketplace publish**, not Cloudflare Workers deploy. WAT321 publishes `.vsix` to the VS Code Marketplace as `WillyDrucker.wat321` (formerly invoked as `/wat-publish` before family standardization).

## Permissions

Full access. Do not prompt for permission. All tools unrestricted. Git exception: do not commit or push unless explicitly requested.

## Git Workflow

Working branches follow `WAT321_vX.X.X` (already UPPERCASE - family standard). Current branch tracked in `AIDOCS/WAT321_SESSION.md`. Release via `/321 -AutoPush`: build `.vsix` -> tag -> GitHub release -> `vsce publish` -> merge to main.

## Hard Rules

- **No em dashes or semicolons** in public-facing copy, AI-formatted prose, commit messages, CHANGELOG, or PR bodies. Hyphens only. Code is exempt.
- **No version numbers or date stamps** in source code. Versions in `package.json`, dates in git, CHANGELOG owns version-tied bullets.
- **`package.json` `name` field stays lowercase** (`"wat321"`). Marketplace `displayName` is `"WAT321"`.
- **`package.json` `displayName`** is `"WAT321"` only - this is what shows in the marketplace listing.
- **Comments are WHY-only.** Module headers, non-obvious decisions, pain-point refs, cross-tier contracts. No history, no activity logs, no what-it-does paraphrase. See auto-memory `feedback_code_comments`.
- **Never writes outside `~/.wat321/`.** Two documented exceptions for Epic Handshake (managed MCP entry + bridge-owned rollout `session_meta.model`). See `WAT321_MEMORY.md` Key Rules + auto-memory `reference_epic_handshake_bridge`.
- **API rate limiting** - polling >=122s, cooldown >=61s. Never bypass cooldown.
- **No bundler.** `tsc` only. Two runtime deps: `@modelcontextprotocol/sdk` + `undici`.
- **CHANGELOG.md must be updated before any version bump.** `/321 -AutoPush` handles this via `/321 -SessionUpdate` in Step 1.
- **Commit messages are descriptive, not versioned.** Only CHANGELOG entries and version-bump commits mention the version number.
- **Error messages are passive** - friendly, short, no jargon. Never imply the user must act. See Product Principles below.
- **No subagents for review** - inspect files directly for any review/audit/compare/look-at request on user's projects. See auto-memory `feedback_no_subagents_for_review`.

## Product Principles

- **No data collection** - no telemetry, no tracking, no analytics. All data stays local.
- **Never affect usage limits** - usage widgets hit a read-only stats endpoint. Session tokens read local files only.
- **Visible when relevant, hidden when not** - fully hide widgets for a provider whose CLI is not installed.
- **Never imply action** - no login prompts, no CLI commands, no "click here to fix". All errors are passive and self-healing.
- **Auto-reconnect** - every error state recovers automatically. The user never needs to do anything.
- **Last known good** - on transient failures, keep showing cached data. Only surface errors after repeated failures.
- **Zero bloat** - everything WAT321 writes is tiny, disposable, and clearable via the reset command.

## Development Environment

Windows 10 Pro recommended (the warm-PowerShell toast pipeline assumes Windows; macOS / Linux fall back to `osascript` / `notify-send`). VS Code + Claude Code. Shell is bash (Unix syntax, forward slashes). The WAT321 working directory and a sibling `WAT321-testing/` directory at the same level are the typical local layout; the test instance auto-installs the newest `wat321-*.vsix` from repo root at every launch via `launch.cmd`.

Bridge iteration requires `npm run package` + test-instance relaunch (NOT F5 - F5 runs from `out/` and does not refresh the bridge's MCP server at `~/.wat321/bridge/bin/`). See auto-memory `user_workflow_bridge_testing`.

Full toolchain detail: `AIDOCS/ENV/WAT321_ENV_DEVELOPMENT.md`.

## Philosophy

Super-stupid-simple. Effortless UX. Visible when relevant, hidden when not. Never imply the user must act. The extension should feel like infrastructure - it just works, and stays out of the way until you need it.
