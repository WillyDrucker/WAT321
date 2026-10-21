import { join } from "node:path";
import { openCodeRoutesStateDir } from "../engine/wat321Paths";

/**
 * Filesystem layout for the OpenCode Routes tier. State files are
 * partitioned per workspace under `~/.wat321/clients/<wsId>/model-bridge/`
 * so two VS Code windows running the bridge concurrently get fully
 * separate aliases, sessions, counters, and harness URLs. Shared
 * scripts still live at `~/.wat321/bridge/bin/` (read-only at runtime).
 * The dispatch heartbeat path lives with its reader in
 * `shared/bridge/openCodeDispatchHeartbeat.ts`.
 *
 * The on-disk path keeps the historical `model-bridge` literal: the
 * source tree renamed to OPENCODE_ROUTES, the directory did not. A
 * dir rename would look like lost sessions / config to upgraders.
 */

export const OPENCODE_ROUTES_DIR = openCodeRoutesStateDir();

/** Sidecar the unified bridge writes after every successful dispatch
 * with the instance that just ran. The widget consults this file
 * AFTER the heartbeat clears so a user who just hit Big Pickle keeps
 * seeing "Big Pickle" in idle state instead of the user's preferred
 * activeInstanceId default. Distinct concerns: activeInstanceId is
 * the routing default - last-used is the "what just ran" view. */
export const LAST_USED_PATH = join(OPENCODE_ROUTES_DIR, "last-used.json");

/** Runtime preferences file. Persists `activeInstanceId` only -
 * the Active Instance picker writes here. VS Code settings.json
 * carries the master `enabled` flag plus the local endpoint URL. */
export const PREFERENCES_PATH = join(OPENCODE_ROUTES_DIR, "preferences.json");
