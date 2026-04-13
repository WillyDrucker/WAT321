import { existsSync } from "node:fs";
import type { OverrideReadResult } from "../shared/claudeSettings";
import { ARMED_OVERRIDE_VALUE } from "./backups";
import {
  scanTailForCompactHistory,
  type TailHistoryOutcome,
} from "./compactDetector";
import { SENTINEL_PATH } from "./sentinel";
import type { UnavailableReason } from "./types";

/**
 * Unified safety / availability gate for Claude Force Auto-Compact.
 * One module, one answer, consulted by:
 *
 *   - The service's passive poll, which moves the widget between
 *     `ready` and `unavailable` as conditions change
 *   - The widget's snap check on session token updates and click-time
 *   - `arm()` as a final defense-in-depth check before touching disk
 *
 * The primary arm gate is the **context-fraction check**: the
 * user must be above `USEFUL_CONTEXT_FRACTION` (20%) of their
 * auto-compact ceiling before arming makes sense. Below that
 * there is nothing meaningful to compact and a compact would
 * either waste a summary or immediately loop with the next one.
 *
 * This single check subsumes what used to be
 * `recent-native-compact` (30 s recency window) and
 * `post-disarm-cooldown` (30 s watcher window) because in both of
 * those cases the user is always in the low-context post-compact
 * zone. `loop-suspected` stays as a secondary defense for
 * small-ceiling users whose post-compact state can land above the
 * 20% gate.
 *
 * The post-disarm cooldown watcher itself still runs in the
 * service - its job is detecting stray compacts from a CLI-cached
 * env var and warning the user to restart their terminal. That
 * purpose is separate from gating arm.
 */

/** Minimum context usage (as a fraction of the user's auto-compact
 * ceiling) required to arm. Below this the button grays out with
 * a `below-useful-threshold` tooltip explaining where the user is
 * and where the activation point sits. */
export const USEFUL_CONTEXT_FRACTION = 0.20;

/** Window used by the secondary loop-detection backup. When 2+
 * compact markers are visible in the tail AND the file mtime is
 * within this window, treat it as "clustered in time" and refuse
 * arm. Loose signal; the primary context gate does the real work. */
export const LOOP_WINDOW_MS = 2 * 60_000;

/** Context usage (as a fraction of the user's auto-compact ceiling)
 * that triggers a "near native threshold" informational hint in
 * the arm confirm dialog. Not a safety gate. */
export const NEAR_NATIVE_THRESHOLD_FRACTION = 0.8;

/** What the widget knows about the current live Claude session.
 * Fed into the service via `setActiveContext` and cached for the
 * resolver. All three fields must be present together - null
 * means "no live session, skip the context gate". */
export interface ActiveContextInfo {
  /** Absolute path to the current live transcript. Used by the
   * armed-state scanner, the cooldown watcher, and loop detection
   * scanning. */
  transcriptPath: string;
  /** Current context token count for the targeted session. */
  contextUsed: number;
  /** Ceiling = `autoCompactPct * contextWindowSize / 100` in
   * tokens. What the user's auto-compact setting produces for
   * their specific session / model. */
  ceiling: number;
  /** `contextUsed / ceiling`, precomputed for readability. */
  fraction: number;
}

export interface UnavailabilityInput {
  /** Pre-read settings.json override value. Required. The resolver
   * never reads the file itself - callers are expected to read
   * once per tick and pass the result. */
  overrideReadResult: OverrideReadResult;
  /** True when the current service instance owns the sentinel
   * file. An unowned sentinel on disk means another WAT321
   * instance has an arm in flight. */
  sentinelOwnedByUs: boolean;
  /** Current live-session context info, or null when no session
   * is targeted. Null skips the context gate - the widget is in
   * a different state anyway ("no live session"). */
  context: ActiveContextInfo | null;
  /** Cached loop-detection scan outcome. Null when no scan has
   * run yet or no session is active. The resolver uses this
   * only for the `loop-suspected` secondary backup. */
  loopHistory: TailHistoryOutcome | null;
}

/**
 * Walk the check list in priority order and return the first
 * matching reason, or `null` if the tool is currently available.
 * Priority:
 *
 *   1. State-based safety (settings missing / io-error / stuck / external sentinel)
 *   2. `below-useful-threshold` (primary context gate)
 *   3. `loop-suspected` (backup defense for small-ceiling edge case)
 *
 * This is a pure function: no disk reads. Callers supply
 * pre-resolved inputs.
 */
export function determineUnavailableReason(
  input: UnavailabilityInput
): UnavailableReason | null {
  // 1. State-based reasons - highest priority.
  const read = input.overrideReadResult;
  if (read.kind === "missing") return "settings-missing";
  if (read.kind === "io-error") return "settings-io-error";
  if (read.value === ARMED_OVERRIDE_VALUE) return "settings-stuck-at-armed";

  // 2. Another WAT321 instance owns the sentinel right now.
  if (!input.sentinelOwnedByUs && existsSync(SENTINEL_PATH)) {
    return "sentinel-exists-external";
  }

  // 3. Primary context gate. Skip entirely when we have no live
  //    session info - the widget is in a different guidance state
  //    and arm is already blocked at a higher level.
  const ctx = input.context;
  if (ctx !== null) {
    if (ctx.fraction < USEFUL_CONTEXT_FRACTION) {
      return "below-useful-threshold";
    }
  }

  // 4. Secondary loop detection backup. Uses mtime as a loose
  //    recency signal because we don't need per-marker accuracy
  //    for a backup gate - the context gate already catches the
  //    common case. False positives here are "refuse arm for a
  //    few extra seconds" which is harmless.
  //
  //    Age is computed HERE against `Date.now()`, not stored on
  //    the outcome. This is load-bearing: the passive tracker
  //    caches `loopHistory` across ticks, so if age were stored
  //    at scan time it would never advance and the widget could
  //    stick on `loop-suspected` until the next transcript write
  //    invalidated the cache. Computing age at resolve time lets
  //    a cached outcome age forward naturally over successive
  //    resolver calls.
  const history = input.loopHistory;
  if (
    history !== null &&
    !history.ioError &&
    history.markerCount >= 2 &&
    history.mtimeMs > 0
  ) {
    const age = Date.now() - history.mtimeMs;
    if (age >= 0 && age < LOOP_WINDOW_MS) {
      return "loop-suspected";
    }
  }

  return null;
}

/** Convenience helper for `arm()`: scan the tail fresh and resolve.
 * Keeps the final defense-in-depth check co-located with the
 * resolver so the two paths cannot drift. */
export function determineUnavailableReasonForArm(
  overrideReadResult: OverrideReadResult,
  sentinelOwnedByUs: boolean,
  context: ActiveContextInfo | null
): UnavailableReason | null {
  const loopHistory =
    context !== null ? scanTailForCompactHistory(context.transcriptPath) : null;
  return determineUnavailableReason({
    overrideReadResult,
    sentinelOwnedByUs,
    context,
    loopHistory,
  });
}

/** Informational hints shown inside the arm confirmation dialog
 * built by the widget. These are NOT safety gates - they inform
 * the user about context adjacent to the action. */
export interface ConfirmHintInput {
  contextFractionOfCeiling?: number;
  otherLiveSessionCount?: number;
}

export interface ConfirmHint {
  code: "near-native-threshold" | "other-live-sessions";
  text: string;
}

export function buildArmConfirmHints(input: ConfirmHintInput): ConfirmHint[] {
  const hints: ConfirmHint[] = [];
  const frac = input.contextFractionOfCeiling;
  if (typeof frac === "number" && frac >= NEAR_NATIVE_THRESHOLD_FRACTION && frac < 1) {
    hints.push({
      code: "near-native-threshold",
      text: "Heads up: your context is close to the native auto-compact threshold. A normal compact may fire on its own before WAT321 does.",
    });
  }
  const others = input.otherLiveSessionCount ?? 0;
  if (others > 0) {
    hints.push({
      code: "other-live-sessions",
      text: `${others} other Claude session${others === 1 ? "" : "s"} detected. The override is global, so prompt in the target first.`,
    });
  }
  return hints;
}
