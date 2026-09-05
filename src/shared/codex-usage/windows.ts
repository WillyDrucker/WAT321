import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import type { CodexUsageResponse, RateLimitWindow } from "./codexUsageTypes";

/**
 * Decides which Codex rate-limit window feeds which usage widget, by
 * reading each window's OWN declared duration rather than the slot it
 * arrived in.
 *
 * Why this exists. Slot position is not a contract. The API can publish
 * a single `primary_window` whose `limit_window_seconds` is 604800
 * (seven days) with `secondary_window` null. Mapping windows by slot
 * would push that 7-day window through the 5-hour formatter, so a reset
 * six days out reads "Resets 12:13AM (152hr 49min)", while the weekly
 * widget draws a full green bar over a window that does not exist,
 * because an absent window reports 0% used, which floors to 100%
 * remaining.
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

interface CodexWindowLayout {
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

/** Caption and heading for a window, derived from its own declared length
 * so neither can ever contradict the window it sits on. The 5-hour and
 * 7-day windows Codex ships today keep their familiar names. Anything else
 * gets an honest duration rather than being forced into one of the two. */
function nameFor(w: RateLimitWindow): { label: string; title: string } {
  const seconds = w.limit_window_seconds;
  if (seconds === 18_000) return { label: "5h", title: "5 hour usage limit" };
  if (seconds === 604_800) {
    return { label: "Weekly", title: "Weekly usage limit" };
  }
  if (!isLong(w)) {
    const hours = Math.max(1, Math.round(seconds / 3_600));
    return { label: `${hours}h`, title: `${hours} hour usage limit` };
  }
  const days = Math.max(1, Math.round(seconds / 86_400));
  return { label: `${days}d`, title: `${days} day usage limit` };
}

function toRow(w: RateLimitWindow, label: string, title: string): CodexUsageRow {
  const resetAtMs = w.reset_at * 1000;
  const resetLine = isLong(w)
    ? formatWeeklyReset(resetAtMs)
    : formatFiveHourReset(resetAtMs);
  return { window: w, label, title, resetLine };
}

/** Same as `toRow` but with the caption derived from the window itself.
 * Used everywhere except the collapsed case, which overrides the label. */
function toNamedRow(w: RateLimitWindow): CodexUsageRow {
  const { label, title } = nameFor(w);
  return toRow(w, label, title);
}

export function resolveCodexWindows(
  usage: CodexUsageResponse | null
): CodexWindowLayout {
  const published = [
    usage?.rate_limit?.primary_window,
    usage?.rate_limit?.secondary_window,
  ].filter((w): w is RateLimitWindow => w !== null && w !== undefined);

  // Exactly ONE window. It takes the 5h slot so the bar stays where the
  // user already looks, and the weekly widget stands down. A surviving
  // long window is captioned "5h/Weekly" because it is the only limit in
  // force and covers what a 5-hour cap would. A surviving short window
  // keeps its own name, since there is no weekly component to fold into
  // it.
  //
  // The `length === 1` test is load-bearing and must come first. Testing
  // "no short" or "no long" instead would treat TWO same-class windows as
  // a collapse, silently dropping one of them and hiding the weekly bar.
  if (published.length === 1) {
    const only = published[0];
    return {
      primary: isLong(only)
        ? toRow(only, "5h/Weekly", "5h / Weekly usage limit")
        : toNamedRow(only),
      secondary: null,
      hideWeekly: true,
    };
  }

  // Two windows, one of each class. The familiar layout, now keyed off
  // what each window actually is rather than which slot it arrived in.
  const short = published.find((w) => !isLong(w)) ?? null;
  const long = published.find((w) => isLong(w)) ?? null;
  if (short !== null && long !== null) {
    return {
      primary: toNamedRow(short),
      secondary: toNamedRow(long),
      hideWeekly: false,
    };
  }

  // Two or more windows of the SAME class. Codex has never sent this, but
  // it easily could: a 5-hour cap alongside a daily one would classify as
  // two short windows. Render them in arrival order under their own
  // durations and hide NOTHING. Silently dropping a limit the user is
  // actually subject to is the one outcome worse than an odd-looking bar.
  if (published.length >= 2) {
    return {
      primary: toNamedRow(published[0]),
      secondary: toNamedRow(published[1]),
      hideWeekly: false,
    };
  }

  // Nothing classifiable. Fail open: no rows, and crucially no hide, so
  // both widgets keep their scaffold rather than one of them vanishing
  // over a payload we simply could not read.
  return { primary: null, secondary: null, hideWeekly: false };
}
