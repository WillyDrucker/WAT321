import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ResolvedSession, WidgetState } from "./types";
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

/** Fallback poll cadence. fs.watch in the base class handles
 * instant transcript-change detection; this interval serves only
 * as a safety net for session discovery and any missed watcher
 * events. 15s keeps discovery responsive without wasting cycles. */
const POLL_INTERVAL = 15_000;
const FALLBACK_SCAN_INTERVAL = 51_000;

export class ClaudeSessionTokenService extends SessionTokenServiceBase<WidgetState> {
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastFallbackScan = 0;
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

  rebroadcast(): void {
    this.cachedAutoCompactPct = null;
    super.rebroadcast();
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
      now - this.lastFallbackScan >= FALLBACK_SCAN_INTERVAL ||
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
          this.emitOk({ ...prev, source, lastActiveAt: mtime });
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
    });
  }
}
