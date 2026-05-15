---
name: 321
description: Router for WAT321 project skills. Universal `/321` command across the 321 family - each project's local `.claude/skills/321/SKILL.md` handles dispatch. Type `/321` for the menu, or `/321 -<Subcommand> [args]` to invoke a specific skill. Sub-skill bodies live in AIDOCS/SKILLS/.
---

# /321 - WAT321 skill router

**Purpose:** Dispatch `/321 -<Subcommand>` invocations to the matching sub-skill body in `AIDOCS/SKILLS/`. The router stays terse - sub-skills carry the procedural detail. `/321` is the universal family slash command; each project has its own local `.claude/skills/321/` dispatch.

## Quick reference

| Subcommand | What it does | When to use | Modes |
|---|---|---|---|
| `-SessionUpdate` | Update SESSION + SESSION_EXTENDED + CHANGELOG `[Unreleased]` | Mid-session checkpoint, before stepping away | default / `-FULL` / `-SKIM` |
| `-AutoPush` | Full WAT321 release pipeline: SessionUpdate (Step 1) -> pre-flight -> commits -> CHANGELOG finalize -> build -> push -> tag -> GitHub release -> merge -> verify -> rollover. Publishes the next `.vsix` to the VS Code Marketplace as `WillyDrucker.wat321`. | End of work session, ship release | passes `-FULL` / `-SKIM` through to session-update |
| `-MemoryUpdate` | Update CLAUDE.md + MEMORY + MEMORY_EXTENDED + DEV-STANDARDS + auto-memory | When architecture, rules, or process pitfalls change | default / `-FULL` / `-SKIM` (manual invocation only) |
| `-DevStandards` | Code-standards audit of `src/` (TypeScript, no bundler, MCP surface lean, semantic filenames, comment policy) | When code-quality drift is suspected | default / `-READ` / `-FULL` |
| `-Help` | Print this quick-reference menu | When you forget which skill does what | n/a |

For full detail on any sub-skill, read its body directly: `AIDOCS/SKILLS/SKILLS_{NAME}/WAT321_SKILLS_{NAME}.md`.

## Invocation patterns

- `/321` -> print this menu and exit
- `/321 -Help` (or `-H` / `--help`) -> same
- `/321 -SessionUpdate -SKIM` -> invoke session-update with `-SKIM` passed through
- `/321 -AutoPush` -> invoke the release pipeline (no extra args)
- `/321 -DevStandards -READ` -> invoke dev-standards in read-only mode

The first token after `/321` is the subcommand. Matching is lenient: leading dash optional, hyphens optional, case-insensitive. `-SessionUpdate`, `-sessionupdate`, `session-update`, `SessionUpdate`, `SESSION-UPDATE` all dispatch to the same row. Everything after is the sub-skill's ARGUMENTS, passed verbatim.

Chaining (`/321 -X && /321 -Y`) is NOT supported by the router. Invoke each separately or chain inside a sub-skill body (`-AutoPush` already chains internally - Step 1 delegates to `-SessionUpdate`).

---

## Dispatch logic (operating instructions)

When this skill is invoked:

### 1. Parse ARGUMENTS

- Empty ARGUMENTS, or first token is `-Help` / `-H` / `--help` / `-?` -> print the Quick reference table above and exit. Do not dispatch.
- First token is `SUBCOMMAND`. Normalize by stripping leading `-`, stripping internal `-`, lowercasing. Compare against dispatch-table keys normalized the same way.
- Everything after is `SUB_ARGS` (may be empty), preserved verbatim.
- If the normalized form is empty (token was only dashes / digits / punctuation), print the Quick reference + a hint and exit. Do not fuzzy-match against the table.
- Echo the canonical PascalCase form when surfacing the resolved subcommand in output.

### 2. Look up the subcommand in the dispatch table

| Subcommand | Skill body path |
|---|---|
| `-SessionUpdate` | `AIDOCS/SKILLS/SKILLS_SESSION-UPDATE/WAT321_SKILLS_SESSION-UPDATE.md` |
| `-AutoPush` | `AIDOCS/SKILLS/SKILLS_AUTO-PUSH/WAT321_SKILLS_AUTO-PUSH.md` |
| `-MemoryUpdate` | `AIDOCS/SKILLS/SKILLS_MEMORY-UPDATE/WAT321_SKILLS_MEMORY-UPDATE.md` |
| `-DevStandards` | `AIDOCS/SKILLS/SKILLS_DEV-STANDARDS/WAT321_SKILLS_DEV-STANDARDS.md` |

If `SUBCOMMAND` doesn't match any row: print "Unknown subcommand: `SUBCOMMAND`. Available: -SessionUpdate, -AutoPush, -MemoryUpdate, -DevStandards." plus the Quick reference table. Exit.

### 3. Load the sub-skill

Read the path from the dispatch table. The content of that file becomes the **next set of operating instructions**. Treat `SUB_ARGS` as the ARGUMENTS for the sub-skill, exactly as if invoked directly.

### 4. Execute the sub-skill

Follow the sub-skill's instructions to completion. The sub-skill owns its own step sequence, modes, quality gates, exit conditions, and output format. The router does NOT post-process the sub-skill's output.

### 5. Multi-file sub-skills

If `AIDOCS/SKILLS/SKILLS_{NAME}/` contains additional files alongside the body (helpers, examples, reference data), the sub-skill body itself references them via relative paths. The router does not need to know about them.

---

## Project-specific notes

- **`-AutoPush` is marketplace publish**, not Cloudflare Workers deploy. The skill body wraps the existing release pipeline (formerly `/wat-publish` before standardization): build `.vsix`, push branch, create GitHub release, publish to VS Code Marketplace as `WillyDrucker.wat321`, merge, rollover.
- **No `pnpm`** - WAT321 uses `npm` + `tsc` (no bundler). DevStandards quality gates are `npm run compile` and TypeScript-only checks.
- **Marketplace verification TXT record** location is load-bearing for publisher status. Not in scope for any sub-skill; the operational detail (DNS host + record name) lives in the operator-side docs at `AIDOCS/ENV/WAT321_ENV_DEVELOPMENT.md` and the gitignored orchestrator docs.

## Maintenance notes

**Adding a new skill:**
1. Create `AIDOCS/SKILLS/SKILLS_{NAME}/WAT321_SKILLS_{NAME}.md` with the skill body.
2. Add a row to the **Quick reference** table.
3. Add a row to the **dispatch table** in Step 2.

**Renaming a skill:** The subcommand flag (PascalCase), folder name (UPPERCASE-with-hyphens), and file name must stay aligned.

**Removing a skill:** Delete the `AIDOCS/SKILLS/SKILLS_{NAME}/` folder and remove both rows.

**Sub-skill independence:** Sub-skills should NOT assume they're invoked via `/321`. A direct Read of the body file (for manual review or porting) should work too. Sub-skills CAN reference each other (e.g., `-AutoPush` invokes `-SessionUpdate` as Step 1). Use the `/321 -SubName` form for clarity.
