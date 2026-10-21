import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientStateDir, WAT321_ROOT } from "../../engine/wat321Paths";
import { UsageServiceBase } from "../polling/usageServiceBase";
import { CODEX_AUTH_PATH, CODEX_HOME_DIR } from "../providers/codex/codexHome";
import type { CodexUsageResponse } from "./codexUsageTypes";

/**
 * Codex usage polling against the ChatGPT backend's rate-limit
 * endpoint, authenticated with the OAuth token in `~/.codex/auth.json`.
 * One window at a time writes the shared cache under `WAT321_ROOT`,
 * see `UsageServiceBase`.
 */

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

export class CodexUsageSharedService extends UsageServiceBase<CodexUsageResponse> {
  constructor() {
    super({
      authDir: CODEX_HOME_DIR,
      cacheFile: join(WAT321_ROOT, "codex-usage.cache.json"),
      claimFile: join(WAT321_ROOT, "codex-usage.claim"),
      endpointUrl: "https://chatgpt.com/backend-api/wham/usage",
      providerKey: "codex",
      transitionLogPath: join(clientStateDir(), "codex-usage-transitions.jsonl"),
    });
  }

  protected getAuth(): { token: string; headers: Record<string, string> } | null {
    try {
      const auth: CodexAuth = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
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
