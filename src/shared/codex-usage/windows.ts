import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import type { CodexUsageResponse, RateLimitWindow } from "./types";

/**
 * Decides which Codex rate-limit window feeds which usage widget, by
 * reading each window's OWN declared duration rather than the slot it
 * arrived in.
 *
 * Why this exists. WAT321 used to map `primary_window` onto the 5-hour
 * widget and `secondary_window` onto the weekly one, purely by position.
 * That assumption broke the day OpenAI retired the 5-hour cap. The API
 * now returns a single `primary_window` whose `limit_window_seconds` is
 * 604800 (seven days), with `secondary_window` null. The 7-day window
 * landed in the 5-hour slot and rendered through the 5-hour formatter,
 * so a reset six days out read "Resets 12:13AM (152hr 49min)". Meanwhile
 * the weekly widget drew a full green bar over a window that no longer
 * existed, because an absent window reports 0% used, which floors to
 * 100% remaining.
 *
 * `limit_window_seconds` is self-describing, so it is the only honest
 * key. A window of a day or less is the short (5-hour-class) limit and
 * anything longer is the long (weekly-class) limit. Label and reset
 * formatter both follow from that, which means an 8-hour or 30-day
 * window OpenAI ships later renders correctly with no code change here.
 *
 * Deliberately STATELESS. There is no mode flag, nothing persisted, and
 * nothing to migrate. Every poll re-derives the layout from the payload
 * in hand, so the day OpenAI restores the 5-hour window the widget
 * returns on the very next poll with nothing to reset and no stale state
 * to unwind. That is a stronger guarantee than a remembered mode could
 * give, because there is nothing here that can get stuck.
 */

/** The line between a short (5-hour-class) and a long (weekly-class)
 * window. Codex ships 18000 (5 hours) and 604800 (7 days), which sit far
 * either side of a day, so the split absorbs OpenAI retuning either
 * window without needing a code change. */
const LONG_WINDOW_THRESHOLD_SECONDS = 24 * 60 * 60;

export interface CodexUsageRow {
  window: RateLimitWindow;
  /** Status-bar caption. */
  label: string;
  /** Tooltip row heading. */
  title: string;
  /** Reset line, already formatted for this window's own duration. */
  resetLine: string;
}

export interface CodexWindowLayout {
  /** What the 5h-slot widget renders. Null only when the payload carried
   * no usable window at all. */
  primary: CodexUsageRow | null;
  /** What the weekly-slot widget renders. Null when there is nothing for
   * it to show. */
  secondary: CodexUsageRow | null;
  /** The ONLY condition under which the weekly widget may hide: Codex
   * definitively published exactly one window. A payload we could not
   * classify leaves this false, so an empty or unreadable response keeps
   * both widgets on screen rather than silently dropping one. Unknown
   * never means hide. */
  hideWeekly: boolean;
}

function isLong(w: RateLimitWindow): boolean {
  return w.limit_window_seconds > LONG_WINDOW_THRESHOLD_SECONDS;
}

function toRow(w: RateLimitWindow, label: string, title: string): CodexUsageRow {
  const resetAtMs = w.reset_at * 1000;
  const resetLine = isLong(w)
    ? formatWeeklyReset(resetAtMs)
    : formatFiveHourReset(resetAtMs);
  return { window: w, label, title, resetLine };
}

export function resolveCodexWindows(
  usage: CodexUsageResponse | null
): CodexWindowLayout {
  const published = [
    usage?.rate_limit?.primary_window,
    usage?.rate_limit?.secondary_window,
  ].filter((w): w is RateLimitWindow => w !== null && w !== undefined);

  const short = published.find((w) => !isLong(w)) ?? null;
  const long = published.find((w) => isLong(w)) ?? null;

  // Both published. The familiar two-bar layout, now keyed off what each
  // window actually is rather than which slot it arrived in.
  if (short !== null && long !== null) {
    return {
      primary: toRow(short, "5h", "5 hour usage limit"),
      secondary: toRow(long, "Weekly", "Weekly usage limit"),
      hideWeekly: false,
    };
  }

  // Exactly one published. It takes the 5h slot so the bar stays where
  // the user already looks, and the weekly widget stands down. A
  // surviving long window is captioned "5h/Weekly" because it is now the
  // only limit and has absorbed what the 5-hour cap used to measure. A
  // surviving short window keeps its own name, since in that case there
  // is no weekly component to fold into it.
  const only = long ?? short;
  if (only !== null) {
    return {
      primary:
        long !== null
          ? toRow(only, "5h/Weekly", "5h / Weekly usage limit")
          : toRow(only, "5h", "5 hour usage limit"),
      secondary: null,
      hideWeekly: true,
    };
  }

  // Nothing classifiable. Fail open: no rows, and crucially no hide, so
  // both widgets keep their scaffold rather than one of them vanishing
  // over a payload we simply could not read.
  return { primary: null, secondary: null, hideWeekly: false };
}
