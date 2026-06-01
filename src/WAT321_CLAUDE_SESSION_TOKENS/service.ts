import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ResolvedSession, WidgetState } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey } from "../shared/fs/pathUtils";
import {
  readAutoCompactEffectiveTriggerTokens,
  readAutoCompactPct,
  SETTINGS_PATH,
} from "../shared/providers/claude/settings";
import { resolveContextWindow } from "../engine/contracts";
import { PathWatcher } from "../shared/polling/pathWatcher";
import {
  SESSION_TOKEN_POLL_MS,
  SESSION_TOKEN_RESCAN_MS,
} from "../shared/polling/constants";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import { TpsTracker } from "../shared/sessionTokens/tpsTracker";
import { classifyLastEntry } from "../shared/transcriptClassifier";
import { logNotifEvent } from "../shared/diag/notifEventLog";
import type { NonActiveCompletion } from "../engine/sessionResponseBridge";
import { CompactStateMachine } from "./compactStateMachine";
import { parseFirstUserMessage, parseLastUsage } from "./parsers";
import { parseTurnInfo } from "./turnInfoParser";
import {
  readSelectedSession,
  resetSelectedSessionCache,
  resolveStateVscdbPath,
} from "./selectedSessionDetector";
import {
  findLastKnownTranscript,
  rankActiveSession,
  tallyWorkspaceSessions,
  walkWorkspaceSessions,
  type LastKnownTranscript,
  type SessionCandidate,
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

  /** Diagnostic snapshot for the health command. Forwards the state
   * machine's internal view (current state, started-at, estimate, and
   * rolling history) without exposing the machine instance itself. */
  getCompactDiagnostics(): ReturnType<CompactStateMachine["getDiagnostics"]> {
    return this.compactStateMachine.getDiagnostics();
  }

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

  /** Absolute path to VS Code's per-workspace `state.vscdb`, resolved
   * once at construction from the extension's own storage URI parent.
   * `null` when no workspace folder is open at activate time. Reads
   * are cached + stat-gated inside `selectedSessionDetector`, so this
   * value is consulted on every poll cheaply. */
  private readonly stateVscdbPath: string | null;

  /** Debounce key for the rank-decision event log. Empty string until
   * the first emission. Updated only when (sessionId, source) changes,
   * so a stable rank does not flood the log every poll. Cleared in
   * reset() so a workspace switch re-emits the new rank. */
  private lastRankDecisionKey = "";

  /** Per-session turn-state tracker for non-active completion
   * detection. Updated each poll from the candidate walk. */
  private readonly sessionTurnStates = new Map<
    string,
    { turnState: string; mtime: number; reportedAsDone: boolean }
  >();
  private pendingNonActiveCompletions: NonActiveCompletion[] = [];

  constructor(workspacePath: string, extensionStorageDir: string | null) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".claude"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
    this.stateVscdbPath = extensionStorageDir
      ? resolveStateVscdbPath(extensionStorageDir)
      : null;
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
    this.compactStateMachine.reset();
    this.sessionsWatcher.close();
    this.settingsWatcher.close();
    resetSelectedSessionCache();
    this.lastRankDecisionKey = "";
    this.sessionTurnStates.clear();
    this.pendingNonActiveCompletions = [];
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
    if (this.pendingNonActiveCompletions.length === 0) return [];
    const out = this.pendingNonActiveCompletions;
    this.pendingNonActiveCompletions = [];
    return out;
  }

  private emitOk(session: ResolvedSession): void {
    this.setOkStateIfChanged(session, (s) => ({ status: "ok" as const, session: s }));
  }

  private resolveTranscript(
    home: string,
    candidates: readonly SessionCandidate[],
    now: number,
    selectedSessionId: string | null
  ): {
    transcriptPath: string;
    sessionId: string;
    cwdForLabel: string;
    source: "live" | "lastKnown";
    pid?: number;
  } | null {
    const live = rankActiveSession(candidates, selectedSessionId);
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
    // Walk the workspace's Claude sessions once per poll. Both the
    // active-session pick (ranked by activity + freshness) and the
    // multi-session inventory (tally for the tooltip) read from this
    // result, so the walk + per-session tail read does not happen
    // twice.
    const candidates = walkWorkspaceSessions(sessionsDir, this.workspacePath);
    // Read the Claude Code extension's persisted selected-session
    // memento from VS Code's per-workspace state.vscdb. Stat-gated +
    // cached inside the detector so back-to-back polls without a
    // user click hit memory, not SQLite. Falls through to null on
    // every failure mode (no workspace folder, no node:sqlite, no
    // memento yet, SQLite locked) so the ranker's lower tiers still
    // apply.
    const selectedSessionId = this.stateVscdbPath
      ? readSelectedSession(this.stateVscdbPath)?.sessionId ?? null
      : null;
    const resolved = this.resolveTranscript(
      home,
      candidates,
      now,
      selectedSessionId
    );
    if (!resolved) {
      if (this.hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    const { transcriptPath, sessionId, cwdForLabel, source, pid } = resolved;

    // Log the rank-decision so a "widget switched to the wrong
    // session" post-mortem can see whether the memento tier engaged
    // or the disk-only tiers picked. Debounced on (sessionId, source)
    // so a stable rank does not flood the log every poll.
    const rankSource =
      selectedSessionId !== null && sessionId === selectedSessionId
        ? "memento"
        : "disk-tiers";
    const rankKey = `${sessionId}:${rankSource}`;
    if (rankKey !== this.lastRankDecisionKey) {
      logNotifEvent({
        at: now,
        kind: "rank-decision",
        provider: "claude",
        sessionId,
        candidateCount: candidates.length,
        source: rankSource,
      });
      this.lastRankDecisionKey = rankKey;
    }

    if (!existsSync(transcriptPath)) {
      if (this.hasGoodData) return;
      this.setState({ status: "waiting" });
      return;
    }

    if (transcriptPath !== this.cachedTranscriptPath) {
      const prevPath = this.cachedTranscriptPath;
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = transcriptPath;
      this.cachedSessionTitle = null;
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

    const tokensPerSecond = this.tpsTracker.add(sessionId, mtime, contextUsed);
    const turnState = classifyLastEntry(tail);
    const compactState = this.compactStateMachine.sync({
      tail,
      sessionId,
      now,
    });

    // Workspace session inventory for the multi-session tooltip line.
    // Reads the same candidate list that drove the active-session
    // pick above - no second walk, no second round of tail reads.
    const workspaceSessionInventory = tallyWorkspaceSessions(candidates);

    this.detectNonActiveCompletions(candidates, sessionId, now);

    this.emitOk({
      sessionId,
      label: basename(cwdForLabel),
      sessionTitle: this.cachedSessionTitle,
      modelId: usage.modelId,
      contextUsed,
      contextWindowSize,
      autoCompactPct: this.cachedAutoCompactPct,
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

  /** Queue done-transitions on non-active sessions with fresh mtime.
   * First-read for an unknown session is recorded but never queued;
   * a stable done-state does not re-fire (per-session reportedAsDone
   * gate). */
  private detectNonActiveCompletions(
    candidates: readonly SessionCandidate[],
    activeSessionId: string,
    now: number
  ): void {
    const FRESH_WINDOW_MS = 30_000;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const sid = candidate.entry.sessionId;
      seen.add(sid);
      const prev = this.sessionTurnStates.get(sid);
      const isDone = candidate.turnState === "assistant-done";
      const isFresh = now - candidate.mtime <= FRESH_WINDOW_MS;

      if (sid === activeSessionId) {
        // Active session handled by the main bridge path; track state
        // so a future ranking flip inherits a real baseline.
        this.sessionTurnStates.set(sid, {
          turnState: candidate.turnState,
          mtime: candidate.mtime,
          reportedAsDone: isDone,
        });
        continue;
      }

      if (prev === undefined) {
        // First read: record without queuing.
        this.sessionTurnStates.set(sid, {
          turnState: candidate.turnState,
          mtime: candidate.mtime,
          reportedAsDone: isDone,
        });
        continue;
      }

      const wasDone = prev.reportedAsDone;
      const transitionedToDone = isDone && !wasDone;
      if (transitionedToDone && isFresh) {
        this.pendingNonActiveCompletions.push({
          sessionId: sid,
          transcriptPath: candidate.transcriptPath,
          label: basename(candidate.entry.cwd) || candidate.entry.cwd,
          sessionTitle: parseFirstUserMessage(candidate.transcriptPath),
          completedAtMs: now,
        });
      }
      this.sessionTurnStates.set(sid, {
        turnState: candidate.turnState,
        mtime: candidate.mtime,
        reportedAsDone: isDone || (wasDone && candidate.mtime === prev.mtime),
      });
    }
    for (const sid of this.sessionTurnStates.keys()) {
      if (!seen.has(sid)) this.sessionTurnStates.delete(sid);
    }
  }
}
