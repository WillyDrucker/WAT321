/**
 * WAT321 OpenCode Harness - lifecycle for the managed `opencode serve`
 * subprocess. Per-VS-Code-instance harness on an ephemeral port; the
 * URL lands in `model-bridge/config.json` for the MCP child to read.
 *
 * Provider schema (instance catalog, opencode.json) lives at
 * `shared/providers/opencode/`. This tier owns only the runtime
 * lifecycle - spawn, ready probe, exit, dispose.
 */

export { createOpenCodeManager } from "./manager";
