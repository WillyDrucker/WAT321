import { readFileSync } from "node:fs";
import { CLAUDE_CREDENTIALS_PATH } from "./claudeHome";

/** The OAuth block of Claude Code's credentials file: the access token
 * the usage service sends, and the plan fields that name the account's
 * tier. Fields stay loose because Claude Code owns the file's shape. */
interface ClaudeOauth {
  accessToken?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
}

/** Ultra replaced Max 20x. A file written before the rename still says
 * subscription "max" with a max_20x tier, the plan Anthropic sells as Ultra. */
const ULTRA_TIER = /max_20x|ultra/i;

/** Fresh read of the OAuth block, or null when the file is missing,
 * unreadable, or carries no OAuth block. */
export function readClaudeOauth(): ClaudeOauth | null {
  try {
    const creds = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, "utf8"));
    const oauth = creds?.claudeAiOauth;
    return oauth !== null && typeof oauth === "object" ? oauth : null;
  } catch {
    return null;
  }
}

/** The account's plan as a lowercase id in Anthropic's current names
 * ("pro", "max", "ultra"), or null when the file names no plan. */
export function readClaudePlan(): string | null {
  const oauth = readClaudeOauth();
  if (oauth === null) return null;
  const { subscriptionType, rateLimitTier } = oauth;
  if (typeof rateLimitTier === "string" && ULTRA_TIER.test(rateLimitTier)) return "ultra";
  if (typeof subscriptionType !== "string" || subscriptionType === "") return null;
  return subscriptionType.toLowerCase();
}
