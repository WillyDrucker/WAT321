const FILLED = "\uD83D\uDFE9";
const EMPTY = "\u2B1B";
const BAR_WIDTH = 10;

export function getRemainingPct(usedPct: number): number {
  const clamped = Math.max(0, Math.min(100, usedPct));
  return Math.max(0, 100 - clamped);
}

export function makeBar(usedPct: number): string {
  const remaining = getRemainingPct(usedPct);
  const filled = Math.round((remaining / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}

export function formatWindowReset(resetAtEpoch: number): string {
  const resetDate = new Date(resetAtEpoch * 1000);
  if (resetDate.getTime() <= Date.now()) return "now";

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[resetDate.getMonth()];
  const day = resetDate.getDate();
  const year = resetDate.getFullYear();
  let hours = resetDate.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = resetDate.getMinutes().toString().padStart(2, "0");

  return `${month} ${day}, ${year} ${hours}:${minutes} ${ampm}`;
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
