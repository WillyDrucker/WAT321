/**
 * Assembles the reply a finished Codex turn produced. Final item text
 * wins over the aggregated streaming deltas. The outcome tells
 * `turnRunner.ts` whether to deliver the text, or to try a tight
 * rollout recovery first and fail with the given error only when the
 * rollout holds nothing fresh either.
 */

interface AgentMessageDelta {
  itemId: string;
  delta: string;
}

export interface TurnCompleted {
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed";
    items: Array<{ type: string; id: string; text?: string; status: string }>;
    error?: {
      message: string;
      codexErrorInfo?: string;
      additionalDetails?: string;
    } | null;
  };
}

type TurnOutcome =
  | { kind: "reply"; text: string }
  /** The RPC result is not deliverable as-is. `logLabel` names why for
   * the recovery log line and `failure` is the rejection when recovery
   * also comes up empty. */
  | { kind: "recover"; logLabel: string; failure: Error };

const EMPTY_REPLY_MESSAGE =
  'empty reply from Codex (thread may be in a degraded state; will rotate after threshold or pick "Reset Codex Session" from the menu)';

/** Fold one `item/agentMessage/delta` notification into the per-item
 * text map that backs the fallback when the completed turn carries no
 * final item text. */
export function accumulateDelta(itemText: Map<string, string>, params: unknown): void {
  const d = params as AgentMessageDelta;
  const prev = itemText.get(d.itemId) || "";
  itemText.set(d.itemId, prev + (d.delta || ""));
}

export function assembleTurnReply(
  c: TurnCompleted,
  itemText: Map<string, string>
): TurnOutcome {
  if (c.turn.status !== "completed") {
    // Non-success terminal status. Codex may still have committed work
    // on disk before the failure surfaced.
    const message = c.turn.error?.message ?? `turn ${c.turn.status}`;
    return {
      kind: "recover",
      logLabel: `turn/completed status=${c.turn.status}`,
      failure: new Error(message),
    };
  }

  const chunks: string[] = [];
  for (const item of c.turn.items) {
    if (item.type === "agentMessage" && item.text) chunks.push(item.text);
  }
  if (chunks.length === 0) {
    for (const text of itemText.values()) chunks.push(text);
  }
  const combined = chunks.join("\n").trim();
  if (combined.length === 0) {
    // Empty completed turn. The task_complete + agent_message may have
    // landed on disk a beat before the RPC notification reached us
    // with stale items.
    return {
      kind: "recover",
      logLabel: "turn/completed empty items",
      failure: new Error(EMPTY_REPLY_MESSAGE),
    };
  }
  return { kind: "reply", text: combined };
}
