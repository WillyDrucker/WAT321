import type {
  BridgeStage,
  PlanState,
  PlanStep,
  StageInfo,
  ToolCall,
} from "./types";

/**
 * Pure parsers for Codex rollout JSONL tails. No fs, no watchers,
 * no state. Callers supply a tail buffer that they already have.
 *
 * Used by:
 *   - Codex session token widget (tooltip richness, active tool name)
 *   - Epic Handshake bridge dispatcher (adaptive stall detection)
 *
 * Two consumers, one parsing surface. Codex rollout event shapes
 * captured empirically from real session runs - see
 * `WDDOCS/EPIC_HANDSHAKE/WAT321_EPIC_HANDSHAKE_PLAN.md` section 7.1
 * for the inventory.
 *
 * Display-string builders (StageDisplay, label/plan/tool line renderers)
 * live in `phaseRender.ts`. Splitting parser core from rendering keeps
 * the one-pass walk in `parseStageInfo` cohesive and lets the tooltip
 * layer evolve without touching parsing.
 */

const MAX_TOOL_HISTORY_SCAN = 500;
const ARGS_PREVIEW_LEN = 200;

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

/** Compose the full StageInfo snapshot from one tail read. Scoped to
 * the most recent turn via `extractCurrentTurn` so stage, elapsed,
 * tool counts, plan state, and token breakdown all reflect current-
 * turn activity only. Long-lived rollouts contain many prior turns;
 * reading them unscoped would pollute every field and latch stage
 * permanently at `complete`.
 *
 * Cheap to call on every poll tick (15s in session tokens, 5s in
 * the bridge monitor) - a single pass over the scoped tail. */
export function parseStageInfo(tail: string): StageInfo {
  const scoped = extractCurrentTurn(tail);
  const lines = splitLines(scoped);

  let stage: BridgeStage = "dispatched";
  let taskStartedAt: number | null = null;
  let plan: PlanState | null = null;
  let toolCallCount = 0;
  let activeTool: ToolCall | null = null;
  let reasoningTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let inputTokens = 0;
  const tryAdvance = (target: BridgeStage): void => {
    stage = advanceStage(stage, target);
  };

  const pendingByCallId = new Map<string, ToolCall>();
  const completedCallIds = new Set<string>();
  /** Count of assistant-role response_item/message entries seen in
   * this turn so far. Codex emits two per turn in every observed
   * rollout: one for the commentary preamble ("I'm checking X first")
   * and one for the final answer. When the count crosses to >= 2 the
   * second message IS the final-answer text, equivalent to seeing
   * `event_msg/agent_message phase=final_answer`. Used as a defensive
   * fallback if a future Codex rollout schema changes the phase tag
   * wording or omits the agent_message event entirely. */
  let assistantMessageCount = 0;
  /** Counters for the "post-tool reasoning" heuristic that promotes
   * the turn to stage 4 (Finalizing). After Codex finishes its last
   * function_call_output it typically reasons for 10-30s before the
   * final answer streams. Observing at least one function_call_output
   * plus a run of reasoning entries with no intervening new
   * function_call is a reliable wrap-up signal. This gives stage 4
   * a real pre-answer window instead of only firing the instant the
   * rollout poll catches `agent_message phase=final_answer`. */
  let functionCallOutputsSeen = 0;
  let reasoningSinceLastTool = 0;
  const POST_TOOL_REASONING_THRESHOLD = 2;

  for (const entry of iterParsedEntries(lines)) {
    const { timestamp } = entry;
    const payloadType = getPayloadType(entry);

    if (entry.type === "event_msg" && payloadType === "task_started") {
      if (taskStartedAt === null) {
        taskStartedAt = parseIsoMs(timestamp);
      }
      tryAdvance("received");
      continue;
    }

    if (entry.type === "event_msg" && payloadType === "task_complete") {
      tryAdvance("complete");
      continue;
    }

    // Stage 4 (writing) advancement. Two parallel detection paths:
    //   (a) `event_msg/agent_message phase=final_answer` - the
    //       authoritative signal. Phase tag distinguishes the final
    //       reply from earlier commentary that fires on every turn.
    //   (b) Second assistant-role `response_item/message` entry -
    //       defensive fallback. Codex emits exactly two per turn in
    //       every observed rollout (commentary first, final_answer
    //       second). When the count reaches 2 we know the second
    //       message IS the final-answer text. Catches the same moment
    //       as (a) but resilient if the phase tag wording changes.
    if (entry.type === "event_msg" && payloadType === "agent_message") {
      const phase = getPayloadField<string>(entry, "phase") ?? null;
      if (phase === "final_answer") {
        tryAdvance("writing");
      }
      continue;
    }
    if (
      entry.type === "response_item" &&
      payloadType === "message" &&
      getPayloadField<string>(entry, "role") === "assistant"
    ) {
      assistantMessageCount++;
      if (assistantMessageCount >= 2) {
        tryAdvance("writing");
      }
      continue;
    }

    if (entry.type === "response_item" && payloadType === "function_call") {
      toolCallCount++;
      tryAdvance("working");
      // Reset the post-tool reasoning counter - a new tool call means
      // we're back in active tool use, not wrapping up.
      reasoningSinceLastTool = 0;
      const name = getPayloadField<string>(entry, "name") ?? "";
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      const argsRaw = getPayloadField<unknown>(entry, "arguments");
      const tool: ToolCall = {
        name,
        callId,
        timestamp,
        argumentsPreview: argumentsPreview(argsRaw),
        completed: false,
      };
      if (callId) pendingByCallId.set(callId, tool);
      activeTool = tool;

      if (name === "update_plan") {
        const parsedPlan = parsePlanArguments(argsRaw);
        if (parsedPlan !== null) plan = parsedPlan;
      }
      continue;
    }

    // Web search is emitted as `response_item/web_search_call`, NOT
    // as `function_call`. Self-contained shape - the entry carries
    // `status: "completed"` inline once the search returns, no
    // separate function_call_output event follows. Parse it as a
    // tool of its own so turns that are web-search-heavy (every
    // research turn observed on this bridge) get `toolCallCount`
    // + `activeTool` populated correctly. Skipping this would leave
    // the parser blind to every web search - turns would look
    // tool-less and the post-tool reasoning heuristic never fires.
    if (entry.type === "response_item" && payloadType === "web_search_call") {
      toolCallCount++;
      tryAdvance("working");
      reasoningSinceLastTool = 0;
      const status = getPayloadField<string>(entry, "status") ?? "";
      const callId = getPayloadField<string>(entry, "id") ?? `ws_${toolCallCount}`;
      const argsRaw = getPayloadField<unknown>(entry, "action");
      const tool: ToolCall = {
        name: "web_search_call",
        callId,
        timestamp,
        argumentsPreview: argumentsPreview(argsRaw),
        completed: status === "completed",
      };
      if (status === "completed") {
        // Self-contained completion: increment the post-tool reasoning
        // tracker's tool-done count so the stage 4 heuristic fires
        // when reasoning follows. Don't set activeTool (nothing
        // pending). Don't add to pendingByCallId.
        functionCallOutputsSeen++;
        completedCallIds.add(callId);
      } else {
        // In-flight (rare - the rollout usually only captures
        // completed searches); keep activeTool set until a later
        // completed entry for the same id.
        pendingByCallId.set(callId, tool);
        activeTool = tool;
      }
      continue;
    }

    if (
      entry.type === "response_item" &&
      payloadType === "function_call_output"
    ) {
      functionCallOutputsSeen++;
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      if (callId) {
        completedCallIds.add(callId);
        const pending = pendingByCallId.get(callId);
        if (pending) {
          pending.completed = true;
          pendingByCallId.delete(callId);
          if (activeTool?.callId === callId) activeTool = null;
        }
      }
      continue;
    }

    if (entry.type === "response_item" && payloadType === "reasoning") {
      // Reasoning alone does NOT advance to stage 3 anymore. Early
      // reasoning now belongs to stage 2 (the "reading" window -
      // data shows it's 7-23s on real research turns). Stage 3 is
      // reserved for active tool use. Pure-reasoning turns with no
      // tools at all fall back to the walker which timestep-advances
      // through 1-5 regardless of what the parser detects.
      // Post-tool reasoning still promotes to stage 4 (Finalizing)
      // - that's the wrap-up window and often accounts for 50%+ of
      // the turn on synthesizing-heavy research.
      if (functionCallOutputsSeen > 0) {
        reasoningSinceLastTool++;
        if (reasoningSinceLastTool >= POST_TOOL_REASONING_THRESHOLD) {
          tryAdvance("writing");
        }
      }
      continue;
    }

    if (entry.type === "event_msg" && payloadType === "token_count") {
      const info = getPayloadField<Record<string, unknown>>(entry, "info");
      const last = info?.last_token_usage as
        | Record<string, unknown>
        | undefined;
      if (last) {
        reasoningTokens =
          typeof last.reasoning_output_tokens === "number"
            ? last.reasoning_output_tokens
            : reasoningTokens;
        outputTokens =
          typeof last.output_tokens === "number"
            ? last.output_tokens
            : outputTokens;
        cachedInputTokens =
          typeof last.cached_input_tokens === "number"
            ? last.cached_input_tokens
            : cachedInputTokens;
        inputTokens =
          typeof last.input_tokens === "number"
            ? last.input_tokens
            : inputTokens;
      }
    }
  }

  const elapsedMs =
    taskStartedAt !== null ? Math.max(0, Date.now() - taskStartedAt) : 0;

  return {
    stage,
    plan,
    activeTool,
    toolCallCount,
    reasoningTokens,
    outputTokens,
    cachedInputTokens,
    inputTokens,
    elapsedMs,
  };
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

/** Return every tool call in the current turn in chronological order,
 * pairing each `function_call` with its `function_call_output` via
 * `call_id` when the output entry is present. Turn-scoped via
 * `extractCurrentTurn` so prior turns' tools do not inflate the
 * history. Capped at the most recent `MAX_TOOL_HISTORY_SCAN` lines
 * to keep the walk bounded for very long turns. */
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

/** Render a status-bar-friendly display from a StageInfo snapshot.
 * Pure function. Callers: Codex session token widget (during the
 * "pending" classifier state) and the Epic Handshake status bar. UI
 * label rules can evolve here without touching the parse layer.
 *
 * Fraction is the canonical 1/5..5/5 stage index. Label is
 * context-aware at stage 3/5 - pulled from the active tool name or
 * reasoning presence so the user sees what Codex is actually doing.
 * Plan step text and active-tool detail are surfaced as separate
 * tooltip lines rather than crammed into the short label. */
// --- Internals ---

interface RolloutEntry {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
}

function splitLines(tail: string): string[] {
  return tail.split("\n");
}

function* iterParsedEntries(lines: string[]): Iterable<RolloutEntry> {
  for (const line of lines) {
    const entry = tryParseEntry(line);
    if (entry) yield entry;
  }
}

function tryParseEntry(line: string): RolloutEntry | null {
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

function getPayloadType(entry: RolloutEntry): string | null {
  const t = entry.payload?.type;
  return typeof t === "string" ? t : null;
}

function getPayloadField<T>(entry: RolloutEntry, field: string): T | undefined {
  return entry.payload?.[field] as T | undefined;
}

/** Monotonic stage advance: once we reach a later stage, we never
 * regress. Codex emits events in rough chronological order but a
 * late `function_call` event after `task_complete` is a no-op. */
function advanceStage(current: BridgeStage, candidate: BridgeStage): BridgeStage {
  const order: BridgeStage[] = [
    "dispatched",
    "received",
    "working",
    "writing",
    "complete",
  ];
  const currentIdx = order.indexOf(current);
  const candidateIdx = order.indexOf(candidate);
  return candidateIdx > currentIdx ? candidate : current;
}

/** Accepts the `arguments` field in either of the shapes Codex may
 * emit: the stringified JSON we have observed in captured rollouts,
 * or a pre-parsed object (future-compat for a rollout schema that
 * inlines the structured payload). Returns null on any failure so
 * callers can fall back to the previous plan snapshot. */
function parsePlanArguments(argsRaw: unknown): PlanState | null {
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

function parseIsoMs(iso: string): number | null {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Truncate a function_call `arguments` field to a display-friendly
 * preview regardless of whether Codex emitted it as a JSON string or
 * an already-parsed object. Object form is rendered via
 * `JSON.stringify`; string form slices directly. Non-serializable
 * shapes fall back to the empty string so callers don't have to
 * guard. */
function argumentsPreview(args: unknown): string {
  if (typeof args === "string") return args.slice(0, ARGS_PREVIEW_LEN);
  if (args === null || args === undefined) return "";
  try {
    return JSON.stringify(args).slice(0, ARGS_PREVIEW_LEN);
  } catch {
    return "";
  }
}
