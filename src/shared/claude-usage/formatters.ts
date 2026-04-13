const FILLED = "\uD83D\uDFE6";
const EMPTY = "\u2B1B";

export function makeBar(pct: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}

export function getMaxLabel(
  extraUsage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null
): string {
  if (!extraUsage?.is_enabled) return "";
  const limit = extraUsage.monthly_limit;
  if (limit === 5000) return "Max (5x)";
  if (limit === 10000) return "Max (10x)";
  if (limit === 20000) return "Max (20x)";
  return `Max ($${limit / 100})`;
}
