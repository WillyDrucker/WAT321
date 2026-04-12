import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { CodexSessionIndex, CodexTokenWidgetState } from "./types";
import { readTail, readHead } from "../shared/fs/fileReaders";
import { normalizePath } from "../shared/fs/pathUtils";

const POLL_INTERVAL = 5_000;
const SESSION_SCAN_INTERVAL = 30_000;
const STALE_TIMEOUT = 60_000;
const DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT = 95;
const DEFAULT_CODEX_AUTO_COMPACT_PCT = 90;

type Listener = (state: CodexTokenWidgetState) => void;

export class CodexSessionTokenService {
  // Initial state reflects Codex CLI presence so widgets stay hidden on
  // startup when the CLI is not installed (no startup flash).
  private state: CodexTokenWidgetState = existsSync(join(homedir(), ".codex"))
    ? { status: "no-session" }
    : { status: "not-installed" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workspacePath: string;

  // File cache - keyed by path
  private lastFilePath = "";
  private lastFileSize = 0;

  // Rollout cache
  private cachedRolloutPath: string | null = null;
  private lastRolloutScan = 0;

  // Value caches to reduce sync I/O
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitleId = "";
  private cachedCwd: string | null = null;
  private cachedCwdPath = "";
  private cachedModelSlug: string | null = null;
  private cachedModelPath = "";
  private cachedAutoCompactTokens: number | null = null;
  private cachedAutoCompactModel = "";

  // Last known good tracking
  private lastOkTime = 0;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath.replace(/\\/g, "/");
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  rebroadcast(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private setState(s: CodexTokenWidgetState): void {
    if (this.disposed) return;
    this.state = s;
    if (s.status === "ok") this.lastOkTime = Date.now();
    for (const fn of this.listeners) fn(s);
  }

  /** Only emit if visible values actually changed */
  private setOkState(
    sessionId: string,
    label: string,
    sessionTitle: string,
    contextUsed: number,
    contextWindowSize: number,
    autoCompactTokens: number
  ): void {
    if (this.state.status === "ok") {
      const prev = this.state.session;
      if (
        prev.sessionId === sessionId &&
        prev.label === label &&
        prev.sessionTitle === sessionTitle &&
        prev.contextUsed === contextUsed &&
        prev.contextWindowSize === contextWindowSize &&
        prev.autoCompactTokens === autoCompactTokens
      ) {
        this.lastOkTime = Date.now();
        return;
      }
    }
    this.setState({
      status: "ok",
      session: {
        sessionId,
        label,
        sessionTitle,
        contextUsed,
        contextWindowSize,
        autoCompactTokens,
      },
    });
  }

  private poll(): void {
    if (this.disposed) return;

    const hasGoodData = this.state.status === "ok";
    const now = Date.now();
    const home = homedir();
    const codexDir = join(home, ".codex");

    // Hide entirely if Codex is not installed at all
    if (!existsSync(codexDir)) {
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    // Find the most recent rollout file (re-scan periodically)
    if (
      now - this.lastRolloutScan >= SESSION_SCAN_INTERVAL ||
      !this.cachedRolloutPath
    ) {
      const found = this.findLatestRollout(codexDir);
      if (found) this.cachedRolloutPath = found;
      this.lastRolloutScan = now;
    }

    if (!this.cachedRolloutPath || !existsSync(this.cachedRolloutPath)) {
      if (hasGoodData && now - this.lastOkTime < STALE_TIMEOUT) return;
      this.setState({ status: "no-session" });
      return;
    }

    // Reset file cache if rollout path changed (session switch)
    if (this.cachedRolloutPath !== this.lastFilePath) {
      this.lastFileSize = 0;
      this.lastFilePath = this.cachedRolloutPath;
      this.cachedSessionTitle = null;
      this.cachedCwd = null;
      this.cachedModelSlug = null;
      this.cachedAutoCompactTokens = null;
    }

    // Skip re-parse if file hasn't changed
    try {
      const size = statSync(this.cachedRolloutPath).size;
      if (size === this.lastFileSize && hasGoodData) return;
      this.lastFileSize = size;
    } catch {
      return;
    }

    // Read tail for latest token_count + context window
    // If read or parse fails during mid-write, keep showing last good data
    const tail = readTail(this.cachedRolloutPath);
    if (!tail) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = this.parseLastTokenCount(tail);
    if (!usage) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    // Cache session title by session ID
    const sessionId = this.extractSessionId(this.cachedRolloutPath);
    if (this.cachedSessionTitle === null || this.cachedSessionTitleId !== sessionId) {
      let title = this.getSessionTitle(codexDir, sessionId);
      if (!title) {
        const head = readHead(this.cachedRolloutPath, 32_768);
        if (head) title = this.parseFirstUserMessage(head);
      }
      this.cachedSessionTitle = title;
      this.cachedSessionTitleId = sessionId;
    }

    // Cache cwd by rollout path
    if (this.cachedCwd === null || this.cachedCwdPath !== this.cachedRolloutPath) {
      this.cachedCwd = this.parseCwd(this.cachedRolloutPath);
      this.cachedCwdPath = this.cachedRolloutPath;
    }

    if (this.cachedModelSlug === null || this.cachedModelPath !== this.cachedRolloutPath) {
      this.cachedModelSlug = this.parseModelSlug(this.cachedRolloutPath);
      this.cachedModelPath = this.cachedRolloutPath;
    }

    if (
      this.cachedAutoCompactTokens === null ||
      this.cachedAutoCompactModel !== this.cachedModelSlug
    ) {
      this.cachedAutoCompactTokens = this.resolveAutoCompactTokens(
        usage.contextWindowSize,
        this.cachedModelSlug
      );
      this.cachedAutoCompactModel = this.cachedModelSlug ?? "";
    }

    const label = this.cachedCwd ? basename(this.cachedCwd) : "Codex";

    this.setOkState(
      sessionId,
      label,
      this.cachedSessionTitle,
      usage.inputTokens,
      usage.contextWindowSize,
      this.cachedAutoCompactTokens,
    );
  }

  /**
   * Find the most recent rollout JSONL whose session_meta.cwd matches
   * the current workspace. Walks ~/.codex/sessions/YYYY/MM/DD/ in
   * reverse date order and checks cwd from the first line of each file.
   */
  private findLatestRollout(codexDir: string): string | null {
    const sessionsDir = join(codexDir, "sessions");
    if (!existsSync(sessionsDir)) return null;

    const wsNorm = normalizePath(this.workspacePath);

    try {
      const years = readdirSync(sessionsDir).sort().reverse();
      for (const year of years) {
        const yearDir = join(sessionsDir, year);
        if (!statSync(yearDir).isDirectory()) continue;

        const months = readdirSync(yearDir).sort().reverse();
        for (const month of months) {
          const monthDir = join(yearDir, month);
          if (!statSync(monthDir).isDirectory()) continue;

          const days = readdirSync(monthDir).sort().reverse();
          for (const day of days) {
            const dayDir = join(monthDir, day);
            if (!statSync(dayDir).isDirectory()) continue;

            const files = readdirSync(dayDir)
              .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
              .sort()
              .reverse();

            for (const file of files) {
              const fullPath = join(dayDir, file);
              const cwd = this.parseCwd(fullPath);
              if (!cwd) continue;
              const cwdNorm = normalizePath(cwd);
              // Match workspace or accept any if no workspace open
              if (wsNorm === "" || cwdNorm === wsNorm || wsNorm.startsWith(cwdNorm + "/")) {
                return fullPath;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Extract session ID from rollout filename */
  private extractSessionId(rolloutPath: string): string {
    const filename = basename(rolloutPath, ".jsonl");
    const parts = filename.split("-");
    if (parts.length > 6) {
      return parts.slice(6).join("-");
    }
    return filename;
  }

  /** Get session title from session_index.jsonl by matching session ID */
  private getSessionTitle(codexDir: string, sessionId: string): string {
    const indexPath = join(codexDir, "session_index.jsonl");

    if (!existsSync(indexPath)) return "";

    try {
      const content = readFileSync(indexPath, "utf8");
      const lines = content.trimEnd().split("\n");

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const entry: CodexSessionIndex = JSON.parse(line);
          if (entry.id === sessionId) {
            return entry.thread_name || "";
          }
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
    return "";
  }

  /** Read cwd from session_meta (first line of rollout) */
  private parseCwd(rolloutPath: string): string | null {
    const head = readHead(rolloutPath, 32_768);
    if (!head) return null;

    const firstLine = head.split("\n")[0];
    if (!firstLine) return null;

    try {
      const entry = JSON.parse(firstLine);
      if (entry.type === "session_meta") {
        return (entry.payload?.cwd as string) || null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Extract active model slug from the rollout transcript header */
  private parseModelSlug(rolloutPath: string): string | null {
    const head = readHead(rolloutPath, 65_536);
    if (!head) return null;

    const lines = head.split("\n");
    for (let i = 0; i < lines.length && i < 80; i++) {
      const line = lines[i];
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
          return entry.payload.model;
        }
        if (entry.type === "session_meta" && typeof entry.payload?.model === "string") {
          return entry.payload.model;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Resolve Codex's actual auto-compact ceiling. Upstream core derives this
   * from model metadata as 90% of the model context window, not 100% of the
   * effective window reported in token_count events.
   */
  private resolveAutoCompactTokens(
    reportedContextWindow: number,
    modelSlug: string | null
  ): number {
    const fallback = Math.max(
      1,
      Math.min(
        reportedContextWindow,
        Math.floor(
          reportedContextWindow *
            (DEFAULT_CODEX_AUTO_COMPACT_PCT / DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT)
        )
      )
    );

    if (!modelSlug) return fallback;

    const modelsCachePath = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(modelsCachePath)) return fallback;

    try {
      const raw = readFileSync(modelsCachePath, "utf8");
      const parsed = JSON.parse(raw) as {
        models?: Array<{
          slug?: string;
          context_window?: number;
          auto_compact_token_limit?: number;
        }>;
      };

      const model = parsed.models?.find((entry) => entry.slug === modelSlug);
      if (!model) return fallback;

      const contextWindow =
        typeof model.context_window === "number" && model.context_window > 0
          ? model.context_window
          : null;
      const configuredLimit =
        typeof model.auto_compact_token_limit === "number" &&
        model.auto_compact_token_limit > 0
          ? model.auto_compact_token_limit
          : null;

      if (contextWindow !== null) {
        const defaultLimit = Math.floor(
          contextWindow * (DEFAULT_CODEX_AUTO_COMPACT_PCT / 100)
        );
        return configuredLimit === null
          ? defaultLimit
          : Math.min(configuredLimit, defaultLimit);
      }

      return configuredLimit ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Parse the last token_count event from tail content */
  private parseLastTokenCount(
    content: string
  ): { inputTokens: number; contextWindowSize: number } | null {
    const lines = content.trimEnd().split("\n");

    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      const line = lines[i];
      if (!line) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "token_count") continue;

      const info = payload.info as Record<string, unknown> | undefined;
      if (!info) continue;

      const lastUsage = info.last_token_usage as
        | Record<string, unknown>
        | undefined;
      const contextWindow =
        typeof info.model_context_window === "number"
          ? info.model_context_window
          : 258_400;

      if (!lastUsage || typeof lastUsage.input_tokens !== "number") continue;

      return {
        inputTokens: lastUsage.input_tokens,
        contextWindowSize: contextWindow,
      };
    }
    return null;
  }

  /** Extract first user message text from the head of the rollout */
  private parseFirstUserMessage(headContent: string): string {
    const lines = headContent.trimEnd().split("\n");

    for (let i = 0; i < lines.length && i < 30; i++) {
      const line = lines[i];
      if (!line) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (payload.type === "user_message") {
        const msg = payload.message;
        if (typeof msg === "string") return msg.trim();
      }
    }
    return "";
  }
}
