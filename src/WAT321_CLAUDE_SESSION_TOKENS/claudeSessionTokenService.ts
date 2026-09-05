import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveContextWindow } from "../engine/contracts";
import { readTail } from "../engine/fs/fileReaders";
import { logNotifEvent } from "../engine/notifEventLog";
import type { NonActiveCompletion } from "../engine/sessionResponseBridge";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { SESSION_TOKEN_POLL_MS } from "../shared/polling/pollingTimings";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import {
  readAutoCompactEffectiveTriggerTokens,
  SETTINGS_PATH,
} from "../shared/providers/claude/settings";
import { NonActiveCompletionTracker } from "../shared/sessionTokens/nonActiveCompletionTracker";
import { TpsTracker } from "../shared/sessionTokens/tpsTracker";
import { ActiveTranscriptResolver } from "./activeTranscriptResolver";
import type { ResolvedSession, WidgetState } from "./claudeSessionTokenTypes";
import { CompactStateMachine } from "./compactStateMachine";
import { parseFirstUserMessage, parseLastUsage } from "./parsers";
import {
  tallyWorkspaceSessions,
  walkWorkspaceSessions,
  type SessionCandidate,
} from "./transcriptDiscovery";
import { TranscriptFactsCache } from "./transcriptFactsCache";
import { classifyClaudeTurn } from "./turnClassifier";
import { parseTurnInfo } from "./turnInfoParser";

/** fs.watch in the base class handles instant transcript-change
 * detection. The shared `SESSION_TOKEN_POLL_MS` cadence is a safety
 * net for session discovery and any missed watcher events. Which
 * transcript to follow is decided in `activeTranscriptResolver.ts`,
 * and the title plus auto-compact facts about it are cached in
 * `transcriptFactsCache.ts`. */

export class ClaudeSessionTokenService extends SessionTokenServiceBase<WidgetState> {
  private readonly transcripts: ActiveTranscriptResolver;
  private readonly facts = new TranscriptFactsCache();
  /** Smoothed tokens-per-second tracker. Time axis is transcript mtime
   * (not Date.now()) so idle stretches between writes contribute zero
   * seconds to the denominator. See `shared/sessionTokens/tpsTracker.ts`
   * for the windowing, idle-gap reset, and minimum-age guards that
   * keep first-prompt cache-creation step functions from spiking the
   * counter to 999. */
  private readonly tpsTracker = new TpsTracker();
  /** Compact-progress state machine. Owns the in-flight detection +
   * rolling-duration estimate. Synced once per poll from the same tail
   * the rest of the service reads, plus the classifier output for the
   * activity-recovery exit path. */
  private readonly compactStateMachine = new CompactStateMachine();

  /** Watches ~/.claude/sessions/ for new/removed CLI process files.
   * Triggers an immediate poll so new sessions are detected instantly
   * instead of waiting for the 51s fallback scan. */
  private readonly sessionsWatcher = new PathWatcher(() => {
    this.transcripts.invalidate();
    this.triggerPoll();
  });

  /** Watches ~/.claude/settings.json for auto-compact threshold
   * changes. Invalidates the cached threshold so the tooltip
   * updates immediately. */
  private readonly settingsWatcher = new PathWatcher(() => {
    this.facts.invalidateAutoCompact();
    this.triggerPoll();
  });

  /** Detects done-transitions on non-active sessions in this workspace
   * so the bridge can fire a completion for a session other than the
   * tracked one. Keyed by sessionId, with a 30s fresh window. */
  private readonly nonActiveTracker =
    new NonActiveCompletionTracker<SessionCandidate>({
      freshWindowMs: 30_000,
      keyOf: (c) => c.entry.sessionId,
      turnStateOf: (c) => c.turnState,
      mtimeOf: (c) => c.mtime,
      buildCompletion: (c, now) => ({
        sessionId: c.entry.sessionId,
        transcriptPath: c.transcriptPath,
        label: basename(c.entry.cwd) || c.entry.cwd,
        sessionTitle: parseFirstUserMessage(c.transcriptPath),
        completedAtMs: now,
      }),
    });

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".claude"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
    this.transcripts = new ActiveTranscriptResolver(workspacePath);
  }

  /** Diagnostic snapshot for the health command. Forwards the state
   * machine's internal view (current state, started-at, estimate, and
   * rolling history) without exposing the machine instance itself. */
  getCompactDiagnostics(): ReturnType<CompactStateMachine["getDiagnostics"]> {
    return this.compactStateMachine.getDiagnostics();
  }

  rebroadcast(): void {
    this.facts.invalidateAutoCompact();
    super.rebroadcast();
  }

  reset(): void {
    this.transcripts.reset();
    this.facts.reset();
    this.compactStateMachine.reset();
    this.sessionsWatcher.close();
    this.settingsWatcher.close();
    this.nonActiveTracker.reset();
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

  /** Drain non-active completions since the last call. */
  consumeNonActiveCompletions(): NonActiveCompletion[] {
    return this.nonActiveTracker.drain();
  }

  private emitOk(session: ResolvedSession): void {
    this.setOkStateIfChanged(session, (s) => ({ status: "ok" as const, session: s }));
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
    // Walk the workspace's Claude sessions once per poll. Both the
    // active-session pick (ranked by activity + freshness) and the
    // multi-session inventory (tally for the tooltip) read from this
    // result, so the walk + per-session tail read does not happen
    // twice.
    const candidates = walkWorkspaceSessions(sessionsDir, this.workspacePath);
    const resolved = this.transcripts.resolve(home, candidates, now);
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
      const prevPath = this.cachedTranscriptPath;
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = transcriptPath;
      this.facts.forgetTitle();
      // Log session-switches so a missing-notification post-mortem
      // can see exactly when the widget moved between transcripts.
      // The next emission's stat read carries the new path's mtime
      // through the normal state flow.
      logNotifEvent({
        at: Date.now(),
        kind: "session-switch",
        provider: "claude",
        fromPath: prevPath,
        toPath: transcriptPath,
        fromSessionId: prevPath ? basename(prevPath, ".jsonl") : null,
        toSessionId: sessionId,
        source,
      });
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

    const contextWindowSize = resolveContextWindow(usage.modelId);
    const facts = this.facts.read(transcriptPath, contextWindowSize, now);

    const contextUsed =
      usage.inputTokens +
      usage.cacheCreationTokens +
      usage.cacheReadTokens +
      usage.outputTokens;

    const tokensPerSecond = this.tpsTracker.add(sessionId, mtime, contextUsed);
    const turnState = classifyClaudeTurn(tail);
    const compactState = this.compactStateMachine.sync({
      tail,
      sessionId,
      now,
    });

    // Workspace session inventory for the multi-session tooltip line.
    // Reads the same candidate list that drove the active-session
    // pick above - no second walk, no second round of tail reads.
    const workspaceSessionInventory = tallyWorkspaceSessions(candidates);

    this.nonActiveTracker.observe(candidates, sessionId, now);

    this.emitOk({
      sessionId,
      label: basename(cwdForLabel),
      sessionTitle: facts.sessionTitle,
      modelId: usage.modelId,
      contextUsed,
      contextWindowSize,
      autoCompactPct: facts.autoCompactPct,
      autoCompactEffectiveTokens:
        readAutoCompactEffectiveTriggerTokens(contextWindowSize),
      source,
      lastActiveAt: mtime,
      turnState,
      pid,
      turnInfo: parseTurnInfo(tail),
      tokensPerSecond,
      compactState,
      workspaceSessionInventory,
    });
  }
}
