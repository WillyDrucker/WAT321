import type { LastEntryKind } from "../shared/turnState";

/**
 * Turn-state classification for Codex rollout tails - the single home
 * for "what is the last turn doing". Two consumers with deliberately
 * different biases: classifyCodexTurn (idle bias, drives the active
 * indicator) and isCodexTurnComplete (terminal-only bias, drives the
 * notification gate).
 */

/** Classify the last meaningful entry in a Codex rollout tail into
 * one of the turn states used by the session token active indicator.
 * Walks backwards, skips bookkeeping events, returns the first
 * definitive event found:
 *   - `assistant-done` - a turn ended normally by `task_complete`.
 *     Resolves the indicator instantly and is notification-eligible.
 *   - `interrupted` - a turn ended by `turn_aborted`, which Codex
 *     writes on user interrupt (Esc / Ctrl+C). Resolves the indicator
 *     to idle like done, but the notification gate suppresses it so a
 *     cancelled turn never fires a "Codex finished" toast.
 *   - `assistant-pending` - a tool / function call in flight
 *   - `user` - last event was a user message (user is waiting)
 *   - `unknown` - no definitive event in the tail window
 *
 * Unlike `isCodexTurnComplete` (which requires an explicit terminal
 * marker), this biases `unknown` to idle so the thinking indicator
 * does not pin itself on when we cannot tell. */
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
    // Current-turn boundary. Reaching task_started while walking
    // backwards proves there is no terminal marker in this turn.
    // Stop here so an unrecognized event cannot fall through into
    // the previous turn's task_complete and create a false toast.
    if (entry.type === "event_msg" && ptype === "task_started") {
      return "assistant-pending";
    }

    // Assistant-response events are item-level progress, not turn
    // completion. Codex emits an agent_message with phase=commentary
    // mid-turn and phase=final_answer near the end, but more lifecycle
    // work can still follow until task_complete is persisted.
    if (entry.type === "event_msg" && ptype === "agent_message") {
      return "assistant-pending";
    }
    // `response_item/message` role=assistant has no phase tag and fires
    // for both commentary and final_answer. Without a phase we cannot
    // confirm final_answer, so we report pending rather than risk
    // marking the turn done on a mid-work commentary message.
    if (entry.type === "response_item" && ptype === "message" && payload?.role === "assistant") {
      return "assistant-pending";
    }
    if (entry.type === "response.output_text.done") return "assistant-pending";
    if (entry.type === "message" && payload?.role === "assistant") return "assistant-pending";

    // User messages = user is waiting for a response
    if (ptype === "user_message") return "user";

    // Tool / function calls in flight = assistant is actively working.
    // Codex emits many call variants depending on which tool fired:
    // function_call (custom tools), web_search_call (built-in search),
    // local_shell_call, file_search_call, etc. Any *_call under a
    // response_item means a tool is mid-flight. Bridge-driven sessions
    // rely on this heavily - they have no shell access so they lean on
    // reasoning + built-in tools.
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
 * Only `assistant-done` is notification-eligible. Unknown or malformed
 * activity fails closed because a missed notification is preferable
 * to interrupting the user during an active turn. Interrupts
 * (`turn_aborted`) map to `interrupted` and remain suppressed. */
export function isCodexTurnComplete(tail: string): boolean {
  const state = classifyCodexTurn(tail);
  return state === "assistant-done";
}
