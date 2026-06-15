import type { LastEntryKind } from "../shared/turnState";

/**
 * Turn-state classification for Codex rollout tails - the single home
 * for "what is the last turn doing". Two consumers with deliberately
 * different biases: classifyCodexTurn (idle bias, drives the active
 * indicator) and isCodexTurnComplete (fire bias, drives the
 * notification gate).
 */

/** Classify the last meaningful entry in a Codex rollout tail into
 * one of the turn states used by the session token active indicator.
 * Walks backwards, skips bookkeeping events, returns the first
 * definitive event found:
 *   - `assistant-done` - a completed assistant response OR a turn
 *     ended normally by `task_complete`. Resolves the indicator
 *     instantly and is notification-eligible.
 *   - `interrupted` - a turn ended by `turn_aborted`, which Codex
 *     writes on user interrupt (Esc / Ctrl+C). Resolves the indicator
 *     to idle like done, but the notification gate suppresses it so a
 *     cancelled turn never fires a "Codex finished" toast.
 *   - `assistant-pending` - a tool / function call in flight
 *   - `user` - last event was a user message (user is waiting)
 *   - `unknown` - no definitive event in the tail window
 *
 * Unlike `isCodexTurnComplete` (which biases toward true for
 * notification firing), this biases `unknown` to idle so the thinking
 * indicator does not pin itself on when we cannot tell. */
export function classifyCodexTurn(tail: string): LastEntryKind {
  const lines = tail.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload as Record<string, unknown> | undefined;
    const ptype = payload?.type as string | undefined;

    // Normal turn end. task_complete resolves the indicator and is
    // notification-eligible.
    if (entry.type === "event_msg" && ptype === "task_complete") {
      return "assistant-done";
    }
    // User interrupt (Esc / Ctrl+C). The turn is over, so the widget
    // collapses `interrupted` to idle - but the notification gate
    // suppresses it because a "Codex finished" toast would
    // misrepresent a cancelled turn.
    if (entry.type === "event_msg" && ptype === "turn_aborted") {
      return "interrupted";
    }

    // Assistant-response events = done ONLY for the final_answer phase.
    // Codex emits an `agent_message` with phase=commentary mid-turn
    // ("I'll look into X first") before the phase=final_answer message
    // at turn end. Treating commentary as turn-complete would flicker
    // the thinking indicator idle between commentary and the next
    // reasoning/tool event, so only final_answer (plus the explicit
    // turn_aborted / task_complete signals) closes the turn. Commentary
    // falls through to keep scanning so a later definitive signal
    // (function_call, reasoning) wins.
    if (entry.type === "event_msg" && ptype === "agent_message") {
      const phase = payload?.phase;
      if (phase === "final_answer") return "assistant-done";
      // phase=commentary or unphased: the assistant is mid-turn (more
      // follows the commentary), so report pending.
      return "assistant-pending";
    }
    // `response_item/message` role=assistant has no phase tag and fires
    // for both commentary and final_answer. Without a phase we cannot
    // confirm final_answer, so we report pending rather than risk
    // marking the turn done on a mid-work commentary message.
    if (entry.type === "response_item" && ptype === "message" && payload?.role === "assistant") {
      return "assistant-pending";
    }
    if (entry.type === "response.output_text.done") return "assistant-done";
    if (entry.type === "message" && payload?.role === "assistant") return "assistant-pending";

    // User messages = user is waiting for a response
    if (ptype === "user_message") return "user";

    // Tool / function calls in flight = assistant is actively working.
    // Codex emits many call variants depending on which tool fired:
    // function_call (custom tools), web_search_call (built-in search),
    // local_shell_call, file_search_call, etc. Any *_call under a
    // response_item means a tool is mid-flight.
    if (ptype === "tool_call" || ptype === "function_call") return "assistant-pending";
    if (entry.type === "response_item" && typeof ptype === "string" && ptype.endsWith("_call")) {
      return "assistant-pending";
    }

    // Reasoning chunks under a response_item mean the model is thinking
    // and has not yet emitted the final assistant message. Safe to mark
    // pending: the backwards walk would have returned "assistant-done"
    // first if a later agent_message existed.
    if (entry.type === "response_item" && ptype === "reasoning") return "assistant-pending";

    // Everything else (token_count, turn_context, exec_output) is
    // bookkeeping - keep scanning.
  }
  return "unknown";
}

/** Classify whether the last meaningful entry in a Codex rollout
 * tail represents a completed assistant turn. Thin wrapper over
 * `classifyCodexTurn` so the detection rules stay in one place.
 *
 * `user` and `assistant-pending` = mid-turn, notification gate should
 * suppress. `assistant-done` and `unknown` = complete, notification
 * gate should fire. The `unknown` -> fire bias is intentional: a
 * missing definitive event must not silently lose a notification.
 * Interrupts (`turn_aborted`) map to `interrupted` via the classifier
 * - neither `assistant-done` nor `unknown` - so the gate correctly
 * suppresses notifications on cancelled turns. */
export function isCodexTurnComplete(tail: string): boolean {
  const state = classifyCodexTurn(tail);
  return state === "assistant-done" || state === "unknown";
}
