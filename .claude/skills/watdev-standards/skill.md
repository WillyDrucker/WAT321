---
name: watdev-standards
description: Apply dev standards with intelligence - semantic naming, reference checks, stale/dead code, comment policy, dedup, edge cases, modern patterns. Three modes via optional flag.
user-invocable: true
---

**Manual invocation only.** Never runs at session start, never auto-invoked by other skills. A new session reading `CLAUDE.md` / `WD_WAT321_MEMORY.md` / `WD_WAT321_SESSION_HANDOFF.md` does NOT trigger this skill. It runs only when the user explicitly types `/watdev-standards`. Even `-READ` mode is on-demand - don't read the codebase "just in case"; read it because the user asked.

**Scope boundary.** This skill owns `src/` and surfaces findings for `AIDOCS/WD_WAT321_DEV_STANDARDS.md`. It does NOT touch `WD_WAT321_SESSION_HANDOFF*`, `WD_WAT321_MEMORY*`, `CLAUDE.md`, or auto-memory - those are owned by `/watsession-update` and `/watmemory-update`. If findings warrant updates to those, flag them at the end for the user to run the appropriate skill.

**No subagents.** Per auto-memory `feedback_no_subagents_for_review.md`: codebase reviews and dev-standards audits run in the main loop via Read / Grep / Glob. Subagents mean the reviewer doesn't actually see the files.

## Modes (flags)

**Default (no flag):** intelligent audit. Applies dev standards, checks semantic naming, finds stale/misnamed/dead code, polices comments, surfaces pain points as forward-looking takeaways, sweeps for edge cases, dedupes, queries `context7` where uncertainty warrants it, applies safe optimizations. Writes changes. Does NOT aggressively refactor file layouts.

**`-READ`:** read-only familiarization. Thorough codebase walk + DEV_STANDARDS reread. Output a findings summary without applying anything. Use when onboarding a new session, resuming after a long gap, or wanting to understand the codebase before touching it.

**`-FULL`:** default audit + cohesion-aware refactor of 300+ line files. Judgment required - never split to hit a number. Anchor principle: cohesion is the rule, 300 lines is the inspection threshold (not a hard ceiling). A 500-line file that does one thing well beats three fragmented 150-line files that constantly import each other.

Usage: `/watdev-standards`, `/watdev-standards -READ`, `/watdev-standards -FULL`.

## Step 0: Parse flag + load standards

Determine mode from the flag. Output chosen mode + reason at start.

Read `AIDOCS/WD_WAT321_DEV_STANDARDS.md` in full. **This is the authoritative source for all code standards.** The skill enforces what's in that file - it does not introduce its own rules. If a rule needs to change or a new rule belongs in this audit, edit DEV_STANDARDS first; the skill picks it up on the next run.

## Step 1: Quality gates (gate - all modes)

Run `npm run build`. If it fails, stop and report. Do not proceed with audit steps until build is clean. A broken baseline invalidates the rest of the work.

## Step 2: Thorough codebase read (all modes)

Walk `src/` file by file using Read / Grep / Glob in the main loop. No subagents.

For each file, check it against every section of `WD_WAT321_DEV_STANDARDS.md` you loaded in Step 0:

- TypeScript rules
- Naming
- Comment policy
- File organization
- Dependency direction (including type-only imports)
- Modern patterns (committed)
- Linter (em-dash + arrow scan, console.log / appendLine allow-list)
- Error messages
- VS Code API notes
- Settings invariants

Flag every drift. The DEV_STANDARDS doc is the source of truth - the categories above are pointers, not the rule definitions. If a check feels missing, add the rule to DEV_STANDARDS first, then re-run.

**Sweeps that span multiple files** (run once per audit, not per file):

- `git grep -nP '[\x{2014}\x{2192}\x{2190}\x{2191}\x{2193}\x{2194}\x{2195}]'` inside `src/` for em-dash + arrow chars.
- `grep events.on` (or equivalent for the dispatch surface) to catch events declared and emitted with zero subscribers - per the anti-speculation rule in DEV_STANDARDS.
- For every `"scope": "application"` key in `package.json`, verify presence in `src/shared/workspaceScopeHeal.ts:APPLICATION_SCOPE_KEYS` AND `src/shared/resetSettings.ts:performClear` per the Settings invariants section.
- `grep writeFileSync` to catch persistent writes that bypass `shared/fs/atomicWrite.ts:writeFileAtomic` without a documented reason.

**On `-READ` mode:** stop after this step, output the summary in Step 8 format, do NOT apply anything. Exit.

## Step 3: Apply safe fixes (default + `-FULL`)

For findings that are clearly safe to fix without changing behavior:
- Remove unused imports (eslint flags many; catch the rest)
- Consolidate obvious dedup candidates into shared helpers
- Rename misaligned identifiers when scope is local (avoid cross-file renames without deliberation)
- Strip history/narration comments per policy; reframe pain points as forward-looking takeaways
- Convert magic numbers to named constants in the nearest constants file
- Extract shared helpers when duplication is genuinely identical (prefer helpers over inheritance per the user's refactor philosophy)

Skip anything uncertain. Flag for review rather than fix blindly.

## Step 4: Context7 lookups (default + `-FULL`, targeted)

When the codebase walk surfaced uncertain API usage, deprecated-looking patterns, or potentially-simpler modern alternatives - query `context7` for the relevant library. Targeted only (not blanket). Applies to:
- VS Code API (`vscode` module)
- Node.js `fs` / `child_process` / `os`
- `@modelcontextprotocol/sdk` (used by the Epic Handshake channel server)
- TypeScript 6 patterns

If a modern pattern would meaningfully improve a file, apply it. Otherwise, log the finding for DEV_STANDARDS update.

## Step 5: Cohesion-aware refactor (`-FULL` only)

Find files over 300 lines in `src/`:
```bash
find src -name "*.ts" | xargs wc -l | sort -rn | head -30
```

**Cohesion is the anchor.** The 300-line bar means "look closer," not "must split." For each file above the threshold, assess:
1. Does the file have a single clear purpose? If yes -> leave it.
2. Are there genuinely independent concerns (no shared state, no cross-imports between the extracted pieces)? Only split if yes.
3. Would splitting reduce or increase cognitive load for a reader navigating the code?

Never split to hit a number. A 500-line file with cohesion is better than three fragmented 150-line files.

When splitting, preserve the semantic naming convention (`threadRecord.ts` + `threadNaming.ts` + `sessionRecovery.ts` is better than `threadPersistence.ts` split into `threadPersistence1.ts` + `threadPersistence2.ts`). Propose each split to the user before executing; skip on any "no."

**Output a per-file verdict** for every file above the threshold, keep or split, with a one-line reason. Silence on a 400-line file leaves the reader guessing whether it was reviewed and intentionally kept, or skipped.

**Do NOT refactor:**
- `src/WAT321_EPIC_HANDSHAKE/bin/` (runtime bundled; channel.mjs is delivered to `~/.wat321/` and resolves its own deps)
- Config files (`tsconfig.json`, `package.json`, `eslint.config.*`)
- Generated (`out/`, `node_modules/`)

## Step 6: Final quality gates (all modes except `-READ`)

```
npm run build
npm run package
```

Both must pass. `npm run package` catches content surface issues (e.g. `vsce` errors) that `npm run build` misses.

## Step 7: Surface DEV_STANDARDS update suggestions

Review what the audit revealed that might warrant updating `WD_WAT321_DEV_STANDARDS.md` itself. New conventions, modern patterns confirmed via context7, drift patterns worth codifying.

**Output suggestions only - do not edit the standards file.** The user decides whether to apply them (and may want to amend before applying).

Format:
```
DEV_STANDARDS suggestions (not applied):
- <suggestion 1>
- <suggestion 2>
```

## Step 8: Summary + cross-track flags

```
/watdev-standards <MODE> complete.

Standards applied:     <count> violations fixed
Stale code removed:    <count> unused imports/exports/dead blocks
Comments reworked:     <count> (history stripped / pain-points reframed)
Dedup consolidations:  <count>
context7 lookups:      <count> (<libraries queried>)
Files refactored:      <list - empty if not -FULL>
Quality gates:         <passing / <failure details>>

DEV_STANDARDS suggestions: <count surfaced>

Cross-track flags (run when convenient):
  - /watsession-update: <flag if in-flight items surfaced>
  - /watmemory-update:  <flag if new process rule or architecture change surfaced>
```

## Rules (skill operation only)

The code rules live in `WD_WAT321_DEV_STANDARDS.md`. The bullets below are how this *skill* operates, not what code standards to apply.

- **DEV_STANDARDS is the source of truth.** If a code rule needs to change, edit DEV_STANDARDS first; the skill picks it up on the next run.
- **No subagents.** Codebase walks run in the main loop via Read / Grep / Glob.
- **Cohesion > line count.** Never split to hit 300. Output a per-file keep/split verdict on every threshold crossing.
- **Stay in scope.** Only touch `src/`. Do not write to Session or Memory tracks - flag instead.
- **Confidence-gate deletions.** If unsure whether code is dead, leave it and flag.
- **context7 is targeted.** Don't query on every file; trigger only when the audit finds uncertainty.
