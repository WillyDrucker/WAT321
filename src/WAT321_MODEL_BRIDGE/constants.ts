import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Filesystem layout for the Model Bridge tier. Parallel to
 * `WAT321_EPIC_HANDSHAKE/constants.ts` but scoped under
 * `~/.wat321/model-bridge/` so the two bridges never collide on
 * runtime files even when both are enabled.
 */

export const WAT321_DIR = join(homedir(), ".wat321");
export const MODEL_BRIDGE_DIR = join(WAT321_DIR, "model-bridge");
export const BIN_DIR = join(MODEL_BRIDGE_DIR, "bin");

/** Atomic config file the extension writes on every settings change.
 * `channel.mjs` reads this per call - the MCP server is a separate
 * process spawned by Claude Code and cannot reach the extension host
 * directly, so the file is the bridge between settings and runtime. */
export const CONFIG_PATH = join(MODEL_BRIDGE_DIR, "config.json");

/** Heartbeat file `channel.mjs` writes at request start and removes
 * at request end. The status-bar widget polls it at 1 Hz to surface
 * in-flight state. Absence = idle. */
export const HEARTBEAT_PATH = join(MODEL_BRIDGE_DIR, "heartbeat.json");

/** Runtime preferences file. Active instance, harness toggle,
 * sampling, system prompt, phased protocol, OpenCode URL -
 * everything the click menu tunes lives here. VS Code settings.json
 * carries only the master `enabled` flag plus the local endpoint
 * URL; per-task tuning stays out of the settings UI. */
export const PREFERENCES_PATH = join(MODEL_BRIDGE_DIR, "preferences.json");

/** Per-instance cumulative token-usage counters. channel.mjs appends
 * after each successful chat completion with the prompt + completion
 * tokens reported by the server. Widget tooltip surfaces per-instance
 * totals; click menu resets via "Reset session totals". Cleared on
 * Reset WAT321 along with everything else. */
export const USAGE_PATH = join(MODEL_BRIDGE_DIR, "usage.json");

/** Per-thread rollout directory. Each `model_bridge_thread` thread
 * gets a subdirectory `<thread_id>/rollout.jsonl` with one JSON entry
 * per line: a `session_meta` first record, then alternating `turn`
 * entries (user / assistant) and any `compact` entries the bridge
 * inserts when the rollout passes the auto-compact threshold. */
export const SESSIONS_DIR = join(MODEL_BRIDGE_DIR, "sessions");

/** MCP server name registered with `claude mcp add`. Distinct from
 * the Epic Handshake bridge (`wat321`) so both can coexist without
 * stepping on each other's tool registrations. */
export const MCP_SERVER_NAME = "wat321-model-bridge";

/** Legacy MCP server names this tier should sweep from
 * `~/.claude/settings.json` on every install. The current registration
 * is `wat321-model-bridge`; any stale earlier-named entry pointing at
 * the same channel.mjs path is removed before the new add to keep the
 * user's allow-list and registration table clean. */
export const LEGACY_MCP_SERVER_NAMES = ["wat321-local-llm"] as const;

/** Bundled MCP server script. Extracted to BIN_DIR on enable; Claude
 * Code spawns `node <BIN_DIR>/channel.mjs` once the MCP entry is
 * registered. */
export const CHANNEL_SCRIPT_NAME = "channel.mjs";
