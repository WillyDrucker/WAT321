import { log } from "../channelLog.mjs";
import { fetchLatestMessage } from "./serveApi.mjs";

/**
 * Tap OpenCode's `/event` SSE stream during a session-attached dispatch
 * and feed live progress to the heartbeat. Char count of the
 * accumulating assistant reply text serves as a token-count proxy so
 * the OpenCode Routes widget renders `Nt @ X/s` instead of seconds-elapsed.
 *
 * Returns once the SSE response headers have arrived. Caller MUST
 * await this before firing the dispatch POST: a fast local LLM can
 * finish generating before the SSE GET completes its handshake,
 * leaving the heartbeat at tokens=0 for the entire dispatch and the
 * widget falling back to elapsed-seconds.
 *
 * Best-effort: any tap failure leaves the dispatch untouched. The POST
 * still completes and the response payload is still parsed normally.
 *
 * Poll fallback covers non-streaming providers (Zen / Big Pickle and
 * friends) that return the assistant reply as one chunk after the
 * model finishes. Polling /session/{id}/message every 2s reads
 * in-progress text length even when SSE never streams. Streaming
 * providers still win in latency because pushProgress is monotonic:
 * whichever source reports higher first sticks.
 */

const SSE_HANDSHAKE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;

function logSse(message) {
  log("sse", message);
}

/** Split off complete SSE event blocks (blank-line framed, LF or
 * CRLF) from the front of `buffer`. Returns the blocks and the
 * unconsumed remainder. */
function takeEventBlocks(buffer) {
  const blocks = [];
  let rest = buffer;
  for (;;) {
    const lfIdx = rest.indexOf("\n\n");
    const crlfIdx = rest.indexOf("\r\n\r\n");
    if (lfIdx < 0 && crlfIdx < 0) break;
    const useCrlf = lfIdx < 0 || (crlfIdx >= 0 && crlfIdx < lfIdx);
    const boundary = useCrlf ? crlfIdx : lfIdx;
    const advance = useCrlf ? 4 : 2;
    blocks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + advance);
  }
  return { blocks, rest };
}

function parseEventBlock(block) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}

export async function tapOpenCodeEvents(base, expectedSessionId, onProgress) {
  const ac = new AbortController();
  const assistantMsgIds = new Set();
  const partTexts = new Map();
  const counters = {
    events: 0,
    sessionMatches: 0,
    partUpdates: 0,
    progressCalls: 0,
    pollUpdates: 0,
  };
  // Monotonic reporter: SSE and the poll fallback both push token
  // estimates through here. Without monotonic gating, a slow poll
  // could undo a higher SSE-reported value mid-dispatch.
  let lastTotal = 0;
  const pushProgress = (total) => {
    if (typeof total !== "number" || total <= lastTotal) return;
    lastTotal = total;
    try {
      onProgress(total);
      counters.progressCalls++;
    } catch {
      // best-effort, a heartbeat write failure is non-fatal
    }
  };
  logSse(`tap.open base=${base} session=${expectedSessionId}`);

  // Race the SSE handshake against a short timeout. If `opencode serve`
  // is hung on accepting `/event`, the dispatch POST that the caller
  // fires next would never start because we await this function before
  // posting. Without a timeout the caller's `timeout_sec` would not
  // apply to the handshake stage at all and the widget could stick on
  // "Calling..." until the user manually cancels. On timeout we proceed
  // with a no-op tap so the dispatch still runs, and the heartbeat falls
  // back to elapsed-seconds for that turn.
  let res;
  try {
    const handshakeAc = new AbortController();
    const handshakeTimer = setTimeout(
      () => handshakeAc.abort(),
      SSE_HANDSHAKE_TIMEOUT_MS
    );
    try {
      // Compose user-cancel + handshake-timeout so either source aborts
      // the fetch. AbortSignal.any is available on Node 22+ (our floor).
      const composed = AbortSignal.any
        ? AbortSignal.any([ac.signal, handshakeAc.signal])
        : ac.signal;
      res = await fetch(`${base}/event`, {
        headers: { Accept: "text/event-stream" },
        signal: composed,
      });
    } finally {
      clearTimeout(handshakeTimer);
    }
  } catch (err) {
    logSse(`tap.fetchFail err=${err?.message || err}`);
    return { stop: () => ac.abort() };
  }
  if (!res.ok || !res.body) {
    logSse(`tap.handshakeFail status=${res?.status} hasBody=${Boolean(res?.body)}`);
    return { stop: () => ac.abort() };
  }
  logSse(`tap.handshakeOk status=${res.status}`);

  const pollSessionMessages = async () => {
    if (!expectedSessionId) return;
    const latest = await fetchLatestMessage(base, expectedSessionId);
    if (!latest.ok || latest.message === null) return;
    if (latest.message?.info?.role !== "assistant") return;
    const parts = Array.isArray(latest.message?.parts) ? latest.message.parts : [];
    let total = 0;
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") total += p.text.length;
    }
    if (total > 0) {
      counters.pollUpdates++;
      pushProgress(total);
    }
  };
  const pollInterval = setInterval(pollSessionMessages, POLL_INTERVAL_MS);

  const handleEvent = (evt) => {
    counters.events++;
    if (counters.events <= 3) {
      logSse(`tap.event#${counters.events} type=${evt?.type} sid=${evt?.properties?.sessionID}`);
    }
    const sid = evt?.properties?.sessionID;
    if (expectedSessionId && sid !== expectedSessionId) return;
    counters.sessionMatches++;
    if (evt.type === "message.updated") {
      const info = evt.properties?.info;
      if (info?.role === "assistant" && info?.id) assistantMsgIds.add(info.id);
    } else if (evt.type === "message.part.updated") {
      counters.partUpdates++;
      const part = evt.properties?.part;
      // Race-tolerant: text part-updates arrive before message.updated
      // registers the messageID as assistant. opencode serve only emits
      // text part-updates for assistant messages, so any text part
      // with a messageID is safe to count without gating on prior
      // assistant registration.
      if (part?.type === "text" && part?.messageID && part?.id) {
        partTexts.set(part.id, typeof part.text === "string" ? part.text : "");
        let total = 0;
        for (const t of partTexts.values()) total += t.length;
        pushProgress(total);
      } else if (counters.partUpdates <= 2) {
        logSse(`tap.partSkip type=${part?.type} hasMsgId=${Boolean(part?.messageID)}`);
      }
    }
  };

  const reader = res.body.getReader();
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const taken = takeEventBlocks(buffer);
        buffer = taken.rest;
        for (const block of taken.blocks) {
          const evt = parseEventBlock(block);
          if (evt) handleEvent(evt);
        }
      }
    } catch {
      // stream ended or aborted, the dispatch still completes
    }
  })();

  return {
    stop: () => {
      ac.abort();
      clearInterval(pollInterval);
      logSse(
        `tap.stop events=${counters.events} sessionMatches=${counters.sessionMatches} partUpdates=${counters.partUpdates} pollUpdates=${counters.pollUpdates} progressCalls=${counters.progressCalls}`
      );
    },
  };
}
