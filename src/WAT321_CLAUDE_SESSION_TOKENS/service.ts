import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { SessionEntry, WidgetState } from "./types";
import { readTail, readHead } from "../shared/fs/fileReaders";
import { normalizePath, getProjectKey } from "../shared/fs/pathUtils";

const POLL_INTERVAL = 5_000;
const FALLBACK_SCAN_INTERVAL = 51_000;
const STALE_TIMEOUT = 60_000;
// Claude's real default when CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is absent
// is approximately (fullWindow - systemReserve - 13000 tokens), where
// systemReserve is capped at 20000 by the Claude binary. For a 200k
// window this works out to about 83-86% depending on the exact
// system-reserve value for the active model; for a 1M window it is
// closer to 96.7%. We keep 85 as a single fallback that is
// approximately correct for 200k models. The 1M case is off by ~12
// percentage points but the fallback only applies when the user has
// no CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set at all. A model-aware
// fallback that returns the exact percentage per window is tracked
// in issue #38 for v1.0.12.
const DEFAULT_AUTOCOMPACT_PCT = 85;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const EXTENDED_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

type Listener = (state: WidgetState) => void;

interface LastKnownTranscript {
  sessionId: string;
  path: string;
  mtime: number;
}

export class ClaudeSessionTokenService {
  // Initial state reflects Claude CLI presence so the first subscriber
  // sees the correct state and the widget stays hidden on startup when
  // the CLI is not installed (no flash of "Claude -").
  private state: WidgetState = existsSync(join(homedir(), ".claude"))
    ? { status: "no-session" }
    : { status: "not-installed" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workspacePath: string;

  // File cache - keyed by path
  private lastFilePath = "";
  private lastFileSize = 0;

  // Fallback transcript scan (only runs when no live session found)
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastLastKnownScan = 0;

  // Value caches to reduce sync I/O
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitlePath = "";
  private cachedAutoCompactPct: number | null = null;
  private cachedAutoCompactTime = 0;

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

  /** Current transcript file path, or null if no session resolved yet. */
  getActiveTranscriptPath(): string | null {
    return this.lastFilePath || null;
  }

  rebroadcast(): void {
    // Invalidate cached values so next poll picks up setting changes
    this.cachedAutoCompactPct = null;
    this.lastFileSize = 0;
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

  private setState(s: WidgetState): void {
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
    autoCompactPct: number,
    source: "live" | "lastKnown",
    lastActiveAt: number,
  ): void {
    if (this.state.status === "ok") {
      const prev = this.state.session;
      if (
        prev.sessionId === sessionId &&
        prev.label === label &&
        prev.sessionTitle === sessionTitle &&
        prev.contextUsed === contextUsed &&
        prev.contextWindowSize === contextWindowSize &&
        prev.autoCompactPct === autoCompactPct &&
        prev.source === source &&
        prev.lastActiveAt === lastActiveAt
      ) {
        // Values identical - update timestamp but skip rebroadcast
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
        autoCompactPct,
        source,
        lastActiveAt,
      },
    });
  }

  private poll(): void {
    if (this.disposed) return;

    const hasGoodData = this.state.status === "ok";
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const sessionsDir = join(claudeDir, "sessions");

    // Hide entirely if Claude is not installed at all
    if (!existsSync(claudeDir)) {
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    const now = Date.now();

    // Scan live session directory every poll - it's a handful of small
    // PID-keyed JSON files, cheap to read. This is what gives us picker
    // responsiveness when the user resumes a session in the VS Code
    // extension.
    const live = this.findActiveSession(sessionsDir);

    let transcriptPath: string;
    let sessionId: string;
    let cwdForLabel: string;
    let source: "live" | "lastKnown";

    if (live) {
      sessionId = live.sessionId;
      cwdForLabel = live.cwd;
      const projectKey = getProjectKey(live.cwd);
      transcriptPath = join(
        home,
        ".claude",
        "projects",
        projectKey,
        `${sessionId}.jsonl`
      );
      source = "live";
    } else {
      // No live CLI process for this workspace - fall back to the
      // most recently modified transcript in the workspace's projects
      // directory. This is the "last known" mode, refreshed on the
      // slower FALLBACK_SCAN_INTERVAL cadence.
      if (
        now - this.lastLastKnownScan >= FALLBACK_SCAN_INTERVAL ||
        !this.cachedLastKnown
      ) {
        this.cachedLastKnown = this.findLastKnownTranscript(home);
        this.lastLastKnownScan = now;
      }

      if (!this.cachedLastKnown) {
        if (hasGoodData && now - this.lastOkTime < STALE_TIMEOUT) return;
        this.setState({ status: "no-session" });
        return;
      }

      sessionId = this.cachedLastKnown.sessionId;
      transcriptPath = this.cachedLastKnown.path;
      cwdForLabel = this.workspacePath;
      source = "lastKnown";
    }

    if (!existsSync(transcriptPath)) {
      if (hasGoodData && now - this.lastOkTime < STALE_TIMEOUT) return;
      this.setState({ status: "waiting" });
      return;
    }

    // Reset file cache if transcript path changed (session switch)
    if (transcriptPath !== this.lastFilePath) {
      this.lastFileSize = 0;
      this.lastFilePath = transcriptPath;
      this.cachedSessionTitle = null;
    }

    // Stat once for both size-delta check and lastActiveAt
    let size: number;
    let mtime: number;
    try {
      const st = statSync(transcriptPath);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return;
    }
    // Skip re-parse if file hasn't changed
    if (size === this.lastFileSize && hasGoodData) {
      if (this.state.status === "ok") {
        const prev = this.state.session;
        // Source may have flipped (live <-> lastKnown) while size is
        // unchanged. Re-emit only if source actually changed.
        if (prev.source !== source) {
          this.setOkState(
            prev.sessionId,
            prev.label,
            prev.sessionTitle,
            prev.contextUsed,
            prev.contextWindowSize,
            prev.autoCompactPct,
            source,
            mtime,
          );
        }
      }
      return;
    }
    this.lastFileSize = size;

    // Read tail of transcript for usage
    // If read or parse fails during mid-write, keep showing last good data
    const tail = readTail(transcriptPath);
    if (!tail) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = this.parseLastUsage(tail);
    if (!usage) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    // Cache session title - only read head once per transcript path
    if (this.cachedSessionTitle === null || this.cachedSessionTitlePath !== transcriptPath) {
      this.cachedSessionTitle = this.parseFirstUserMessage(transcriptPath);
      this.cachedSessionTitlePath = transcriptPath;
    }

    // Cache autoCompactPct - reread every FALLBACK_SCAN_INTERVAL
    if (
      this.cachedAutoCompactPct === null ||
      now - this.cachedAutoCompactTime >= FALLBACK_SCAN_INTERVAL
    ) {
      this.cachedAutoCompactPct = this.readAutoCompactPct(home);
      this.cachedAutoCompactTime = now;
    }

    const contextWindowSize = EXTENDED_MODELS.some((m) =>
      usage.modelId.includes(m)
    )
      ? 1_000_000
      : DEFAULT_CONTEXT_WINDOW;

    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens;

    const label = basename(cwdForLabel);

    this.setOkState(
      sessionId,
      label,
      this.cachedSessionTitle,
      contextUsed,
      contextWindowSize,
      this.cachedAutoCompactPct,
      source,
      mtime,
    );
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

    // Scan all lines in the tail window (was 100). Post-compact and
    // long-tool-result turns can push the last assistant-with-usage
    // entry well beyond line 100 of a 256KB tail.
    for (let i = lines.length - 1; i >= 0; i--) {
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

  /** Extract the first user message text as session title - reads only the first 8KB */
  private parseFirstUserMessage(path: string): string {
    const head = readHead(path);
    if (!head) return "";

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

    const wsNorm = normalizePath(this.workspacePath);

    // Collect matching sessions, then pick the one whose transcript was
    // modified most recently. This handles /resume correctly - a resumed
    // session has an older startedAt but a newer transcript mtime.
    // entrypoint: "claude-vscode" is used as a tiebreaker when transcript
    // mtimes are equal, not as a primary filter - terminal-launched
    // sessions inside VS Code are still legitimate.
    const home = homedir();
    let best: SessionEntry | null = null;
    let bestMtime = 0;

    for (const file of files) {
      try {
        const entry: SessionEntry = JSON.parse(
          readFileSync(join(sessionsDir, file), "utf8")
        );
        const entryCwd = normalizePath(entry.cwd);
        const match =
          wsNorm === ""
            ? true
            : entryCwd === wsNorm || wsNorm.startsWith(entryCwd + "/");
        if (!match) continue;

        // Check transcript mtime to detect the actually-active session
        const projectKey = getProjectKey(entry.cwd);
        const transcriptPath = join(
          home,
          ".claude",
          "projects",
          projectKey,
          `${entry.sessionId}.jsonl`
        );
        let mtime = entry.startedAt; // fallback if transcript doesn't exist yet
        try {
          mtime = statSync(transcriptPath).mtimeMs;
        } catch {
          // use startedAt as fallback
        }

        const beatsBest = !best || mtime > bestMtime;
        const tieBreak =
          best !== null &&
          mtime === bestMtime &&
          entry.entrypoint === "claude-vscode" &&
          best.entrypoint !== "claude-vscode";

        if (beatsBest || tieBreak) {
          best = entry;
          bestMtime = mtime;
        }
      } catch {
        continue;
      }
    }

    return best;
  }

  /**
   * Scan the current workspace's Claude projects directory for the
   * most-recently-modified transcript. Used as a fallback when no
   * live CLI process matches the workspace. Resolves the project
   * directory case-insensitively to tolerate drive-letter case drift.
   */
  private findLastKnownTranscript(home: string): LastKnownTranscript | null {
    const projectKey = getProjectKey(this.workspacePath);
    const projectsDir = join(home, ".claude", "projects");
    if (!existsSync(projectsDir)) return null;

    let matchedDir: string | null = null;
    try {
      const entries = readdirSync(projectsDir);
      const targetLower = projectKey.toLowerCase();
      for (const e of entries) {
        if (e.toLowerCase() === targetLower) {
          matchedDir = join(projectsDir, e);
          break;
        }
      }
    } catch {
      return null;
    }
    if (!matchedDir) return null;

    let bestPath: string | null = null;
    let bestMtime = 0;
    try {
      const files = readdirSync(matchedDir).filter((f) =>
        f.endsWith(".jsonl")
      );
      for (const file of files) {
        const fullPath = join(matchedDir, file);
        try {
          const mtime = statSync(fullPath).mtimeMs;
          if (mtime > bestMtime) {
            bestPath = fullPath;
            bestMtime = mtime;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }

    if (!bestPath) return null;
    return {
      sessionId: basename(bestPath, ".jsonl"),
      path: bestPath,
      mtime: bestMtime,
    };
  }

  private readAutoCompactPct(home: string): number {
    // Read CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from Claude's own settings.
    // WAT321 does not provide an override setting for this value anymore -
    // the source of truth is Claude's settings file so the display matches
    // the CLI's actual auto-compact behavior.
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
