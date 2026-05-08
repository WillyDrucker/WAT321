/**
 * OpenCode + Local LLM target handlers for the unified WAT321 bridge.
 *
 * Routes through the WAT321-managed `opencode serve` subprocess
 * (lifecycle in `src/WAT321_OPENCODE_HARNESS/manager.ts`).
 * Sessions are owned by OpenCode itself - stored in
 * `~/.local/share/opencode/opencode.db` - and accessed via REST.
 *
 * Endpoints used:
 *   GET  /session                -> list sessions
 *   POST /session                -> create, returns {id, slug, ...}
 *   POST /session/{id}/message   -> send prompt, blocks until completion
 *   GET  /event                  -> SSE stream of session events
 *
 * Anonymous tier: opencode.ai/zen/v1/chat/completions accepts
 * unauthenticated requests for one-shots.
 *
 * Module layout (this directory):
 *   common.mjs    paths, constants, logSse, errorResult, formatters
 *   aliases.mjs   per-target S<n> alias map read/write
 *   config.mjs    serveUrl, instances, findInstance from MB config
 *   heartbeat.mjs withMbHeartbeat dispatch wrapper + tps tracker
 *   sse.mjs       tapOpenCodeEvents stream + poll fallback
 *   sessions.mjs  handleSession + listSessionsResource + postSessionMessage
 *   dispatch.mjs  handleAsk (session-attached, auto-create, one-shot)
 */

export { handleAsk } from "./dispatch.mjs";
export { handleSession, listSessionsResource } from "./sessions.mjs";
