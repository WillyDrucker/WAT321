import { readAutoCompactOverride } from "../shared/claudeSettings";
import { ARMED_OVERRIDE_VALUE } from "./backups";
import { scanTailForCompactHistory } from "./compactDetector";
import type { ActiveContextInfo, ArmBlocker } from "./types";

/**
 * Preflight gate for the experimental Force Claude Auto-Compact.
 * Pure one-shot check fired once at arm-request time - no caching,
 * no state, no cooldowns, no background polls. Returns `null` if
 * arming is safe, or a specific `ArmBlocker` reason otherwise.
 *
 * The gate set is deliberately small compared to the v1.0.14 widget:
 * no passive availability resolver, no click-to-repair affordance,
 * no loop-detection watcher. Each blocker fires once at tick time
 * and the user gets a single error toast explaining what to fix.
 *
 * Ordering matters. Cheapest / least IO-heavy checks run first so
 * the common "nothing is wrong" path is fast and the slow tail scan
 * only runs when every upstream check passes.
 */

/** Minimum `contextUsed / ceiling` required to arm. Below this
 * fraction there is nothing meaningful for auto-compact to summarize,
 * so arming would waste a compact on an empty-ish session. */
export const USEFUL_CONTEXT_FRACTION = 0.15;

/** Window in which a just-fired native auto-compact still blocks a
 * re-arm. The marker's file mtime is compared against `Date.now()`;
 * if the most recent compact is within this window, the user is
 * already in the post-compact low-context zone and arming would
 * either fail the threshold gate or compact-on-compact. Two minutes
 * is enough slack for a freshly compacted session to start growing
 * context again without an arbitrary long wait. */
export const RECENT_COMPACT_WINDOW_MS = 2 * 60_000;

export interface PreflightInput {
  /** Live context snapshot from the Claude session token service,
   * or `null` if no live Claude session is currently resolved. */
  activeContext: ActiveContextInfo | null;
  /** ms timestamp until which re-arming is refused (post-disarm
   * cooldown). Zero or any value in the past means "no cooldown". */
  cooldownUntil: number;
}

/**
 * Decide whether arming is currently safe. Returns `null` when the
 * user should proceed to the confirmation dialog; returns an
 * `ArmBlocker` otherwise. IO errors on the tail scan bias toward
 * "allow arm" rather than "block" so a broken scanner never
 * permanently refuses the tool - the service's own arm path still
 * runs its own defensive IO checks.
 */
export function determineArmBlocker(input: PreflightInput): ArmBlocker | null {
  // Cheapest checks first.
  if (Date.now() < input.cooldownUntil) return "cooldown";
  if (!input.activeContext) return "no-live-session";
  if (input.activeContext.fraction < USEFUL_CONTEXT_FRACTION) {
    return "below-threshold";
  }

  // One settings read. Safety-critical: distinguishes IO error from
  // "key is genuinely not set" so a locked file cannot masquerade as
  // a clean state.
  const read = readAutoCompactOverride();
  if (read.kind === "io-error") return "io-error";
  if (read.kind === "present" && read.value === ARMED_OVERRIDE_VALUE) {
    return "settings-stuck";
  }

  // One tail scan. Runs only when every upstream check has passed.
  const tail = scanTailForCompactHistory(input.activeContext.transcriptPath);
  if (tail.ioError) return null; // bias toward allow

  // claude-busy: mid-turn detection. Trust classifyLastEntry
  // directly - if the last parsed JSONL entry is a user message
  // (prompt just landed, assistant turn not yet written) or an
  // assistant message with an unresolved tool_use block (waiting
  // on a tool callback), Claude is mid-turn. No age window: the
  // upstream no-live-session gate already guarantees the session
  // is currently running, so a stale tail cannot freeze us here.
  // A long-running tool call whose transcript mtime is minutes
  // old is exactly the scenario we MUST block - it was slipping
  // through the old 60s window gate.
  if (
    tail.lastEntryKind === "user" ||
    tail.lastEntryKind === "assistant-pending"
  ) {
    return "claude-busy";
  }

  // recent-compact: the newest compact marker in the tail window
  // was written within the recent-compact window. Keyed off the
  // marker's own JSONL timestamp, NOT the file mtime - file mtime
  // advances on every transcript write and would false-positive
  // any time an old marker was still inside the 256 KB tail.
  //
  // Guards:
  //   - tail.newestMarkerTimestampMs === 0 means the timestamp
  //     could not be extracted. Bias toward allow; the cooldown
  //     gate is the loop backstop.
  //   - markerAge < 0 means the JSONL timestamp is in the future
  //     (clock skew, corrupt entry). A negative age would otherwise
  //     always be < RECENT_COMPACT_WINDOW_MS and would block the
  //     user permanently. Require a non-negative age to fire.
  if (tail.newestMarkerTimestampMs > 0) {
    const markerAge = Date.now() - tail.newestMarkerTimestampMs;
    if (markerAge >= 0 && markerAge < RECENT_COMPACT_WINDOW_MS) {
      return "recent-compact";
    }
  }

  return null;
}

/** Friendly error-toast text for each blocker reason. Kept in one
 * place so the service file stays focused on state transitions and
 * not on user-visible copy. */
export function formatArmBlockerMessage(
  blocker: ArmBlocker,
  ctx: ActiveContextInfo | null,
  cooldownRemainingMs: number
): string {
  switch (blocker) {
    case "no-live-session":
      return "Open Claude Code and send a prompt first so WAT321 can target your session.";
    case "claude-busy":
      return "Your Claude session is running a prompt. Wait for it to finish.";
    case "below-threshold": {
      const pct = ctx
        ? Math.round(ctx.fraction * 100)
        : 0;
      return `Your session is only at ${pct}%, can't arm until 15%.`;
    }
    case "recent-compact":
      return "Your session was compacted recently. Give it a few minutes before arming again.";
    case "cooldown": {
      const remaining = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
      return `Claude Auto-Compact is in a short cooldown period. Wait ${remaining} second${remaining !== 1 ? "s" : ""} before arming again.`;
    }
    case "settings-stuck":
      return "Your Claude auto-compact override is already set to 1 from a prior session. Run WAT321: Reset All Settings to unstick it.";
    case "io-error":
      return "WAT321 lost access to ~/.claude/settings.json. Try again in a moment.";
  }
}
