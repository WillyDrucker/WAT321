const FILLED = "\uD83D\uDFE9";
const EMPTY = "\u2B1B";

export function getRemainingPct(usedPct: number): number {
  const clamped = Math.max(0, Math.min(100, usedPct));
  return Math.max(0, 100 - clamped);
}

export function makeBar(usedPct: number, width: number = 10): string {
  const remaining = getRemainingPct(usedPct);
  const filled = Math.round((remaining / 100) * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
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
