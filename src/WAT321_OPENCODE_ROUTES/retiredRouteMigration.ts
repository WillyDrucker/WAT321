import { readAliases, SESSION_ALIASES_PATH, writeAliases } from "../shared/bridge/sessionAliases";
import { RETIRED_INSTANCE_IDS } from "../shared/providers/opencode/catalog";
import { readPreferences, updatePreference } from "./preferences";

/** Activate-time rewrite of saved route ids the catalog has retired.
 * The active-instance preference and every session alias binding move
 * to the successor route, so a user's pick survives a catalog turnover
 * instead of silently falling back to the first instance. Best-effort:
 * a missing or unreadable store leaves everything as it is. */
export function migrateRetiredRouteIds(): void {
  try {
    const successor = RETIRED_INSTANCE_IDS[readPreferences().activeInstanceId];
    if (successor) updatePreference("activeInstanceId", successor);
  } catch {
    // best-effort
  }
  try {
    const map = readAliases(SESSION_ALIASES_PATH);
    let changed = false;
    for (const bucket of [map.opencode, map.local]) {
      for (const entry of Object.values(bucket)) {
        const successor = entry.instanceId ? RETIRED_INSTANCE_IDS[entry.instanceId] : undefined;
        if (!successor) continue;
        entry.instanceId = successor;
        changed = true;
      }
    }
    if (changed) writeAliases(SESSION_ALIASES_PATH, map);
  } catch {
    // best-effort
  }
}
