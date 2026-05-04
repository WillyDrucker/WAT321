---
name: watmemory-update
description: Ultra-lean updates to CLAUDE.md, WD_WAT321_MEMORY, WD_WAT321_MEMORY_EXTENDED, WD_WAT321_DEV_STANDARDS, and auto-memory. Process + architecture only, never project-specific work. Manual invocation only.
---

**Invocation:** manual only. NEVER invoked by `/wat-publish` or `/watsession-update`.

**Filter ruthlessly:** most sessions produce NO memory-track changes. Only architecture changes, new process pitfalls with root cause, user corrections that become sticky rules, and load-bearing read-order updates qualify. If in doubt, do not write.

This skill is part of **System 2: Memory (meta/process)**. It does NOT touch `WD_WAT321_SESSION_HANDOFF`, `WD_WAT321_SESSION_HANDOFF_EXTENDED`, or `CHANGELOG`. Those are owned by `/watsession-update`.

## Tier size targets (guidance for placement)

Every memory-track file has a role + a target line count. Higher tiers stay lean; detail lives at the lowest tier where it still makes sense:

| File | Target | Role | Prune posture |
|---|---|---|---|
| `CLAUDE.md` | 80-120 lines | orchestrator + read orders + product principles + key rules. Architectural detail does NOT live here. Version stamps for OUR versions never live here. | edit-on-change only. No proactive prune cycle. |
| `WD_WAT321_MEMORY.md` | 60-150 lines | stable architecture one-liners + invariants + key-pitfall index. Root causes do NOT live here. | edit-on-change only. No proactive prune cycle. |
| `WD_WAT321_MEMORY_EXTENDED.md` | 100-300 lines | pain points + carried-forward pitfalls a future session needs to avoid re-creating problems. NOT architecture documentation - the code + its comments are the source for "what does it do." This file is for "what bites you if you don't know about it." | **actively pruned every incremental + full pass.** The keep-test for any entry: would a future session re-create the problem (or fail to recover from it) without this written down? If "they'd just read the code", drop it. |
| `WD_WAT321_DEV_STANDARDS.md` | 150-250 lines | code patterns + commands + comment policy. Source of truth for the `/watdev-standards` skill. | edit-on-change only. No proactive prune cycle. |
| Auto-memory feedback files | one rule per file, 10-30 lines each | sticky rules from explicit user corrections / confirmations. | edit-on-change only. |

**Active pruning is `MEMORY_EXTENDED` only.** That file is the scratchpad - it accumulates the most and decays the fastest. Other tiers are stable; they're touched only when a finding requires it. Migrating content down a tier is allowed and encouraged on any pass that surfaces wrong-tier content - just don't run a proactive prune cycle on the higher tiers.

## Step 0: Detect update mode (skim / incremental / full)

**Default: intelligence-derived** (no flag). Because memory-track updates are rare by design, the default should land on skim (no change) most of the time. Skill outputs the chosen mode + reason at start.

**Override flags:**
- `-FULL` - force full mode. Use after a major restructure, long gap, or when you know memory-track items accumulated
- `-SKIM` - force skim (verify-only)

Usage: `/watmemory-update`, `/watmemory-update -FULL`, `/watmemory-update -SKIM`.

**SKIM safety rail:** SKIM is only chosen when ALL are true:
1. Zero new architecture facts or infrastructure changes surfaced in the conversation
2. Zero new sticky rules or user corrections stated by the user this session
3. Zero new cross-cutting pitfalls discovered with root-cause evidence

If any fails, escalate to INCREMENTAL.

**Auto-detection signals (concrete, not vibes):**

1. **Compaction boundary** - scan conversation for a compact marker. If found, auto-escalate to full mode - conversation history was summarized, trust is reduced.
2. **New architecture or sticky-rule signal in conversation** - at least one concrete finding that warrants a change?
   - 0 new items surfaced -> **skim**
   - 1-3 new items -> **incremental**
   - 4+ or explicit restructure request -> **full**

**Modes:**

- **Skim mode** - verify cross-refs and no orphans across CLAUDE.md / MEMORY / MEMORY_EXTENDED / DEV_STANDARDS / auto-memory. If clean: output "memory track clean, nothing to update" and exit. Memory-track updates should be rare - skim -> exit is the expected path for most sessions.
- **Incremental mode** - propose only the specific new items surfaced. Do NOT rewrite existing content.
- **Full mode** - complete pass. Read everything, reconcile, prune, rewrite as needed.

**Default bias:** skim > incremental > full. Memory-track updates are consequential - if uncertain, prefer the lighter mode and flag follow-up.

Output the detected mode at the start of the run.

## Step 1: Gather context

Read silently:
- `CLAUDE.md` - orchestrator + read orders
- `AIDOCS/WD_WAT321_MEMORY.md` - architecture + key pitfalls
- `AIDOCS/WD_WAT321_MEMORY_EXTENDED.md` - process scratchpad
- `AIDOCS/WD_WAT321_DEV_STANDARDS.md` - code patterns (rarely updated by this skill)
- Auto-memory index at `C:/Users/WD/.claude/projects/c--Dev-WAT321/memory/MEMORY.md` and the feedback + reference files it links

Scan the current conversation for:
- User corrections or preferences that haven't been captured as sticky rules (-> auto-memory feedback file)
- Architecture changes (new shared modules, new tier boundaries, new invariants) (-> `WD_WAT321_MEMORY`)
- New pitfalls discovered with root-cause understanding (-> `WD_WAT321_MEMORY_EXTENDED` and one-liner cross-ref in `WD_WAT321_MEMORY#key-pitfalls`)
- Read-order changes needed (new doc layer, new top-level file) (-> `CLAUDE.md`)
- Code-patterns / naming / comment-policy changes (-> `WD_WAT321_DEV_STANDARDS`)
- Sticky rules the user explicitly stated (-> auto-memory feedback file)

## Step 1.5: Tier audit (incremental + full modes)

Before allocating new findings, sweep the existing files for two failure modes that compound over time:

**Stale claims.** Architectural facts, file references, version-tagged narratives, or invariant lists that no longer match the code. Verify each load-bearing claim against `git ls-files src/` or a quick `grep` - claims about deleted modules, renamed symbols, removed event types, or superseded designs all qualify. Common in MEMORY (architecture statements drift after refactors) and in carried-forward pitfalls (issue numbers that closed, mitigations that got replaced by a better design).

**Wrong-tier content.** Content that exists at a higher tier than its detail level warrants:
- CLAUDE.md describing module-level architecture that belongs in MEMORY.
- MEMORY listing root causes / formulas / thresholds that belong in MEMORY_EXTENDED.
- MEMORY_EXTENDED carrying code patterns / commands that belong in DEV_STANDARDS.

For each wrong-tier item: **migrate down**, leaving at most a one-liner pointer at the original tier (or no pointer at all if the receiving tier is read in the same session-start sequence).

This step is the leanness enforcement mechanism. Without it, top-level files grow whenever a session adds an architectural narrative, and pruning never happens because the skill only audits "new" content.

## Step 2: Filter brutally

For each finding, ask:
1. **Is this project-specific work?** -> stop. That goes via `/watsession-update`. Not this skill's domain.
2. **Does it affect how ANY future session approaches the project?** -> proceed.
3. **Is it already captured somewhere in the memory track?** -> stop. Update there if stale, but don't duplicate.
4. **Can a future session derive this from code?** -> stop. Code is authoritative.
5. **Has it been observed or stated with user confirmation?** -> HIGH confidence, include.
6. **Surfaced once with strong root-cause evidence?** -> MEDIUM, include with rationale.
7. **Speculative or inferred?** -> stop. Do not include.

If nothing passes the filter, output "No memory-track updates needed" and exit.

## Step 3: Allocate per file

| Item type | Destination |
|---|---|
| Read-order change (new doc layer, new top-level file) | `CLAUDE.md` (orchestrator) |
| New or changed stable architecture fact | `WD_WAT321_MEMORY` (matching section) |
| New key pitfall (one-liner awareness) | `WD_WAT321_MEMORY#key-pitfalls` (one-liner) + `WD_WAT321_MEMORY_EXTENDED#carried-forward-pitfalls` (root cause) |
| New cross-cutting process pattern | `WD_WAT321_MEMORY_EXTENDED` |
| Code-pattern / naming / comment policy change | `WD_WAT321_DEV_STANDARDS` |
| New sticky rule from user correction | auto-memory: new `feedback_*.md` file + index entry in `MEMORY.md` |
| User preference update (rarely applicable) | auto-memory `user_profile.md` - lean updates only; do not expand beyond factual |
| Updated cross-referenced infra facts | auto-memory `reference_*.md` files |

## Step 4: Propose changes BEFORE writing

Display a compact proposal:

```
watmemory-update proposal
=========================

CLAUDE.md: [edit / no change]
  - <one-line description of change>

WD_WAT321_MEMORY.md: [edit / no change]
  - <section>: <one-line description>

WD_WAT321_MEMORY_EXTENDED.md: [edit / no change]
  - <add: X / update: Y / drop: Z>

WD_WAT321_DEV_STANDARDS.md: [edit / no change]
  - <one-line description>

Auto-memory: [new feedback file / update reference file / no change]
  - <file>: <one-line description>

Estimated: ~X lines added, ~Y lines pruned
```

**Wait for user approval before executing.** Unlike `/watsession-update` (which auto-applies), memory-track updates are consequential and warrant a confirm.

## Step 5: Execute approved changes

Rules:
- **Prune before appending, at every tier.** Check the size of every file being touched against its tier-size target (see top of skill). If over target, prune stale or wrong-tier content before adding. Migrate down rather than letting a higher tier grow.
- **One fact, one file.** Do not duplicate between MEMORY and MEMORY_EXTENDED. MEMORY = one-liner rule; MEMORY_EXTENDED = root cause. MEMORY and DEV_STANDARDS don't overlap either - MEMORY is "what the system is," DEV_STANDARDS is "how we write code for it."
- **User profile stays lean.** No interpretation, no personality summaries, no "Will prefers X" unless the user explicitly stated it this session.
- **Feedback files need name, why, and how to apply.** Three-line minimum structure per the auto-memory conventions.

## Step 6: Display summary

```
watmemory-update complete.

CLAUDE.md:                 [updated / unchanged]
WD_WAT321_MEMORY:          <lines before> -> <lines after>
WD_WAT321_MEMORY_EXTENDED: <lines before> -> <lines after>
WD_WAT321_DEV_STANDARDS:   <lines before> -> <lines after>
Auto-memory:               [new: feedback_X.md / updated: Y / unchanged]
```

## Rules

- **Ruthless filter.** Default is no change. Most sessions produce project work, not memory-track changes.
- **Manual only.** Never called from `/wat-publish` or `/watsession-update`.
- **Propose before writing.** Always a confirm step.
- **Active pruning is MEMORY_EXTENDED only.** That file is pain-points-only - prune aggressively to stay in 100-300. Other tiers are edit-on-change; do not run a proactive prune cycle on CLAUDE.md / MEMORY / DEV_STANDARDS / auto-memory.
- **MEMORY_EXTENDED keep-test.** "Would a future session re-create the problem (or fail to recover from it) without this written down?" If the answer is "they'd just read the code" - drop it. If it's well-commented in code with the same explanation - drop it. If it's just describing what the code does without the "what bites you if you don't know" - drop it. Version stamps for resolved-and-not-monitored items - drop. Issue numbers for closed issues no longer being watched - drop.
- **Audit existing content every incremental + full pass.** Step 1.5 is mandatory: sweep for stale claims and wrong-tier content across all tiers. Stale claims get fixed in place at any tier; wrong-tier content migrates down. Pruning content (dropping, not relocating) is the MEMORY_EXTENDED-only action.
- **Never duplicate content** between MEMORY and MEMORY_EXTENDED. One-liners in MEMORY, detail in MEMORY_EXTENDED.
- **Auto-memory `user_profile` edits are rare.** Factual updates only.
- **Never write project-specific content.** If the finding is about a specific feature, provider, or ship event, stop - that's `/watsession-update`'s domain.
- **No subagents.** Read files and conversation directly via Read / Grep / Glob in the main loop.
