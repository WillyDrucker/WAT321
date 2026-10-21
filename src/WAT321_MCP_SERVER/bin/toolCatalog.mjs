/**
 * The MCP tool definitions exposed to Claude, up to three: `wat321_ask`
 * (dispatch, the alias picks the backend), `wat321_session`
 * (opencode/local session lifecycle, registered only when one of them
 * is enabled), and `wat321_bridge` (inbox drain, registered whenever
 * any backend is enabled since every target can reply fire-and-forget).
 * Read-only state lives on MCP resources (`resources.mjs`) so Claude
 * pays for those descriptions only on request.
 *
 * Every description here is billed to every Claude session on every
 * turn, so each carries three signals and no more: the trigger phrase,
 * the false-positive guard, and a required-read pointer to
 * `bridge://docs/*` for wait modes, alias rules, sticky flags, and
 * error recovery. Per-param descriptions are stripped where the name
 * self-documents. The whole surface is ~250-300 tokens with all three
 * registered.
 */

export function buildTools(enabled) {
  const tools = [];
  const anyEnabled = enabled.codex || enabled.opencode || enabled.local;
  if (!anyEnabled) return tools;

  tools.push({
    name: "wat321_ask",
    description:
      "Send a prompt to Codex, OpenCode, or Local LLM (or any configured alias like Big Pickle) via the WAT321 bridge. Use when the user says ask/tell/prompt one of those - not for past references or hypotheticals. Read `bridge://docs/dispatch` before your first dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        alias: { type: "string" },
        session: { type: "string" },
        thread_name: { type: "string" },
        timeout_sec: { type: "integer" },
        fire_and_forget: { type: "boolean" },
        adaptive: { type: "boolean" },
      },
      required: ["prompt"],
    },
  });

  tools.push({
    name: "wat321_bridge",
    description:
      "Drain pending fire-and-forget replies from the WAT321 bridge inbox (Codex + OpenCode + Local). Read `bridge://docs/inbox` before use.",
    inputSchema: {
      type: "object",
      properties: {
        reply_id: { type: "string" },
      },
    },
  });

  // Session mutations for opencode/local. The action enum self-
  // documents the three operations. The description names WHY to use
  // it (alias persistence across windows, no orphan sessions) so AI
  // callers do not try to manage sessions via direct backend API calls.
  if (enabled.opencode || enabled.local) {
    const sessionTargets = [];
    if (enabled.opencode) sessionTargets.push("opencode");
    if (enabled.local) sessionTargets.push("local");
    tools.push({
      name: "wat321_session",
      description:
        "Create, delete, or rename a named session for OpenCode or Local LLM. Aliases (S1, S2, ...) persist across VS Code windows so a `wat321_ask` with `session: 'S2'` reaches the same conversation context as before. Use this instead of calling the backend HTTP API directly; the bridge tracks the alias map and routes future dispatches to the right server-side session. To list existing sessions, read `bridge://sessions/{target}` (resource, not this tool).",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: sessionTargets },
          action: { type: "string", enum: ["create", "delete", "rename"] },
          session: { type: "string", description: "Required for delete/rename." },
          instance_id: { type: "string", description: "For create." },
          new_name: { type: "string", description: "For rename." },
        },
        required: ["target", "action"],
      },
    });
  }

  return tools;
}
