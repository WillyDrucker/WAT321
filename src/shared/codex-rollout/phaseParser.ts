import {
  getPayloadType,
  splitLines,
  tryParseEntry,
} from "./rolloutEntry";

/**
 * Pure parsers for Codex rollout JSONL tails. No fs, no watchers,
 * no state. Callers supply a tail buffer they already have.
 *
 * Used by:
 *   - Codex session token widget (tooltip richness, active tool name)
 *   - Epic Handshake bridge dispatcher (adaptive stall detection)
 *
 * The big single-pass `parseStageInfo` state machine lives in the
 * sibling `stageInfoParser.ts`. Internal entry-shape helpers live
 * in `rolloutEntry.ts`. Display-string builders (label / plan /
 * tool line renderers) live in `phaseRender.ts`. Splitting parser
 * core from rendering keeps the one-pass walk cohesive and lets
 * the tooltip layer evolve without touching parsing.
 *
 * Codex rollout event shapes captured empirically from real session
 * runs - see `WDDOCS/EPIC_HANDSHAKE/WAT321_EPIC_HANDSHAKE_PLAN.md`
 * section 7.1 for the inventory.
 */

/** Re-export so callers can still import `parseStageInfo` from
 * this module path. */
export { parseStageInfo } from "./stageInfoParser";

/** Slice a rollout tail to the lines belonging to the most recent
 * turn. A turn begins at an `event_msg > task_started` entry - every
 * prior turn is dropped. Returns the full tail unchanged when no
 * `task_started` is found (pre-turn or tail window too small to
 * include the boundary). Used by `parseStageInfo` for turn-scoped
 * state and by `tryRolloutRecovery` to confine assistant-text
 * extraction to the just-completed turn. */
export function extractCurrentTurn(tail: string): string {
  const lines = splitLines(tail);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = tryParseEntry(lines[i]);
    if (!entry) continue;
    if (
      entry.type === "event_msg" &&
      getPayloadType(entry) === "task_started"
    ) {
      return lines.slice(i).join("\n");
    }
  }
  return tail;
}
