import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { UsageServiceBase } from "../polling/usageServiceBase";
import type { CodexUsageResponse } from "./types";

const AUTH_DIR = join(homedir(), ".codex");
const WAT321_DIR = join(homedir(), ".wat321");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

export class CodexUsageSharedService extends UsageServiceBase<CodexUsageResponse> {
  constructor() {
    super({
      authDir: AUTH_DIR,
      cacheFile: join(WAT321_DIR, "codex-usage.cache.json"),
      claimFile: join(WAT321_DIR, "codex-usage.claim"),
      endpointUrl: "https://chatgpt.com/backend-api/wham/usage",
    });
  }

  protected getAuth(): { token: string; headers: Record<string, string> } | null {
    try {
      const auth: CodexAuth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
      const token = auth?.tokens?.access_token;
      if (!token) return null;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "User-Agent": "codex-cli",
      };
      if (auth?.tokens?.account_id) {
        headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
      }
      return { token, headers };
    } catch {
      return null;
    }
  }

  protected validateResponse(data: unknown): data is CodexUsageResponse {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;
    if (typeof obj.plan_type !== "string") return false;
    if (obj.rate_limit !== null && typeof obj.rate_limit !== "object") {
      return false;
    }
    return true;
  }
}
