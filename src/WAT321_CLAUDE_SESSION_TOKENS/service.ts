import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { WidgetState } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey } from "../shared/fs/pathUtils";
import { readAutoCompactPct } from "../shared/claudeSettings";
import { resolveContextWindow } from "../engine/contracts";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import { parseFirstUserMessage, parseLastUsage } from "./parsers";
import {
  findActiveSession,
  findLastKnownTranscript,
  type LastKnownTranscript,
} from "./transcriptDiscovery";

const POLL_INTERVAL = 5_000;
const FALLBACK_SCAN_INTERVAL = 51_000;

export class ClaudeSessionTokenService extends SessionTokenServiceBase<WidgetState> {
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastLastKnownScan = 0;
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitlePath = "";
  private cachedAutoCompactPct: number | null = null;
  private cachedAutoCompactTime = 0;

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".claude"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      POLL_INTERVAL
    );
  }

  /** Current transcript file path, or null if no session resolved yet. */
  getActiveTranscriptPath(): string | null {
    return this.lastFilePath || null;
  }

  rebroadcast(): void {
    this.cachedAutoCompactPct = null;
    super.rebroadcast();
  }

  private setOkState(
    sessionId: string,
    label: string,
    sessionTitle: string,
    modelId: string,
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
        prev.modelId === modelId &&
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
        modelId,
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
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    const now = Date.now();
    const resolved = this.resolveTranscript(home, sessionsDir, now);
    if (!resolved) {
      if (this.hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    const { transcriptPath, sessionId, cwdForLabel, source } = resolved;

    if (!existsSync(transcriptPath)) {
      if (this.hasGoodData) return;
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

    if (size === this.lastFileSize && this.hasGoodData) {
      if (this.state.status === "ok") {
        const prev = this.state.session;
        if (prev.source !== source) {
          this.setOkState(
            prev.sessionId,
            prev.label,
            prev.sessionTitle,
            prev.modelId,
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
      now - this.cachedAutoCompactTime >= FALLBACK_SCAN_INTERVAL
    ) {
      this.cachedAutoCompactPct = readAutoCompactPct(contextWindowSize);
      this.cachedAutoCompactTime = now;
    }

    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens +
      usage.outputTokens;

    this.setOkState(
      sessionId,
      basename(cwdForLabel),
      this.cachedSessionTitle,
      usage.modelId,
      contextUsed,
      contextWindowSize,
      this.cachedAutoCompactPct,
      source,
      mtime
    );
  }
}
