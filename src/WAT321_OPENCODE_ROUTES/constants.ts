import { homedir } from "node:os";
import { join } from "node:path";
import { modelBridgeStateDir } from "../shared/wat321Paths";

/**
 * Filesystem layout for the OpenCode Routes tier. State files are
 * partitioned per workspace under `~/.wat321/clients/<wsId>/model-bridge/`
 * so two VS Code windows running the bridge concurrently get fully
 * separate aliases, sessions, counters, and harness URLs. Shared
 * scripts still live at `~/.wat321/bridge/bin/` (read-only at runtime).
 *
 * The on-disk path keeps the historical `model-bridge` literal: the
 * source tree renamed to OPENCODE_ROUTES, the directory did not. A
 * dir rename would look like lost sessions / config to upgraders.
 */

export const WAT321_DIR = join(homedir(), ".wat321");
export const MODEL_BRIDGE_DIR = modelBridgeStateDir();

/** Atomic config file the extension writes on every settings change.
 * `channel.mjs` reads this per call - the MCP server is a separate
 * process spawned by Claude Code and cannot reach the extension host
 * directly, so the file is the bridge between settings and runtime. */
export const CONFIG_PATH = join(MODEL_BRIDGE_DIR, "config.json");

/** Heartbeat lives at `<MODEL_BRIDGE_DIR>/heartbeat.json`. The dir
 * itself is per-client (`clients/<wsId>/model-bridge/`) so the file
 * needs no per-workspace filename suffix. Writer is the dispatch path
 * in `bin/opencode/heartbeat.mjs`; reader is the widget. */

/** Sidecar the unified bridge writes after every successful dispatch
 * with the instance that just ran. The widget consults this file
 * AFTER the heartbeat clears so a user who just hit Big Pickle keeps
 * seeing "Big Pickle" in idle state instead of the user's preferred
 * activeInstanceId default. Distinct concerns: activeInstanceId is
 * the routing default; last-used is the "what just ran" view. */
export const LAST_USED_PATH = join(MODEL_BRIDGE_DIR, "last-used.json");

/** Runtime preferences file. Persists `activeInstanceId` only -
 * the menu's Active Instance picker writes here. VS Code settings.json
 * carries the master `enabled` flag plus the local endpoint URL. */
export const PREFERENCES_PATH = join(MODEL_BRIDGE_DIR, "preferences.json");

/** Per-instance cumulative token-usage counters. channel.mjs appends
 * after each successful chat completion with the prompt + completion
 * tokens reported by the server. Widget tooltip surfaces per-instance
 * totals; click menu resets via "Reset session totals". Cleared on
 * Reset WAT321 along with everything else. */
export const USAGE_PATH = join(MODEL_BRIDGE_DIR, "usage.json");

/** Per-thread rollout directory used by the legacy MB Manage Sessions
 * row. Layout: `<thread_id>/rollout.jsonl` with one JSON entry per
 * line. Read-only from the bridge tier; the menu's erase-rollouts
 * action is the sole writer. */
export const SESSIONS_DIR = join(MODEL_BRIDGE_DIR, "sessions");
