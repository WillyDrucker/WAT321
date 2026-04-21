import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ResolvedSession, WidgetState } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey } from "../shared/fs/pathUtils";
import { readAutoCompactPct, SETTINGS_PATH } from "../shared/claudeSettings";
import { resolveContextWindow } from "../engine/contracts";
import { PathWatcher } from "../shared/polling/pathWatcher";
import {
  SESSION_TOKEN_POLL_MS,
  SESSION_TOKEN_RESCAN_MS,
} from "../shared/polling/constants";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import { classifyLastEntry } from "../shared/transcriptClassifier";
import { parseFirstUserMessage, parseLastUsage, parseTurnInfo } from "./parsers";
import {
  findActiveSession,
  findLastKnownTranscript,
  type LastKnownTranscript,
} from "./transcriptDiscovery";

/** fs.watch in the base class handles instant transcript-change
 * detection; the shared `SESSION_TOKEN_POLL_MS` cadence is a safety
 * net for session discovery and any missed watcher events.
 * `SESSION_TOKEN_RESCAN_MS` gates the more expensive full rescan. */

export class ClaudeSessionTokenService extends SessionTokenServiceBase<WidgetState> {
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastFallbackScan = 0;
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitlePath = "";
  private cachedAutoCompactPct: number | null = null;
  private cachedAutoCompactTime = 0;

  /** Watches ~/.claude/sessions/ for new/removed CLI process files.
   * Triggers an immediate poll so new sessions are detected instantly
   * instead of waiting for the 51s fallback scan. */
  private readonly sessionsWatcher = new PathWatcher(() => {
    this.lastFallbackScan = 0;
    this.triggerPoll();
  });

  /** Watches ~/.claude/settings.json for auto-compact threshold
   * changes. Invalidates the cached threshold so the tooltip
   * updates immediately. */
  private readonly settingsWatcher = new PathWatcher(() => {
    this.cachedAutoCompactPct = null;
    this.triggerPoll();
  });

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".claude"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
  }

  rebroadcast(): void {
    this.cachedAutoCompactPct = null;
    super.rebroadcast();
  }

  reset(): void {
    this.cachedLastKnown = null;
    this.lastFallbackScan = 0;
    this.cachedSessionTitle = null;
    this.cachedSessionTitlePath = "";
    this.cachedAutoCompactPct = null;
    this.cachedAutoCompactTime = 0;
    this.sessionsWatcher.close();
    this.settingsWatcher.close();
    super.reset();
  }

  dispose(): void {
    this.sessionsWatcher.close();
    this.settingsWatcher.close();
    super.dispose();
  }

  protected getIdleState(): WidgetState {
    return { status: "no-session" };
  }

  private emitOk(session: ResolvedSession): void {
    this.setOkStateIfChanged(session, (s) => ({ status: "ok" as const, session: s }));
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
    pid?: number;
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
      if (existsSync(transcriptPath)) {
        return {
          transcriptPath,
          sessionId: live.sessionId,
          cwdForLabel: live.cwd,
          source: "live",
          pid: live.pid,
        };
      }
    }

    if (
      now - this.lastFallbackScan >= SESSION_TOKEN_RESCAN_MS ||
      !this.cachedLastKnown
    ) {
      this.cachedLastKnown = findLastKnownTranscript(this.workspacePath);
      this.lastFallbackScan = now;
    }
    if (!this.cachedLastKnown) return null;
    const cwdForLabel =
      this.cachedLastKnown.cwd || this.workspacePath;
    return {
      transcriptPath: this.cachedLastKnown.path,
      sessionId: this.cachedLastKnown.sessionId,
      cwdForLabel,
      source: "lastKnown",
    };
  }

  protected poll(): void {
    if (this.disposed) return;

    const home = homedir();
    const claudeDir = join(home, ".claude");
    const sessionsDir = join(claudeDir, "sessions");

    if (!existsSync(claudeDir)) {
      this.sessionsWatcher.close();
      this.settingsWatcher.close();
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    this.sessionsWatcher.sync(sessionsDir);
    this.settingsWatcher.sync(SETTINGS_PATH);

    const now = Date.now();
    const resolved = this.resolveTranscript(home, sessionsDir, now);
    if (!resolved) {
      if (this.hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    const { transcriptPath, sessionId, cwdForLabel, source, pid } = resolved;

    if (!existsSync(transcriptPath)) {
      if (this.hasGoodData) return;
      this.setState({ status: "waiting" });
      return;
    }

    if (transcriptPath !== this.cachedTranscriptPath) {
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = transcriptPath;
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

    if (size === this.cachedTranscriptSize && this.hasGoodData) {
      if (this.state.status === "ok") {
        const prev = this.state.session;
        if (prev.source !== source) {
          // Re-emit with the CURRENT resolved pid. Spreading prev
          // alone would preserve a stale live pid after a live ->
          // lastKnown transition, or miss the fresh pid on
          // lastKnown -> live. pid comes from the outer destructure
          // and is undefined for lastKnown by design.
          this.emitOk({ ...prev, source, lastActiveAt: mtime, pid });
        }
      }
      return;
    }
    this.cachedTranscriptSize = size;

    const tail = readTail(transcriptPath);
    if (!tail) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = parseLastUsage(tail);
    if (!usage) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    if (
      this.cachedSessionTitle === null ||
      this.cachedSessionTitlePath !== transcriptPath
    ) {
      this.cachedSessionTitle = parseFirstUserMessage(transcriptPath);
      this.cachedSessionTitlePath = transcriptPath;
    }

    const contextWindowSize = resolveContextWindow(usage.modelId);

    if (
      this.cachedAutoCompactPct === null ||
      now - this.cachedAutoCompactTime >= SESSION_TOKEN_RESCAN_MS
    ) {
      this.cachedAutoCompactPct = readAutoCompactPct(contextWindowSize);
      this.cachedAutoCompactTime = now;
    }

    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens +
      usage.outputTokens;

    this.emitOk({
      sessionId,
      label: basename(cwdForLabel),
      sessionTitle: this.cachedSessionTitle,
      modelId: usage.modelId,
      contextUsed,
      contextWindowSize,
      autoCompactPct: this.cachedAutoCompactPct,
      source,
      lastActiveAt: mtime,
      turnState: classifyLastEntry(tail),
      pid,
      turnInfo: parseTurnInfo(tail),
    });
  }
}
