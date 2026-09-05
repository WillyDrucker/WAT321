import type { PlanState, PlanStep } from "./turnStageTypes";
import { BRIDGE_STAGE_ORDER, type BridgeStage } from "../../engine/bridgeTypes";

/**
 * Internal helpers for Codex rollout JSONL parsing. Entry-shape
 * extraction, monotonic stage advancement, plan-argument parsing,
 * and small text conversions. Consumed by `phaseParser.ts` and
 * `stageInfoParser.ts`.
 *
 * All helpers are pure. Malformed JSON / missing fields fall through
 * to null / 0 / "" so the parsers never throw on a partial rollout.
 */

interface RolloutEntry {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
}

const ARGS_PREVIEW_LEN = 200;

export function splitLines(tail: string): string[] {
  return tail.split("\n");
}

export function* iterParsedEntries(
  lines: string[]
): Iterable<RolloutEntry> {
  for (const line of lines) {
    const entry = tryParseEntry(line);
    if (entry) yield entry;
  }
}

export function tryParseEntry(line: string): RolloutEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.type !== "string"
    ) {
      return null;
    }
    const payload =
      typeof parsed.payload === "object" && parsed.payload !== null
        ? (parsed.payload as Record<string, unknown>)
        : undefined;
    return { timestamp: parsed.timestamp, type: parsed.type, payload };
  } catch {
    return null;
  }
}

export function getPayloadType(entry: RolloutEntry): string | null {
  const t = entry.payload?.type;
  return typeof t === "string" ? t : null;
}

export function getPayloadField<T>(
  entry: RolloutEntry,
  field: string
): T | undefined {
  return entry.payload?.[field] as T | undefined;
}

/** Monotonic stage advance: once a later stage is reached, never
 * regress. Codex emits events in rough chronological order but a
 * late `function_call` after `task_complete` is a no-op. */
export function advanceStage(
  current: BridgeStage,
  candidate: BridgeStage
): BridgeStage {
  const currentIdx = BRIDGE_STAGE_ORDER.indexOf(current);
  const candidateIdx = BRIDGE_STAGE_ORDER.indexOf(candidate);
  return candidateIdx > currentIdx ? candidate : current;
}

/** Parse the `arguments` field of an `update_plan` function_call.
 * Accepts either the stringified-JSON shape observed in captured
 * rollouts or a pre-parsed object (future-compat for a schema that
 * inlines structured payload). Null on any failure so callers fall
 * back to the previous plan snapshot. */
export function parsePlanArguments(argsRaw: unknown): PlanState | null {
  if (argsRaw === null || argsRaw === undefined) return null;
  let parsed: { plan?: Array<{ step?: unknown; status?: unknown }> };
  if (typeof argsRaw === "string") {
    if (argsRaw.length === 0) return null;
    try {
      parsed = JSON.parse(argsRaw) as typeof parsed;
    } catch {
      return null;
    }
  } else if (typeof argsRaw === "object") {
    parsed = argsRaw as typeof parsed;
  } else {
    return null;
  }
  const planArray = parsed.plan;
  if (!Array.isArray(planArray)) return null;
  const steps: PlanStep[] = [];
  for (const entry of planArray) {
    const step = typeof entry.step === "string" ? entry.step : "";
    const status = entry.status;
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed"
    ) {
      continue;
    }
    steps.push({ step, status });
  }
  if (steps.length === 0) return null;
  const currentIndex = steps.findIndex((s) => s.status === "in_progress");
  return { steps, currentIndex, totalSteps: steps.length };
}

export function parseIsoMs(iso: string): number | null {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Truncate a function_call `arguments` field to a display-friendly
 * preview regardless of whether Codex emitted it as a JSON string
 * or an already-parsed object. Non-serializable shapes return ""
 * so callers don't have to guard. */
export function argumentsPreview(args: unknown): string {
  if (typeof args === "string") return args.slice(0, ARGS_PREVIEW_LEN);
  if (args === null || args === undefined) return "";
  try {
    return JSON.stringify(args).slice(0, ARGS_PREVIEW_LEN);
  } catch {
    return "";
  }
}
