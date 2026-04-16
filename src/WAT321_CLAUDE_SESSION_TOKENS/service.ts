import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { StateListener } from "../shared/types";
import type { WidgetState } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey } from "../shared/fs/pathUtils";
import { readAutoCompactPct } from "../shared/claudeSettings";
import { parseFirstUserMessage, parseLastUsage } from "./parsers";
import {
  findActiveSession,
  findLastKnownTranscript,
  type LastKnownTranscript,
} from "./transcriptDiscovery";

const POLL_INTERVAL = 5_000;
const FALLBACK_SCAN_INTERVAL = 51_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const EXTENDED_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];

type Listener = StateListener<WidgetState>;

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

  private lastFilePath = "";
  private lastFileSize = 0;
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastLastKnownScan = 0;
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitlePath = "";
  private cachedAutoCompactPct: number | null = null;
  private cachedAutoCompactTime = 0;

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

  /** Most recent active-transcript mtime in ms, or null if no
   * session has been resolved. Consumed by the Claude usage service
   * as the activity signal that gates the kickstart out of the
   * rate-limited park - if this returns a fresh value, we know
   * Claude is serving the user right now and any rate-limit wait
   * we are sitting on is stale. */
  getLastActivityMs(): number | null {
    if (this.state.status !== "ok") return null;
    return this.state.session.lastActiveAt;
  }

  rebroadcast(): void {
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
    for (const fn of this.listeners) fn(s);
  }

  /** Only emit if visible values actually changed. */
  private setOkState(
    sessionId: string,
    label: string,
    sessionTitle: string,
    contextUsed: number,
    contextWindowSize: number,
    autoCompactPct: number,
    source: "live" | "lastKnown",
    lastActiveAt: number
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

  private resolveTranscript(
    home: string,
    sessionsDir: string,
    now: number
  ): {
    transcriptPath: string;
    sessionId: string;
    cwdForLabel: string;
    source: "live" | "lastKnown";
  } | null {
    const live = findActiveSession(sessionsDir, this.workspacePath);
    if (live) {
      const projectKey = getProjectKey(live.cwd);
      const transcriptPath = join(
        home,
        ".claude",
        "projects",
        projectKey,
        `${live.sessionId}.jsonl`
      );
      // Verify the transcript actually exists on disk before
      // committing to the live branch. A stale `~/.claude/sessions/`
      // entry (left behind by Claude Code after a prior session, or
      // created by the VS Code extension before the user has sent
      // a first prompt) can point at a transcript that was never
      // written. Without this check, poll() locks into "waiting"
      // and the widget goes blank even though `findLastKnownTranscript`
      // would have had a perfectly good fallback - the very bug where
      // opening VS Code twice without launching Claude drops the
      // widget to "Claude -" on the second open.
      if (existsSync(transcriptPath)) {
        return {
          transcriptPath,
          sessionId: live.sessionId,
          cwdForLabel: live.cwd,
          source: "live",
        };
      }
    }

    if (
      now - this.lastLastKnownScan >= FALLBACK_SCAN_INTERVAL ||
      !this.cachedLastKnown
    ) {
      this.cachedLastKnown = findLastKnownTranscript(this.workspacePath);
      this.lastLastKnownScan = now;
    }
    if (!this.cachedLastKnown) return null;
    // Use the transcript's recorded cwd for the label when present.
    // This is the difference between showing "WAT321" for a session
    // that actually came from another project (the global fallback
    // returned a transcript from outside the current workspace) and
    // correctly showing that other project's basename. Falls back to
    // the current workspace path only when the transcript file had
    // no parseable `cwd` field, which keeps the old behavior on
    // malformed or empty transcripts.
    const cwdForLabel =
      this.cachedLastKnown.cwd || this.workspacePath;
    return {
      transcriptPath: this.cachedLastKnown.path,
      sessionId: this.cachedLastKnown.sessionId,
      cwdForLabel,
      source: "lastKnown",
    };
  }

  private poll(): void {
    if (this.disposed) return;

    const hasGoodData = this.state.status === "ok";
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const sessionsDir = join(claudeDir, "sessions");

    if (!existsSync(claudeDir)) {
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    const now = Date.now();
    const resolved = this.resolveTranscript(home, sessionsDir, now);
    if (!resolved) {
      // Never degrade "ok" back to "no-session" once we have good data.
      // Matches the Codex session token service behavior: the most
      // recent transcript is always shown until a better one appears.
      // Without this the widget would blank out mid-session whenever
      // a poll transiently failed to resolve, which is exactly how
      // the user was seeing "Claude -" with "No active Claude session"
      // on startup before the cross-project fallback landed.
      if (hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    const { transcriptPath, sessionId, cwdForLabel, source } = resolved;

    if (!existsSync(transcriptPath)) {
      // Same never-degrade rule for a transcript that briefly vanishes
      // (filesystem hiccup, transcript rename mid-session, etc.).
      if (hasGoodData) return;
      this.setState({ status: "waiting" });
      return;
    }

    if (transcriptPath !== this.lastFilePath) {
      this.lastFileSize = 0;
      this.lastFilePath = transcriptPath;
      this.cachedSessionTitle = null;
    }

    let size: number;
    let mtime: number;
    try {
      const st = statSync(transcriptPath);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return;
    }

    if (size === this.lastFileSize && hasGoodData) {
      if (this.state.status === "ok") {
        const prev = this.state.session;
        if (prev.source !== source) {
          this.setOkState(
            prev.sessionId,
            prev.label,
            prev.sessionTitle,
            prev.contextUsed,
            prev.contextWindowSize,
            prev.autoCompactPct,
            source,
            mtime
          );
        }
      }
      return;
    }
    this.lastFileSize = size;

    const tail = readTail(transcriptPath);
    if (!tail) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = parseLastUsage(tail);
    if (!usage) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    if (
      this.cachedSessionTitle === null ||
      this.cachedSessionTitlePath !== transcriptPath
    ) {
      this.cachedSessionTitle = parseFirstUserMessage(transcriptPath);
      this.cachedSessionTitlePath = transcriptPath;
    }

    if (
      this.cachedAutoCompactPct === null ||
      now - this.cachedAutoCompactTime >= FALLBACK_SCAN_INTERVAL
    ) {
      this.cachedAutoCompactPct = readAutoCompactPct();
      this.cachedAutoCompactTime = now;
    }

    const contextWindowSize = EXTENDED_MODELS.some((m) =>
      usage.modelId.includes(m)
    )
      ? 1_000_000
      : DEFAULT_CONTEXT_WINDOW;

    // Include output_tokens in the footprint. Previous turns' output
    // already lives inside cache_read_input_tokens once the caching
    // layer has folded them into the conversation prefix - we only
    // add the CURRENT turn's output here, so this is not a
    // double-count. Symmetric with the Codex fix earlier in v1.0.19
    // that switched to `last_token_usage.total_tokens` for the same
    // reason: output counts against the context window and skipping
    // it undercounted by 500-4000 tokens per turn.
    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens +
      usage.outputTokens;

    this.setOkState(
      sessionId,
      basename(cwdForLabel),
      this.cachedSessionTitle,
      contextUsed,
      contextWindowSize,
      this.cachedAutoCompactPct,
      source,
      mtime
    );
  }
}
