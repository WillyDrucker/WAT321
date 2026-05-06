import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexResolvedSession, CodexTokenWidgetState } from "./types";
import { parseStageInfo } from "../shared/codex-rollout/phaseParser";
import { readHead, readTail } from "../shared/fs/fileReaders";
import {
  SESSION_TOKEN_POLL_MS,
  SESSION_TOKEN_RESCAN_MS,
} from "../shared/polling/constants";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import {
  classifyCodexTurn,
  extractSessionId,
  parseCwd,
  extractFirstUserMessage,
  parseLastCompactTimestamp,
  parseLastTokenCount,
  parseLatestModelSlug,
  parseModelSlug,
} from "./parsers";
import { findLatestRollout, getSessionTitle } from "./rolloutDiscovery";
import { resolveAutoCompactTokens } from "./autoCompactLimit";

/** fs.watch in the base class handles instant transcript-change
 * detection; the shared `SESSION_TOKEN_POLL_MS` cadence is a safety
 * net for session discovery and missed watcher events.
 * `SESSION_TOKEN_RESCAN_MS` gates the more expensive full rescan. */

export class CodexSessionTokenService extends SessionTokenServiceBase<CodexTokenWidgetState> {
  private cachedRolloutPath: string | null = null;
  private lastRolloutScan = 0;

  /** Watches ~/.codex/sessions/ for new rollout files. Recursive
   * on Windows/macOS to catch date-sharded subdirs; falls back to
   * the 51s poll on Linux where recursive watch is unsupported.
   *
   * Null the cached rollout path (not just the scan timer) so the
   * next poll re-picks the newest file. Without this, an Epic
   * Handshake prompt that writes to a *different* rollout than the
   * widget's currently-cached one (bridge session vs. user's TUI
   * session) can go unnoticed for up to 51s - the window between
   * rescans - and a short Codex turn may finish before the indicator
   * ever lights up. */
  private readonly sessionsWatcher = new PathWatcher(
    () => {
      this.cachedRolloutPath = null;
      this.lastRolloutScan = 0;
      this.triggerPoll();
    },
    { debounceMs: 100, recursive: true }
  );
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitleId = "";
  private cachedCwd: string | null = null;
  private cachedCwdPath = "";
  private cachedModelSlug: string | null = null;
  private cachedAutoCompactTokens: number | null = null;
  private cachedAutoCompactModel = "";
  /** Per-session prior snapshot for TPS computation. Keyed by sessionId
   * so a switch to a different rollout starts the counter fresh. Uses
   * `stageInfo.outputTokens` (per-turn output) rather than the cumulative
   * contextUsed: contextUsed grows by both input and output and would
   * inflate the rate. */
  private tpsPrevSessionId: string | null = null;
  private tpsPrevOutputTokens = 0;
  private tpsPrevMtimeMs = 0;
  private tpsLastValue: number | null = null;
  /** Rolling 60-second window of accepted samples. See the Claude
   * service's matching field for the smoothing rationale - same
   * shape, same paused-interval rejection, applied to Codex's
   * stageInfo.outputTokens delta. */
  private tpsSamples: Array<{ atMs: number; tokens: number; timeMs: number }> = [];

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".codex"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
  }

  reset(): void {
    this.cachedRolloutPath = null;
    this.lastRolloutScan = 0;
    this.cachedSessionTitle = null;
    this.cachedSessionTitleId = "";
    this.cachedCwd = null;
    this.cachedCwdPath = "";
    this.cachedModelSlug = null;
    this.cachedAutoCompactTokens = null;
    this.cachedAutoCompactModel = "";
    this.sessionsWatcher.close();
    super.reset();
  }

  dispose(): void {
    this.sessionsWatcher.close();
    super.dispose();
  }

  protected getIdleState(): CodexTokenWidgetState {
    return { status: "no-session" };
  }

  private emitOk(session: CodexResolvedSession): void {
    this.setOkStateIfChanged(session, (s) => ({ status: "ok" as const, session: s }));
  }

  protected poll(): void {
    if (this.disposed) return;

    const now = Date.now();
    const home = homedir();
    const codexDir = join(home, ".codex");

    if (!existsSync(codexDir)) {
      this.sessionsWatcher.close();
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    this.sessionsWatcher.sync(join(codexDir, "sessions"));

    if (
      now - this.lastRolloutScan >= SESSION_TOKEN_RESCAN_MS ||
      !this.cachedRolloutPath
    ) {
      const found = findLatestRollout(codexDir, this.workspacePath);
      if (found) this.cachedRolloutPath = found;
      this.lastRolloutScan = now;
    }

    if (!this.cachedRolloutPath || !existsSync(this.cachedRolloutPath)) {
      if (this.hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    if (this.cachedRolloutPath !== this.cachedTranscriptPath) {
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = this.cachedRolloutPath;
      this.cachedSessionTitle = null;
      this.cachedCwd = null;
      this.cachedModelSlug = null;
      this.cachedAutoCompactTokens = null;
    }

    let rolloutMtime: number;
    try {
      const st = statSync(this.cachedRolloutPath);
      if (st.size === this.cachedTranscriptSize && this.hasGoodData) return;
      this.cachedTranscriptSize = st.size;
      rolloutMtime = st.mtimeMs;
    } catch {
      return;
    }

    const tail = readTail(this.cachedRolloutPath);
    if (!tail) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = parseLastTokenCount(tail);
    if (!usage) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const sessionId = extractSessionId(this.cachedRolloutPath);
    if (
      this.cachedSessionTitle === null ||
      this.cachedSessionTitleId !== sessionId
    ) {
      let title = getSessionTitle(codexDir, sessionId);
      if (!title) {
        const head = readHead(this.cachedRolloutPath, 32_768);
        if (head) title = extractFirstUserMessage(head);
      }
      this.cachedSessionTitle = title;
      this.cachedSessionTitleId = sessionId;
    }

    if (
      this.cachedCwd === null ||
      this.cachedCwdPath !== this.cachedRolloutPath
    ) {
      this.cachedCwd = parseCwd(this.cachedRolloutPath);
      this.cachedCwdPath = this.cachedRolloutPath;
    }

    // Resolve model from the tail on every file-growth poll so a
    // mid-session /model switch is picked up immediately. Fall back
    // to the header parser for fresh sessions that don't yet have a
    // turn_context in the tail window.
    const latestModel = parseLatestModelSlug(tail);
    const resolvedModel =
      latestModel ?? this.cachedModelSlug ?? parseModelSlug(this.cachedRolloutPath);
    if (resolvedModel !== this.cachedModelSlug) {
      this.cachedModelSlug = resolvedModel;
      // Model changed - invalidate ceiling cache so it recomputes.
      this.cachedAutoCompactTokens = null;
    }

    if (
      this.cachedAutoCompactTokens === null ||
      this.cachedAutoCompactModel !== this.cachedModelSlug
    ) {
      this.cachedAutoCompactTokens = resolveAutoCompactTokens(
        usage.contextWindowSize,
        this.cachedModelSlug
      );
      this.cachedAutoCompactModel = this.cachedModelSlug ?? "";
    }

    const stageInfo = parseStageInfo(tail);
    const tokensPerSecond = this.computeTps(
      sessionId,
      stageInfo.outputTokens,
      rolloutMtime
    );

    this.emitOk({
      sessionId,
      label: this.cachedCwd ? basename(this.cachedCwd) : "Codex",
      sessionTitle: this.cachedSessionTitle,
      modelSlug: this.cachedModelSlug ?? "",
      contextUsed: usage.tokens,
      contextWindowSize: usage.contextWindowSize,
      autoCompactTokens: this.cachedAutoCompactTokens,
      lastActiveAt: rolloutMtime,
      turnState: classifyCodexTurn(tail),
      stageInfo,
      lastCompactTimestamp: parseLastCompactTimestamp(tail),
      tokensPerSecond,
    });
  }

  /** Compute smoothed TPS over a rolling 60-second window. Mirrors
   * the Claude service's smoothing implementation: rejects samples
   * whose individual gap > 30s as paused (tool wait, agent loop, idle
   * reasoning) so a long-paused turn that suddenly flushes a large
   * chunk of output doesn't register as a spurious-high spike.
   * Persistent across idle, capped at 999. */
  private computeTps(
    sessionId: string,
    outputTokens: number,
    mtimeMs: number
  ): number | null {
    const TPS_MAX = 999;
    // 60s window holds ~12 samples on the 5s safety-net cadence and
    // stays smooth across long Codex turns (often 30-90s on high
    // effort). Same reasoning as the Claude service - keep the two
    // providers in lockstep on smoothing posture so the user reads
    // both widgets the same way.
    const TPS_WINDOW_MS = 60_000;
    const TPS_PAUSE_THRESHOLD_MS = 30_000;

    if (sessionId !== this.tpsPrevSessionId) {
      this.tpsPrevSessionId = sessionId;
      this.tpsPrevOutputTokens = outputTokens;
      this.tpsPrevMtimeMs = mtimeMs;
      this.tpsLastValue = null;
      this.tpsSamples = [];
      return null;
    }

    const tokenDelta = outputTokens - this.tpsPrevOutputTokens;
    const timeDeltaMs = mtimeMs - this.tpsPrevMtimeMs;

    if (tokenDelta < 0) {
      this.tpsPrevOutputTokens = outputTokens;
      this.tpsPrevMtimeMs = mtimeMs;
      return this.tpsLastValue;
    }

    if (tokenDelta > 0 && timeDeltaMs > 0) {
      this.tpsPrevOutputTokens = outputTokens;
      this.tpsPrevMtimeMs = mtimeMs;
      if (timeDeltaMs > TPS_PAUSE_THRESHOLD_MS) {
        return this.tpsLastValue;
      }
      const now = Date.now();
      this.tpsSamples.push({ atMs: now, tokens: tokenDelta, timeMs: timeDeltaMs });
      const cutoff = now - TPS_WINDOW_MS;
      while (this.tpsSamples.length > 0 && this.tpsSamples[0].atMs < cutoff) {
        this.tpsSamples.shift();
      }
      const tokenSum = this.tpsSamples.reduce((s, x) => s + x.tokens, 0);
      const timeSum = this.tpsSamples.reduce((s, x) => s + x.timeMs, 0);
      if (timeSum > 0 && tokenSum > 0) {
        this.tpsLastValue = Math.min(TPS_MAX, (tokenSum / timeSum) * 1000);
      }
    }

    return this.tpsLastValue;
  }
}
