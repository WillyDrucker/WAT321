import {
  argumentsPreview,
  getPayloadField,
  getPayloadType,
  parsePlanArguments,
  splitLines,
  tryParseEntry,
} from "./rolloutEntry";
import type { PlanState, ToolCall } from "./types";

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

const MAX_TOOL_HISTORY_SCAN = 500;

/** Re-export so callers can still import `parseStageInfo` from
 * this module path. */
export { parseStageInfo } from "./stageInfoParser";

/** Slice a rollout tail to the lines belonging to the most recent
 * turn. A turn begins at an `event_msg > task_started` entry; every
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

/** Return the most recent `update_plan` function_call's plan array
 * within the current turn, or null if the current turn has no
 * `update_plan` invocations. Turn-scoped via `extractCurrentTurn`
 * so a plan from a prior turn does not leak into this turn's view.
 * Walks backwards for efficiency on long tails. */
export function parseActivePlan(tail: string): PlanState | null {
  const scoped = extractCurrentTurn(tail);
  const lines = splitLines(scoped);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = tryParseEntry(lines[i]);
    if (!entry) continue;
    if (
      entry.type !== "response_item" ||
      getPayloadType(entry) !== "function_call" ||
      getPayloadField<string>(entry, "name") !== "update_plan"
    ) {
      continue;
    }
    const argsRaw = getPayloadField<unknown>(entry, "arguments");
    const plan = parsePlanArguments(argsRaw);
    if (plan !== null) return plan;
  }
  return null;
}

/** Return every tool call in the current turn in chronological
 * order, pairing each `function_call` with its
 * `function_call_output` via `call_id` when the output is present.
 * Turn-scoped via `extractCurrentTurn` so prior turns' tools do
 * not inflate the history. Capped at the most recent
 * `MAX_TOOL_HISTORY_SCAN` lines so the walk stays bounded for very
 * long turns. */
export function parseToolCallHistory(tail: string): ToolCall[] {
  const scoped = extractCurrentTurn(tail);
  const lines = splitLines(scoped);
  const start = Math.max(0, lines.length - MAX_TOOL_HISTORY_SCAN);
  const calls: ToolCall[] = [];
  const indexByCallId = new Map<string, number>();

  for (let i = start; i < lines.length; i++) {
    const entry = tryParseEntry(lines[i]);
    if (!entry) continue;
    if (entry.type !== "response_item") continue;
    const payloadType = getPayloadType(entry);

    if (payloadType === "function_call") {
      const name = getPayloadField<string>(entry, "name") ?? "";
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      const argsRaw = getPayloadField<unknown>(entry, "arguments");
      const tool: ToolCall = {
        name,
        callId,
        timestamp: entry.timestamp,
        argumentsPreview: argumentsPreview(argsRaw),
        completed: false,
      };
      if (callId) indexByCallId.set(callId, calls.length);
      calls.push(tool);
      continue;
    }

    if (payloadType === "function_call_output") {
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      if (!callId) continue;
      const idx = indexByCallId.get(callId);
      if (idx !== undefined) {
        calls[idx] = { ...calls[idx], completed: true };
      }
    }
  }
  return calls;
}
