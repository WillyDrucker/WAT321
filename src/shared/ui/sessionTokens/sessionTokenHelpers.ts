import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../../../engine/settingsKeys";
import { openCodeRoutesStateDir } from "../../wat321Paths";

/**
 * Small helpers and constants the SessionTokenWidget composes from.
 * Pulled out so the widget class file owns rendering logic only.
 */

export const TICK_MS = 250;

/** OpenCode dispatch heartbeat. The MCP server's dispatch path writes
 * this file at `~/.wat321/clients/<wsId>/model-bridge/heartbeat.json`
 * for the duration of every Claude-to-OpenCode / Claude-to-Local-LLM call
 * with a 5s keepalive cadence - the file is unlinked on completion.
 * The 15s staleness budget covers one missed keepalive plus normal
 * filesystem latency without ever lingering past a real dispatch. */
const OPENCODE_HEARTBEAT_PATH = join(openCodeRoutesStateDir(), "heartbeat.json");
const OPENCODE_HEARTBEAT_STALE_MS = 15_000;

/** Is the OpenCode / Local-LLM dispatch heartbeat currently fresh?
 * Used by both the Claude session-token widget (to render a
 * waiting-on-OpenCode blink) and the Codex widget (to suppress its
 * bridge-ceremony animation when the active dispatch targets a
 * different backend). */
export function isOpenCodeDispatchActive(): boolean {
  try {
    if (!existsSync(OPENCODE_HEARTBEAT_PATH)) return false;
    const stat = statSync(OPENCODE_HEARTBEAT_PATH);
    return Date.now() - stat.mtimeMs < OPENCODE_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** Foreground color used for the Claude session-token widget during
 * a manual `/compact` in-flight render. Same Tailwind Amber-500 hex
 * already used by the session-token tooltip warning band - reused so
 * the WAT321 palette stays consistent across compact-progress and
 * warning surfaces without introducing a new color variant. */
export const COMPACT_PROGRESS_COLOR = "#f59e0b";

/** Inline TPS suffix for the widget text. Three-digit max (services
 * cap at 999), one decimal below 10 so a slow local LLM at 3.4 tps
 * does not round to 3. Suppressed in minimal mode. Returns an empty
 * string when no reading is available yet (fresh session, no
 * completed turn) so the widget does not show "0tps" before the
 * first observation. */
export function tpsSuffix(
  tps: number | null | undefined,
  mode: "full" | "compact" | "minimal"
): string {
  if (mode === "minimal") return "";
  // Gated by `wat321.enableTokensPerSecondCounters`. Off by default
  // so the widget reads as plain token count + percentage. Token
  // counts stay regardless - only the rate suffix follows this setting.
  if (
    !vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING.enableTokensPerSecondCounters, false)
  ) {
    return "";
  }
  if (typeof tps !== "number" || tps <= 0) return "";
  const formatted = tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1);
  return ` ${formatted}tps`;
}

/** `process.kill(pid, 0)` is the portable Node liveness check - signal
 * 0 is test-only, never delivered. ESRCH means the process is gone,
 * EPERM means alive but we lack permission to signal (still alive
 * for our purposes). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

/** Cache-banner flash window. 2000ms total - the LOAD/MISS text persists
 * the entire window. Bullets blink at 500ms cadence between colored
 * emoji (red MISS / yellow LOAD) and black-circle emoji (off frame).
 * After 2000ms the widget returns to the normal token readout. */
export const CACHE_BANNER_FLASH_MS = 2000;

/** Cache-rebuild detection floors. Two paths qualify a turn as a
 * rebuild event the user paid input price for:
 *
 *   1. Strict ratio (involuntary eviction): cacheCreation >= MIN AND
 *      cacheCreation >= cachedInput * RATIO_DENOM. Creation dominates
 *      this turn 2:1 over reads. Catches mid-session full rebuilds
 *      without false-firing on user-pasted big content.
 *
 *   2. Compact-driven (deliberate rebuild): awaitingCompactLoad AND
 *      cacheCreation >= MIN. Compact caches a fresh summary alongside
 *      the surviving system prompt + tools, so creation is meaningful
 *      but reads are also non-trivial - the strict ratio gate would
 *      miss most of these. The marker (parser-detected
 *      `isCompactSummary`) is the source of truth - ratio drops when
 *      it's set.
 *
 * Floor thresholds derived from sampling 25k+ unique signatures: tiny
 * creation events are normal mid-turn caching of new content - real
 * rebuilds always >= 5k. */
export const CACHE_REBUILD_CREATION_MIN = 5_000;
export const CACHE_REBUILD_RATIO_DENOM = 2;

/** Two-banner classification. Same 2000ms flash cadence for both -
 * color signals cause:
 *
 *   yellow LOAD = deliberate cache build (cold start / session resume
 *                 into a fresh widget / compact-driven rebuild). User
 *                 paid the input cost as part of an intentional load.
 *   red    MISS = involuntary mid-session cache eviction (TTL,
 *                 server-side fault). User paid again unexpectedly.
 *
 * Each banner has an "on" form (colored emoji bullets) and an "off"
 * form (black circle bullets, U+26AB). Same emoji rendering family
 * for both frames keeps the cell width steady - mixing emoji with
 * ASCII spaces or codicons crosses font tables and shifts the text
 * unpredictably on every transition. */
export const CACHE_LOAD_BANNER_ON = "🟡LOAD🟡";
export const CACHE_LOAD_BANNER_OFF = "⚫LOAD⚫";
export const CACHE_MISS_BANNER_ON = "🔴MISS🔴";
export const CACHE_MISS_BANNER_OFF = "⚫MISS⚫";

/** 500ms per frame, four frames per banner cycle. Pattern (using
 * MISS): on (0-500) / off (500-1000) / on (1000-1500) / off
 * (1500-2000). Off frame swaps the colored circle for black circle -
 * same emoji family means equal width across frames. */
export const CACHE_BANNER_FRAME_MS = 500;
