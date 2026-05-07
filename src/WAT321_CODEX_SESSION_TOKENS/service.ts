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
  /** Per-session rolling token snapshots for TPS computation. Each
   * sample records the cumulative `usage.tokens` (contextUsed) at a
   * wall-clock instant. Rate = (newest.tokens - oldest.tokens) /
   * (newest.atMs - oldest.atMs) over a 60s window.
   *
   * Why cumulative `usage.tokens` instead of `stageInfo.outputTokens`:
   * outputTokens is parsed from the rollout's `last_token_usage`
   * record, which OpenAI only writes at turn boundary. During a
   * 30-second turn, outputTokens stays frozen at the previous turn's
   * value, then jumps to the new total in a single tick - the old
   * sample-and-pause-threshold approach would either miss the entire
   * turn (no movement -> no samples) or take the boundary jump as
   * a 5000-tokens-in-200ms burst and cap at 999. usage.tokens
   * updates with every `event_msg.token_count` event mid-turn, so
   * the rolling window sees real generation rate. Yes, contextUsed
   * also grows from input + tool results, but over a 60s window
   * those contributions are bounded and the noise is acceptable. */
  private tpsPrevSessionId: string | null = null;
  private tpsLastValue: number | null = null;
  private tpsSamples: Array<{ atMs: number; tokens: number }> = [];

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
    const tokensPerSecond = this.computeTps(sessionId, usage.tokens);

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

  /** Compute "average tokens-per-second over the last 60s of activity"
   * from rolling cumulative-token snapshots. Each call appends the
   * current cumulative count + wall-clock timestamp, prunes samples
   * older than 60s, and returns the slope of the window: total token
   * delta divided by total elapsed across the surviving samples.
   *
   * Compaction handling: if cumulative tokens drop between samples
   * (auto-compact reset), the window is cleared and a new baseline
   * is anchored. The rate returns null until at least one positive-
   * delta sample lands.
   *
   * Idle handling: if no new tokens arrive for the full 60s window,
   * the only surviving sample is the newest, the slope is undefined,
   * and the function returns null (widget shows no rate). When
   * generation resumes, samples re-populate naturally. */
  private computeTps(sessionId: string, totalTokens: number): number | null {
    const TPS_MAX = 999;
    const TPS_WINDOW_MS = 60_000;

    if (sessionId !== this.tpsPrevSessionId) {
      this.tpsPrevSessionId = sessionId;
      this.tpsLastValue = null;
      this.tpsSamples = [];
    }

    const now = Date.now();
    // Drop the entire window on a backwards jump (compaction reset).
    // The next positive-delta tick will re-anchor cleanly.
    if (
      this.tpsSamples.length > 0 &&
      totalTokens < this.tpsSamples[this.tpsSamples.length - 1].tokens
    ) {
      this.tpsSamples = [];
      this.tpsLastValue = null;
    }

    this.tpsSamples.push({ atMs: now, tokens: totalTokens });
    const cutoff = now - TPS_WINDOW_MS;
    while (this.tpsSamples.length > 1 && this.tpsSamples[0].atMs < cutoff) {
      this.tpsSamples.shift();
    }

    if (this.tpsSamples.length < 2) {
      // Single sample = no slope. Keep tpsLastValue (which may be
      // null on a fresh session) so the widget either shows the most
      // recent valid rate or nothing.
      return this.tpsLastValue;
    }

    const oldest = this.tpsSamples[0];
    const newest = this.tpsSamples[this.tpsSamples.length - 1];
    const tokenDelta = newest.tokens - oldest.tokens;
    const timeDeltaMs = newest.atMs - oldest.atMs;
    if (timeDeltaMs <= 0 || tokenDelta <= 0) return this.tpsLastValue;

    this.tpsLastValue = Math.min(TPS_MAX, (tokenDelta / timeDeltaMs) * 1000);
    return this.tpsLastValue;
  }
}
