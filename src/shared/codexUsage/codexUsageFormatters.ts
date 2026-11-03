/** Codex's stats endpoint floors `used_percent` at 1 - even a freshly
 * reset 5h window (verified: `reset_after_seconds === limit_window_seconds`
 * yet `used_percent: 1`) never reports 0. Treating <=1% used as a full
 * window lets the widget read "100%" when you've effectively used
 * nothing, matching how the Claude widget reads 0% used on a fresh
 * window. Above the floor, `Math.floor` keeps the remaining percent a
 * clean integer (used 2.4 -> 98 remaining). The cost is the first ~1%
 * of real usage still reads 100%, which is the right call given the
 * endpoint's own 1% floor. */
export function getRemainingPct(usedPct: number): number {
  const clamped = Math.max(0, Math.min(100, usedPct));
  if (clamped <= 1) return 100;
  return Math.max(0, 100 - Math.floor(clamped));
}

/** The tooltip's plan label for the plan Codex reports. An id outside the
 * table shows as recorded. */
export function formatPlanLabel(planType: string): string {
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    education: "Education",
  };
  return labels[planType] ?? planType;
}
