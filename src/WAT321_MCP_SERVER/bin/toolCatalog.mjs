/**
 * The MCP tool definitions exposed to Claude. Up to three tools:
 *
 *   wat321_ask     - dispatch a prompt, alias picks the backend
 *   wat321_session - opencode/local session lifecycle (action enum,
 *                    only registered when opencode or local is enabled)
 *   wat321_bridge  - single-purpose inbox drain (registered whenever
 *                    any backend is enabled, since every target can
 *                    produce fire-and-forget replies)
 *
 * Read-only state (inbox peek, sessions list, instances catalog,
 * status, dispatch/inbox docs) lives on MCP resources (`resources.mjs`)
 * so Claude pays for those descriptions only when the user asks.
 *
 * Every description here is billed to every Claude session's context
 * on every turn. The lean shape carries three load-bearing signals:
 * the trigger phrase, the false-positive guard, and a required-read
 * pointer to `bridge://docs/*` for everything else (wait modes, alias
 * rules, sticky-flag semantics, error recovery). Per-param
 * descriptions are stripped where names self-document. Total tool
 * surface is ~250-300 tokens when all three register.
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
