import {
  getPayloadType,
  splitLines,
  tryParseEntry,
} from "./rolloutEntry";

/**
 * Turn scoping for Codex rollout tails. Pure over a tail the caller
 * already read. Shared by the stage parser and the Epic Handshake reply
 * recovery, so both see the same turn boundary.
 */

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
