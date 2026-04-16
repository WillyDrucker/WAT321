import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { WAT321_DIR } from "../../engine/settingsKeys";
import { UsageServiceBase } from "../polling/usageServiceBase";
import type { UsageResponse } from "./types";

const AUTH_DIR = join(homedir(), ".claude");
const CREDENTIALS_FILE = join(AUTH_DIR, ".credentials.json");

export class ClaudeUsageSharedService extends UsageServiceBase<UsageResponse> {
  constructor() {
    super({
      authDir: AUTH_DIR,
      cacheFile: join(WAT321_DIR, "claude-usage.cache.json"),
      claimFile: join(WAT321_DIR, "claude-usage.claim"),
      endpointUrl: "https://api.anthropic.com/api/oauth/usage",
    });
  }

  protected getAuth(): { token: string; headers: Record<string, string> } | null {
    try {
      const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) return null;
      return {
        token,
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      };
    } catch {
      return null;
    }
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
