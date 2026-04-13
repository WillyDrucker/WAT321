import { existsSync } from "node:fs";
import type { OverrideReadResult } from "../shared/claudeSettings";
import { ARMED_OVERRIDE_VALUE } from "./backups";
import {
  scanTailForCompactHistory,
  type TailHistoryOutcome,
} from "./compactDetector";
import {
  CLAUDE_BUSY_WINDOW_MS,
  LOOP_WINDOW_MS,
  USEFUL_CONTEXT_FRACTION,
} from "./constants";
import { SENTINEL_PATH } from "./sentinel";
import type { UnavailableReason } from "./types";

/**
 * Unified safety / availability gate for Claude Force Auto-Compact.
 * The single pure resolver consulted by the passive poll, the
 * widget's snap check, and `arm()` as a final defense-in-depth.
 *
 * Primary arm gate: the context-fraction check. Below
 * `USEFUL_CONTEXT_FRACTION` (20%) there is nothing meaningful to
 * compact, so arming grays out. `loop-suspected` is a secondary
 * defense for small-ceiling sessions that can land above 20%
 * post-compact. `claude-busy` keeps the user from arming mid-turn
 * so a queued prompt or tool-result callback cannot become the
 * unintended compact trigger.
 *
 * The post-disarm cooldown watcher still runs in the service as a
 * CLI-cache diagnostic (detects stray compacts from a cached env
 * var) but no longer gates arming.
 */

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

  // 4. Busy-Claude gate. If the last JSONL entry in the active
  //    transcript is a user message OR an assistant message with an
  //    unresolved tool_use block, Claude is either about to respond
  //    or is mid-turn. Arming now risks the next compact firing on
  //    a queued prompt or a tool-result callback rather than the
  //    prompt the user actually intended to be the trigger. Wait
  //    for the turn to complete. Auto-clears as soon as the tail
  //    flips to `assistant-done`. Only a fresh-ish transcript is
  //    gated: a dormant session whose last entry happens to be a
  //    user message from yesterday should not block arming, so we
  //    combine the last-entry check with an mtime recency window.
  const history = input.loopHistory;
  if (
    ctx !== null &&
    history !== null &&
    !history.ioError &&
    history.mtimeMs > 0
  ) {
    const age = Date.now() - history.mtimeMs;
    const recentWrite = age >= 0 && age < CLAUDE_BUSY_WINDOW_MS;
    const busyKind =
      history.lastEntryKind === "user" ||
      history.lastEntryKind === "assistant-pending";
    if (recentWrite && busyKind) {
      return "claude-busy";
    }
  }

  // 5. Secondary loop detection backup. Uses mtime as a loose
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

