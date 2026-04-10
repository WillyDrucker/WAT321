import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { SessionEntry, WidgetState } from "./types";

const POLL_INTERVAL = 5_000;
const DEFAULT_AUTOCOMPACT_PCT = 85;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const TAIL_BYTES = 65_536; // read last 64KB of transcript — enough for ~100 lines
const EXTENDED_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

type Listener = (state: WidgetState) => void;

export class SessionTokenService {
  private state: WidgetState = { status: "no-session" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workspacePath: string;
  private lastFileSize = 0;

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

  forceRefresh(): void {
    this.lastFileSize = 0; // force re-parse
    this.poll();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private setState(s: WidgetState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private poll(): void {
    if (this.disposed) return;

    const home = homedir();
    const sessionsDir = join(home, ".claude", "sessions");

    // Find active session for this workspace
    const activeSession = this.findActiveSession(sessionsDir);
    if (!activeSession) {
      this.setState({ status: "no-session" });
      return;
    }

    // Find the transcript JSONL for this session
    const projectKey = this.getProjectKey(activeSession.cwd);
    const transcriptPath = join(
      home,
      ".claude",
      "projects",
      projectKey,
      `${activeSession.sessionId}.jsonl`
    );
    if (!existsSync(transcriptPath)) {
      this.setState({ status: "waiting" });
      return;
    }

    // Skip re-parse if file hasn't changed
    try {
      const size = statSync(transcriptPath).size;
      if (size === this.lastFileSize && this.state.status === "ok") return;
      this.lastFileSize = size;
    } catch {
      return;
    }

    // Read tail of transcript for usage, head for session title
    const tail = this.readTail(transcriptPath);
    if (!tail) {
      this.setState({ status: "waiting" });
      return;
    }

    const usage = this.parseLastUsage(tail);
    if (!usage) {
      this.setState({ status: "waiting" });
      return;
    }

    const sessionTitle = this.parseFirstUserMessage(transcriptPath);
    const autoCompactPct = this.readAutoCompactPct(home);
    const contextWindowSize = EXTENDED_MODELS.some((m) =>
      usage.modelId.includes(m)
    )
      ? 1_000_000
      : DEFAULT_CONTEXT_WINDOW;

    // Context = input_tokens + cache_creation + cache_read
    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens;

    const label = basename(activeSession.cwd);

    this.setState({
      status: "ok",
      session: {
        sessionId: activeSession.sessionId,
        label,
        sessionTitle,
        contextUsed,
        contextWindowSize,
        autoCompactPct,
      },
    });
  }

  /** Read the last ~64KB of a file — enough for recent usage without loading the whole transcript */
  private readTail(path: string): string | null {
    try {
      const size = statSync(path).size;
      if (size <= TAIL_BYTES) return readFileSync(path, "utf8");

      const fd = openSync(path, "r");
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      closeSync(fd);
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  /** Walk backwards to find the most recent assistant message with usage */
  private parseLastUsage(
    content: string
  ): {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    modelId: string;
  } | null {
    const lines = content.trimEnd().split("\n");

    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 100; i--) {
      const line = lines[i];
      if (!line) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== "assistant") continue;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg?.usage) continue;

      const usage = msg.usage as Record<string, unknown>;
      const inputTokens =
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const cacheCreation =
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0;
      const cacheRead =
        typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : 0;

      const modelId =
        (msg.model as string) || (entry.model as string) || "";

      return {
        inputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        modelId,
      };
    }
    return null;
  }

  /** Extract the first user message text as session title — reads only the first 8KB */
  private parseFirstUserMessage(path: string): string {
    let head: string;
    try {
      const size = statSync(path).size;
      if (size <= 8192) {
        head = readFileSync(path, "utf8");
      } else {
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(8192);
        readSync(fd, buf, 0, 8192, 0);
        closeSync(fd);
        head = buf.toString("utf8");
      }
    } catch {
      return "";
    }

    const lines = head.trimEnd().split("\n");

    for (let i = 0; i < lines.length && i < 20; i++) {
      const line = lines[i];
      if (!line) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== "user") continue;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      const contentField = msg.content;
      if (typeof contentField === "string") return contentField;
      if (Array.isArray(contentField)) {
        for (const part of contentField) {
          if (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "text"
          ) {
            return ((part as Record<string, unknown>).text as string) || "";
          }
        }
      }
    }
    return "";
  }

  private findActiveSession(sessionsDir: string): SessionEntry | null {
    if (!existsSync(sessionsDir)) return null;

    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return null;
    }

    const normalize = (p: string) =>
      p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const wsNorm = normalize(this.workspacePath);

    let best: SessionEntry | null = null;

    for (const file of files) {
      try {
        const entry: SessionEntry = JSON.parse(
          readFileSync(join(sessionsDir, file), "utf8")
        );
        const entryCwd = normalize(entry.cwd);
        const match =
          wsNorm === ""
            ? true // no workspace — accept any session
            : entryCwd === wsNorm || wsNorm.startsWith(entryCwd + "/");
        if (match) {
          if (!best || entry.startedAt > best.startedAt) {
            best = entry;
          }
        }
      } catch {
        continue;
      }
    }

    return best;
  }

  /**
   * Convert a cwd to the project key used by Claude Code for transcript paths.
   * e.g. "c:\Dev\WAT321" → "c--Dev-WAT321"
   */
  private getProjectKey(cwd: string): string {
    return cwd
      .replace(/\\/g, "/")
      .replace(/^\//, "")
      .replace(/\//g, "-")
      .replace(/:/g, "-");
  }

  private readAutoCompactPct(home: string): number {
    try {
      const settingsPath = join(home, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const override = settings?.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      if (override) {
        const val = parseInt(override, 10);
        if (val >= 1 && val <= 100) return val;
      }
    } catch {
      // ignore
    }
    return DEFAULT_AUTOCOMPACT_PCT;
  }
}
