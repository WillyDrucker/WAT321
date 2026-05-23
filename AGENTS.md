# WAT321

**Purpose:** Orchestrator. Orients a new session in under a minute and points into the right deeper doc. Nothing that belongs in a lower layer lives here.

## Project Overview

WAT321 (Willy's AI Tools) is a VS Code extension showing real-time Claude and Codex usage status-bar widgets plus the Epic Handshake MCP bridge between AI CLIs. Marketplace `WillyDrucker.wat321`, public repo `github.com/WillyDrucker/WAT321`. Part of the 321Done family. Identity, architecture, and conventions live in `AIDOCS/WAT321_MEMORY.md`.

## Cold-start load order

1. `AIDOCS/WAT321_MEMORY.md` - identity (Overview / Stack / Architecture / Environment / Pipeline / Conventions) plus LIFO durable observations
2. `AIDOCS/WAT321_SESSION.md` - Current State (overwrite each pass) plus the LIFO backbone log of project-significant events
3. `AIDOCS/_index.json` - registry (paths, file keys, buckets, size budgets, skill dispatch)

Optional, on demand:

4. EXTENDED files - `AIDOCS/WAT321_MEMORY_EXTENDED.md` / `AIDOCS/WAT321_SESSION_EXTENDED.md`, longer prose plus anchored LIFO detail
5. `AIDOCS/WAT321_BACKLOG.md` - forward-looking Features plus Ideas
6. `AIDOCS/WAT321_DEV-AUDIT.md` - code-standards audit, loads on demand

## Layout

File layout, size budgets, and skill dispatch all live in `AIDOCS/_index.json`. Read it when you need a path, file key, bucket name, or size cap. Do not hardcode paths anywhere else.

## Permissions

Full access. Do not prompt for permission. Git exception: do not commit or push unless explicitly requested.

## Environment

Setup, commands, secrets, and platform notes live in `AIDOCS/ENV/`. Read on demand when the question is operational.

## Hard rules

Mirror of the auto-memory seed in `AIDOCS/automemory` - the canonical rules that ship in the repo and seed Claude's native memory at install. The runtime source of truth is Claude's native memory, which carries these canonical rules plus this project's own custom rules. This surface keeps the inventory visible at session start. The full text of each rule lives in its linked `feedback_*.md` file.

- [Code comments](feedback_code_comments.md) - comments that earn their space. Worth writing: module headers, constraints, failure modes, contracts. Surplus context goes to a doc.
- [Doc purpose header](feedback_doc_purpose_header.md) - every project MD file gets a **Purpose:** callout after the H1.
- [Lean docs](feedback_lean_docs.md) - top tiers stay lean. Size targets live in skill bodies.
- [No subagents for review](feedback_no_subagents_for_review.md) - inspect manually with Read/Grep/Glob, no Explore / general-purpose agents.
- [No versions in code](feedback_no_versions_in_code.md) - versions live in package.json, dates live in git.
- [TEMP folder usage](feedback_temp_folder_usage.md) - TEMP/ at project root is the single home for all temporary files.
- [No em dashes](feedback_no_em_dashes.md) - no em dashes or semicolons under our authorship: public-facing copy, marketing prose, AI-formatted output, memory files, code comments.
- [No dates in memory](feedback_no_dates_in_memory.md) - no dates or version stamps in memory or session files. LIFO carries the time signal.
- [Naming and renaming](feedback_naming.md) - names state what a thing owns. Renames stay in-domain and move the name, its registry key, and every reference in one pass.
- [User profile](user_willy.md) - Willy Drucker, solo developer and 321Done founder, AI-assisted development across the 321 family.

## Project Specifics

- **Public repo.** `AIDOCS/`, `WDDOCS/`, and `AIDOCS/ENV/` are gitignored internal docs - never commit or `git add -f` them. Only `src/`, root configs, `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, and `.claude/` ship. Full ship-list in `WAT321_AUTO-PUSH.md`.
- **Bridge iteration needs `npm run package` + a test-instance relaunch, never F5** - F5 runs from `out/` and does not refresh the bridge MCP server at `~/.wat321/bridge/bin/`. Detail in `WAT321_MEMORY.md` Environment.
