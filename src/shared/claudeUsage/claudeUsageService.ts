import { join } from "node:path";
import { clientStateDir, WAT321_ROOT } from "../../engine/wat321Paths";
import { CLAUDE_HOME_DIR } from "../providers/claude/claudeHome";
import { readClaudeOauth } from "../providers/claude/credentials";
import { UsageServiceBase } from "../polling/usageServiceBase";
import type { UsageResponse } from "./claudeUsageTypes";

/**
 * Claude usage polling against the Anthropic OAuth usage endpoint,
 * authenticated with the token in `~/.claude/.credentials.json`. One
 * window at a time writes the shared cache under `WAT321_ROOT`, see
 * `UsageServiceBase`.
 */

export class ClaudeUsageSharedService extends UsageServiceBase<UsageResponse> {
  constructor() {
    super({
      authDir: CLAUDE_HOME_DIR,
      cacheFile: join(WAT321_ROOT, "claude-usage.cache.json"),
      claimFile: join(WAT321_ROOT, "claude-usage.claim"),
      endpointUrl: "https://api.anthropic.com/api/oauth/usage",
      providerKey: "claude",
      transitionLogPath: join(clientStateDir(), "claude-usage-transitions.jsonl"),
    });
  }

  protected getAuth(): { token: string; headers: Record<string, string> } | null {
    const token = readClaudeOauth()?.accessToken;
    if (typeof token !== "string" || token === "") return null;
    return {
      token,
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    };
  }

  protected validateResponse(data: unknown): data is UsageResponse {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;

    for (const key of ["five_hour", "seven_day"]) {
      const value = obj[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== "object") return false;
      const bucket = value as Record<string, unknown>;
      if (typeof bucket.utilization !== "number") return false;
      if (typeof bucket.resets_at !== "string") return false;
    }

    return true;
  }
}
