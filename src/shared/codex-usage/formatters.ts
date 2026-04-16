import { makeProgressBar } from "../ui/progressBar";

/** Green square emoji, the default fill character for Codex progress
 * bars. U+1F7E9 LARGE GREEN SQUARE. */
const FILLED_GREEN = "\uD83D\uDFE9";

export function getRemainingPct(usedPct: number): number {
  const clamped = Math.max(0, Math.min(100, usedPct));
  return Math.max(0, 100 - clamped);
}

/** Build an emoji progress bar of `width` cells, filled proportional
 * to `getRemainingPct(usedPct)`. Defaults to green squares. Callers
 * can override the fill character (for example with a heatmap band
 * color from `src/shared/ui/heatmap.ts`) without needing a separate
 * formatter. */
export function makeBar(
  usedPct: number,
  width: number = 10,
  filledChar: string = FILLED_GREEN
): string {
  return makeProgressBar(getRemainingPct(usedPct), width, filledChar);
}

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
