import { existsSync, readFileSync } from "node:fs";
import type {
  OpenCodeRoutesConfigSnapshot,
  OpenCodeRoutesInstance,
} from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import {
  readAliases,
  SESSION_ALIASES_PATH,
  type SessionTarget,
} from "../../shared/bridge/sessionAliases";
import { LAST_USED_PATH } from "../openCodeRoutesPaths";

/**
 * Data sources for the OpenCode Routes status-bar item beyond the
 * shared config and heartbeat readers: the last-used sidecar,
 * the bridge alias lookup, and the helpers that resolve
 * which instance the widget displays and which bridge target it maps
 * to. The widget factory owns orchestration and the refresh file owns
 * render.
 *
 * All readers are best-effort: missing files / parse errors fall
 * through to null so the 1Hz refresh loop never throws from a
 * malformed sidecar.
 */

/** Active S<n> alias for the given bridge target, so the Routes
 * tooltip reads parallel to Claude / Codex session tokens. */
export function readActiveBridgeAlias(target: SessionTarget): string | null {
  return readAliases(SESSION_ALIASES_PATH).activeAliases[target];
}

/** Last instance id with a successful dispatch this session. Null
 * otherwise. Drives display priority (the widget shows the most
 * recently used route, not necessarily the configured default). */
function readLastUsedInstanceId(): string | null {
  try {
    if (!existsSync(LAST_USED_PATH)) return null;
    const raw = readFileSync(LAST_USED_PATH, "utf8");
    const parsed = JSON.parse(raw) as { instanceId?: unknown };
    return typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
      ? parsed.instanceId
      : null;
  } catch {
    return null;
  }
}

/** Pick the instance the widget should currently render. Last-used
 * wins over the configured `activeInstanceId` for DISPLAY so the
 * widget reflects the most recent dispatch (e.g. user just ran Big
 * Pickle - widget shows Big Pickle even if their default routing is
 * local-llm). Routing decisions still consult `activeInstanceId` -
 * this only affects what label/stats render. */
export function activeInstanceFrom(
  snap: OpenCodeRoutesConfigSnapshot
): OpenCodeRoutesInstance | null {
  const lastUsedId = readLastUsedInstanceId();
  if (lastUsedId) {
    const lastUsed = snap.instances.find((i) => i.id === lastUsedId);
    if (lastUsed) return lastUsed;
  }
  const found = snap.instances.find((i) => i.id === snap.activeInstanceId);
  if (found) return found;
  return snap.instances[0] ?? null;
}

/** Bridge target ("opencode" or "local") for the displayed instance
 * so the active S# can be looked up in the alias map. Local LLM
 * maps to "local" - every Zen route (Big Pickle and friends) maps to
 * "opencode". Null when no instance is selected. */
export function targetForInstance(
  instance: OpenCodeRoutesInstance | null
): SessionTarget | null {
  if (!instance) return null;
  return instance.kind === "local" ? "local" : "opencode";
}

/** Token formatter for the OpenCode Routes widget. Differs from
 * `shared/ui/tokenFormatters.formatTokens` in two ways:
 *   - sub-1k values render with locale thousand separators (e.g.
 *     "1,234") instead of bare integers
 *   - sub-10k values render with one decimal (`1.5k`) instead of
 *     rounded thousands (`2k`)
 * The Routes widget shows smaller token counts than the Claude /
 * Codex session-token widgets so the extra precision matters more
 * here. */
export function formatRouteTokens(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
