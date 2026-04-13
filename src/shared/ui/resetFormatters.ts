/**
 * Standardized reset-time formatters shared across every Claude + Codex
 * usage widget. Output is identical regardless of provider so the tooltips
 * read consistently:
 *
 *   5hr window:    "Resets 1:30AM (3hr 30min)"
 *   weekly window: "Resets in Thu (4d 1hr)"
 *
 * Callers pass a ms-epoch timestamp (Claude: `new Date(iso).getTime()`,
 * Codex: `reset_at * 1000`). The helper returns the full string including
 * the "Resets" / "Resets in" prefix so callers do not have to know the
 * difference between the two forms.
 */

const DAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format a 5-hour-window reset as "Resets 1:30AM (3hr 30min)".
 * Returns "Resets now" if the reset time is already in the past.
 */
export function formatFiveHourReset(resetAtMs: number): string {
  if (resetAtMs <= Date.now()) return "Resets now";

  const resetDate = new Date(resetAtMs);
  let hours = resetDate.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = resetDate.getMinutes().toString().padStart(2, "0");
  const clock = `${hours}:${minutes}${ampm}`;

  const diff = resetAtMs - Date.now();
  const hrs = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  const countdown = hrs > 0 ? `${hrs}hr ${mins}min` : `${mins}min`;

  return `Resets ${clock} (${countdown})`;
}

/**
 * Format a weekly-window reset as "Resets in Thu (4d 1hr)".
 * Returns "Resets now" if the reset time is already in the past.
 */
export function formatWeeklyReset(resetAtMs: number): string {
  if (resetAtMs <= Date.now()) return "Resets now";

  const resetDate = new Date(resetAtMs);
  const dayName = DAY_ABBREVIATIONS[resetDate.getDay()];

  const diff = resetAtMs - Date.now();
  const totalHrs = Math.floor(diff / 3_600_000);
  const d = Math.floor(totalHrs / 24);
  const h = totalHrs % 24;
  const countdown = d > 0 ? `${d}d ${h}hr` : `${h}hr`;

  return `Resets in ${dayName} (${countdown})`;
}
