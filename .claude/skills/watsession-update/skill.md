---
name: watsession-update
description: Update WD_WAT321_SESSION_HANDOFF (one-liners) and WD_WAT321_SESSION_HANDOFF_EXTENDED (detail) for the active branch. Also updates CHANGELOG [Unreleased] bullets. Project-work only.
---

**Invocation:** standalone (mid-session checkpoint) or via `/wat-publish` (as Step 1). Behavior identical in both modes.

This skill is part of **System 1: Session (project work)**. It does NOT touch `CLAUDE.md`, `WD_WAT321_MEMORY.md`, `WD_WAT321_MEMORY_EXTENDED.md`, `WD_WAT321_DEV_STANDARDS.md`, or auto-memory. Those are owned by `/watmemory-update`.

## Step 0: Detect update mode (skim / incremental / full)

**Default: intelligence-derived** (no flag). Cheap signals decide the mode - skim when verifiably clean, incremental for small deltas, full when trust is reduced. Skill outputs the chosen mode + reason at start so the user can abort and rerun with a different flag.

**Override flags:**
- `-FULL` - force full mode. Use when you don't trust the signals (returned after a long gap, visible signs the session got confused, or you just want a thorough pass)
- `-SKIM` - force skim mode (verify-only). Use when you know nothing substantive happened but want the doc refreshed

Usage: `/watsession-update`, `/watsession-update -FULL`, `/watsession-update -SKIM`.

**SKIM safety rail:** SKIM is only chosen when BOTH are true:
1. Zero new commits since `Last Updated:` (`git log main..HEAD --oneline | wc -l` = 0)
2. Zero new uncommitted work items visible in the conversation that aren't already represented in HANDOFF or HANDOFF_EXTENDED

If either fails, escalate to at least INCREMENTAL. This prevents silently missing work.

**Auto-detection signals (concrete, not vibes):**

1. **Compaction boundary** - scan conversation for a compact/summarization marker (message like "This session is being continued from a previous conversation..."). If found, **auto-escalate to full mode** - conversation history was summarized, trust is reduced.
2. **Commit-count gap** - run `git log main..HEAD --oneline | wc -l`. Compare to commits already represented in the Handoff's "Recently Shipped" or extended anchors:
   - 0 new commits + no uncommitted new work in the conversation -> **skim**
   - 1-3 new commits or items -> **incremental**
   - 4+ new commits OR uncertainty about what's represented -> **full**
3. **Last Updated freshness** - if `Last Updated:` timestamp on SESSION_HANDOFF is older than today's date by more than one calendar day AND there are new commits, prefer full.

**Modes:**

- **Skim mode** - target files are fresh, verify cross-refs still resolve, confirm no orphans (HANDOFF one-liner exists but HANDOFF_EXTENDED section was deleted, or vice-versa), confirm no stale bullets referencing committed work. If clean: output "already up to date, verified clean" and exit. Do NOT rewrite existing content.
- **Incremental mode** - read only the new commits + conversation since `Last Updated`. Add / update / prune ONLY the items that changed. Leave the rest untouched.
- **Full mode** - full pass: read everything, summarize, allocate, prune, write. Used when the conversation's state-completeness can't be trusted (compaction, long gap, explicit user request).

**Default bias:** skim > incremental > full. Only escalate when a concrete signal says to.

Output the detected mode (and why) at the start of the run so the user sees what's happening and can abort + rerun with a different arg if wrong.

## Step 1: Gather context

Read silently:
- `AIDOCS/WD_WAT321_SESSION_HANDOFF.md` - current-state bullets
- `AIDOCS/WD_WAT321_SESSION_HANDOFF_EXTENDED.md` - detail layer
- `CHANGELOG.md` `[Unreleased]` block (if present; otherwise look at the current version section)

Git context:
- `git branch --show-current`
- `git status --short`
- `git log --oneline -10`
- `git log main..HEAD --oneline`

Review the conversation (from the `Last Updated` marker forward) for:
- Work completed this session
- Uncommitted design decisions with reasoning
- New known issues / blockers
- Next steps teed up

## Step 2: Allocate each item to exactly one file

Apply the allocation rule:

| Item type | Destination |
|---|---|
| Current state (branch, build, version, test-instance) | `SESSION_HANDOFF` (update Current State section) |
| In-flight work (uncommitted, still iterating) | `SESSION_HANDOFF` as one-liner **+** `SESSION_HANDOFF_EXTENDED` as named section with full context (cross-ref between them) |
| Recently shipped this branch (not yet in a released `[X.X.X]` CHANGELOG section) | `SESSION_HANDOFF` under "Recently Shipped" as one-liner + `CHANGELOG` `[Unreleased]` as lean human-readable bullet |
| Next steps / queued work | `SESSION_HANDOFF` Next Steps as one-liner |
| Files / directories to watch | `SESSION_HANDOFF` Files To Watch |

**Do NOT write to MEMORY / MEMORY_EXTENDED / DEV_STANDARDS / CLAUDE.md / auto-memory.** If the conversation produced architecture rule changes, process rule changes, or cross-cutting pitfall root-causes, flag them in the Step 5 summary so the user can run `/watmemory-update` later.

### CHANGELOG tone (if writing bullets)

Human-readable, not technical. Bold one-liner statement first, short prose explanation. Bias prose over lists. Single technical reference at end max. Never lead with version / file / PR / issue. Use "you"/"your". See auto-memory `feedback_changelog_tone.md` for the full rule and the `[1.0.11]` reference voice in CHANGELOG itself.

## Step 3: Prune before appending

**SESSION_HANDOFF pruning:**
- If a "Recently Shipped" bullet is now in CHANGELOG under a released `## [X.X.X]` section (not `[Unreleased]`), drop it
- Next Steps that are now done -> drop
- Known issues that are now resolved -> drop

**SESSION_HANDOFF_EXTENDED pruning:**
- Entries tagged to a released version older than 2 shipped releases -> drop, unless marked with `<!-- LOAD_BEARING -->`
- Entries whose in-flight item is dropped from SESSION_HANDOFF -> drop the extended entry too

**CHANGELOG pruning:**
- Don't add or remove version sections here - only update `[Unreleased]`. Version promotion is `/wat-publish`'s job.

Target sizes: SESSION_HANDOFF 150-200 lines, SESSION_HANDOFF_EXTENDED 500-1000 lines. If either exceeds, prune harder before appending.

## Step 4: Apply updates

Write updates in this order:
1. **SESSION_HANDOFF** `Last Updated:` + `Updated By:` timestamps
2. **SESSION_HANDOFF** section updates (Current State, In Flight, Recently Shipped, Next Steps, Files To Watch)
3. **SESSION_HANDOFF_EXTENDED** new named sections for in-flight items; prune old sections
4. **CHANGELOG** `[Unreleased]` bullets if new shipped work; derive from SESSION_HANDOFF one-liners + code context

Cross-refs: every SESSION_HANDOFF in-flight bullet MUST point at its `HANDOFF_EXTENDED#anchor`. Use markdown heading-id convention (lowercase kebab, punctuation stripped).

## Step 5: Display summary

```
watsession-update complete.

SESSION_HANDOFF:         <lines before> -> <lines after> (<added/dropped>)
SESSION_HANDOFF_EXTENDED: <lines before> -> <lines after> (<added/dropped>)
CHANGELOG [Unreleased]:   <bullets added>

Flagged for /watmemory-update (if any):
  - <architecture rule change or process pitfall surfaced>
  - (or) No memory-track updates needed.
```

If no flags, the user continues without invoking `/watmemory-update`. If flags surfaced, the user decides when to run it.

## Rules

- **Project work only.** Touch Session-track files and CHANGELOG. Nothing else.
- **Prune before appending.** Size targets are hard limits; blow through them only with a deliberate decision.
- **One fact, one file.** No paraphrasing HANDOFF into EXTENDED into CHANGELOG; each has a distinct job.
- **Cross-refs, not copies.** SESSION_HANDOFF bullets point at HANDOFF_EXTENDED anchors for detail.
- **Never delete uncommitted work entries** without a visible reason (in-flight bullets stay until the work ships or is abandoned).
- **No subagents.** Read the files and the conversation directly via Read / Grep / Glob in the main loop.
