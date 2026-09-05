/**
 * REST client for the WAT321-managed `opencode serve`. Sessions are
 * owned by OpenCode itself (stored in `~/.local/share/opencode/
 * opencode.db`) and reached over these endpoints:
 *
 *   POST /session                -> create, returns {id, slug, ...}
 *   POST /session/{id}/message   -> send prompt, blocks until completion
 *   GET  /session/{id}/message   -> message history
 *   GET  /event                  -> SSE stream (see `sse.mjs`)
 *
 * Every call returns `{ ok: true, ... }` or `{ ok: false, error }`
 * with a caller-ready message, never throws.
 */

/** Hard ceiling on `/session` POST. Session creation is local-disk
 * work in opencode serve. Without this cap a hung server would wedge
 * the dispatch past the caller's outer `timeout_sec`. */
const SESSION_CREATE_TIMEOUT_MS = 30_000;

/** Custom OpenCode agent the serve manager declares (in `opencode.json`
 * via `shared/providers/opencode/configBuilder.ts`). It replaces
 * OpenCode's default `build` agent, whose coder-focused system prompt
 * was suppressing webfetch on non-coding questions.
 *
 * Mirrored from `WAT321_RESEARCH_AGENT` in `configBuilder.ts`. The two
 * surfaces (extension config-write side, MCP runtime read side) cannot
 * import each other because .mjs runs in a separate Node process, so
 * the literal lives in both places. Either side renaming without the
 * other breaks dispatch immediately. */
export const WAT321_RESEARCH_AGENT = "wat321-research";

/** A JSON `fetch` with an AbortController timeout, for one-shot REST
 * calls that need a hard ceiling separate from the dispatch's outer
 * `timeout_sec`. */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Create a session bound to `instance`'s model when it has one.
 * Binding matters: an unbound session lists as "model: undefined"
 * until its first message arrives, which reads as broken. */
export async function createSession(serveUrl, instance) {
  const body = {};
  if (instance?.model) {
    body.model = {
      id: instance.model,
      providerID: instance.harnessProviderID || "zen",
    };
  }
  try {
    const res = await fetchWithTimeout(
      `${serveUrl}/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      SESSION_CREATE_TIMEOUT_MS
    );
    if (!res.ok) {
      return { ok: false, error: `opencode serve returned ${res.status} on /session create.` };
    }
    const data = await res.json();
    if (!data?.id) {
      return { ok: false, error: "opencode serve /session create did not return an id." };
    }
    return { ok: true, id: data.id, modelId: data?.model?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      error: `opencode serve /session create failed: ${err?.message || String(err)}`,
    };
  }
}

/** POST to `/session/{id}/message`. The per-message `model` binding is
 * load-bearing: without it OpenCode falls through to default /
 * recent-model selection logic that can drop tool affordances or
 * change which sampling path runs. The empirical symptom is the model
 * hallucinating tool-call results inline as text instead of emitting
 * a structured `tool_calls` array. Sending the binding every turn
 * pins behavior to the route the user actually selected.
 *
 * `agent` selects which OpenCode agent profile runs the turn. WAT321
 * dispatches against its own `wat321-research` agent so research and
 * current-events questions actually fire webfetch. Pass null to fall
 * through to OpenCode's default agent. */
export async function postSessionMessage(serveUrl, sessionId, prompt, timeoutMs, modelRef, agent) {
  try {
    const body = { parts: [{ type: "text", text: prompt }] };
    if (modelRef) body.model = modelRef;
    if (typeof agent === "string" && agent.length > 0) body.agent = agent;
    const res = await fetchWithTimeout(
      `${serveUrl}/session/${sessionId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs
    );
    if (!res.ok) {
      return { ok: false, error: `opencode serve returned ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const data = await res.json();
    const text = textOfParts(data?.parts);
    return { ok: true, text: text || "(no assistant text in response)" };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** The newest message in a session, or null when it has none. */
export async function fetchLatestMessage(serveUrl, sessionId) {
  try {
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`);
    if (!res.ok) {
      return {
        ok: false,
        error: `Could not fetch session messages: opencode serve returned ${res.status}.`,
      };
    }
    const messages = await res.json();
    const message =
      Array.isArray(messages) && messages.length > 0
        ? messages[messages.length - 1]
        : null;
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: `Session message fetch failed: ${err?.message || String(err)}` };
  }
}

/** The text parts of a message joined into one body. */
export function textOfParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n\n");
}
