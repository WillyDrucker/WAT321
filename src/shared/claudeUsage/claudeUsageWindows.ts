import { readClaudePlan } from "../providers/claude/credentials";
import type { UsageResponse } from "./claudeUsageTypes";

/**
 * Whether the Claude 5-hour window is in force. The usage payload decides
 * whenever one is in hand, and the account's plan only while none is.
 * Stateless, so a restored window shows again on the next poll.
 */

/** True only when the 5-hour window is gone, a weekly window proves the
 * payload is a real read, and the limits list holds no session entry.
 * The list's is_active flag marks the tightest limit, not the ones in
 * force, so reading it would hide a live 5-hour bar. */
export function fiveHourRetiredByPayload(usage: UsageResponse): boolean {
  if (usage.five_hour || !usage.seven_day) return false;
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  return !limits.some((entry) => entry?.group === "session");
}

/** True on an Ultra plan, consulted only while no payload is in hand.
 * Verified Ultra accounts have no 5-hour limit. An unverified one keeps a
 * temporary limit, and its first payload brings the bar back. */
export function fiveHourRetiredByPlan(): boolean {
  return readClaudePlan() === "ultra";
}
