const FILLED = "\uD83D\uDFE6";
const EMPTY = "\u2B1B";

export function makeBar(pct: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}

export function formatSessionReset(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const hrs = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `${hrs}hr ${mins}min`;
}

export function formatWeeklyReset(iso: string): string {
  const resetDate = new Date(iso);
  const diff = resetDate.getTime() - Date.now();
  if (diff <= 0) return "now";

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayName = days[resetDate.getDay()];
  let hours = resetDate.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = resetDate.getMinutes().toString().padStart(2, "0");

  const totalHrs = Math.floor(diff / 3_600_000);
  const d = Math.floor(totalHrs / 24);
  const h = totalHrs % 24;
  const countdown = d > 0 ? `${d}d ${h}hr` : `${h}hr`;

  return `${dayName} ${hours}:${minutes} ${ampm} (${countdown})`;
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
