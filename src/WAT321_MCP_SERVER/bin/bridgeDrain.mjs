import { handleBridge, inFlightCodexSummary } from "./codex/inboxDrain.mjs";
import { textResult } from "./mcpResults.mjs";
import {
  consumeNonCodexInbox,
  inFlightNonCodexSummary,
} from "./nonCodexMailbox.mjs";

/**
 * `wat321_bridge` body. Combines the Codex (Epic Handshake) and non-
 * Codex (per-target) inbox drains into a single tool response. Only
 * the non-empty drains are concatenated. When both come back empty a
 * single unified empty-state message is emitted instead of stacked
 * per-source empty texts, because agents misread a mixed "no pending
 * replies / here is your reply" response as a partial failure even
 * though the data was attached.
 *
 * `handleBridge` signals empty via `{ content: [] }`. Errors (unknown
 * action, missing reply_id) come back with isError=true and short-
 * circuit the drain so the agent sees the original error verbatim
 * instead of "no pending replies" stapled to the failure.
 */

export async function dispatchBridgeDrain(args, enabled) {
  const replyId =
    typeof args?.reply_id === "string" && args.reply_id.trim().length > 0
      ? args.reply_id.trim()
      : null;

  const sections = [];

  if (enabled.codex === true) {
    const codexResult = await handleBridge(args);
    if (codexResult?.isError === true) return codexResult;
    const codexText = (codexResult?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n\n")
      .trim();
    if (codexText.length > 0) sections.push(codexText);
  }

  const nonCodex = await consumeNonCodexInbox(replyId);
  for (const item of nonCodex) {
    sections.push(
      `[${item.target} reply ${item.filename}]\n\n${item.content.trim()}`
    );
  }

  if (sections.length === 0) return inFlightEmptyState();

  return textResult(sections.join("\n\n---\n\n"));
}

/** Empty-state that surfaces in-flight FF and mid-turn dispatches so
 * the agent can report "still working" honestly instead of hedging
 * "the reply may or may not be coming". Two sources combined: non-
 * Codex outbound envelopes the extension dispatcher has not yet
 * processed, and Codex queued envelopes plus active or wedged turn
 * heartbeats scoped to THIS workspace. */
function inFlightEmptyState() {
  const nonCodexInFlight = inFlightNonCodexSummary();
  const codexInFlight = inFlightCodexSummary();
  if (nonCodexInFlight.length === 0 && codexInFlight.length === 0) {
    return textResult(
      "No pending replies in the bridge inbox, and no in-flight fire-and-forget dispatches detected. Nothing to wait on - if the user expected a reply, the dispatch may have never been queued (re-issue) or it already drained on a previous `wat321_bridge()` call."
    );
  }
  const nonCodexLines = nonCodexInFlight.map((d) => {
    const aliasPart = d.alias ? ` to ${d.alias}` : "";
    const previewPart = d.promptPreview ? ` "${d.promptPreview}"` : "";
    return `  - ${d.target}${aliasPart} (${d.ageSec}s ago, id=${d.id})${previewPart}`;
  });
  const codexLines = codexInFlight.map((e) => {
    const stagePart = e.stage ? `, stage=${e.stage}` : "";
    const stalePart =
      e.kind === "stuck" && e.staleSec !== null
        ? ` - heartbeat stale ${e.staleSec}s, may be wedged`
        : "";
    const kindLabel = e.kind === "stuck" ? "appears stuck" : e.kind;
    return `  - codex (${kindLabel}, ${e.ageSec}s old${stagePart}, id=${e.id})${stalePart}`;
  });
  const allLines = [...codexLines, ...nonCodexLines];
  const total = nonCodexInFlight.length + codexInFlight.length;
  const stuck = codexInFlight.some((e) => e.kind === "stuck");
  const tail = stuck
    ? "A Codex heartbeat is stale (may be wedged). Restart Epic Handshake Bridge from the status bar if the next `wat321_bridge()` still reports stuck. Do not re-issue the same prompt; that would queue a duplicate."
    : "Report this to the user as a wait, not a failure - the extension-side dispatcher is running. Call `wat321_bridge()` again when the user asks for the reply. Do not re-issue the same prompt; that would queue a duplicate dispatch.";
  return textResult(
    `No replies have landed yet. ${total} dispatch${total === 1 ? " is" : "es are"} still in flight:\n\n${allLines.join("\n")}\n\n${tail}`
  );
}
