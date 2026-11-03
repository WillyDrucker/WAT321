/** The tooltip's plan label, in Anthropic's current plan names. An id
 * outside the table shows as recorded, and no plan shows nothing. */
export function formatPlanLabel(plan: string | null): string {
  if (plan === null) return "";
  const labels: Record<string, string> = {
    free: "Free",
    pro: "Pro",
    max: "Max",
    ultra: "Ultra",
    team: "Team",
    enterprise: "Enterprise",
  };
  return labels[plan] ?? plan;
}
