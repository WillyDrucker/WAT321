import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexResolvedSession, CodexTokenWidgetState } from "./types";
import { readHead, readTail } from "../shared/fs/fileReaders";
import { CompactFlashMachine } from "../shared/polling/compactFlashMachine";
import {
  SESSION_TOKEN_POLL_MS,
  SESSION_TOKEN_RESCAN_MS,
} from "../shared/polling/constants";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import { TpsTracker } from "../shared/sessionTokens/tpsTracker";
import {
  extractSessionId,
  parseCwd,
  extractFirstUserMessage,
  parseLastCompactTimestamp,
  parseLastTokenCount,
  parseLatestModelSlug,
  parseModelSlug,
} from "./parsers";
import { classifyCodexTurn } from "./turnClassifier";
import {
  findLatestRollout,
  getSessionTitle,
  type RolloutCandidate,
} from "./rolloutDiscovery";
import {
  clearPersistedRollout,
  persistRollout,
  readPersistedRollout,
} from "./activeRolloutStore";
import type { NonActiveCompletion } from "../engine/sessionResponseBridge";
import { NonActiveCompletionTracker } from "../shared/sessionTokens/nonActiveCompletionTracker";
import { logNotifEvent } from "../shared/diag/notifEventLog";
import { resolveAutoCompactTokens } from "./autoCompactLimit";

/** fs.watch in the base class handles instant transcript-change
 * detection. The shared `SESSION_TOKEN_POLL_MS` cadence is a safety
 * net for session discovery and missed watcher events.
 * `SESSION_TOKEN_RESCAN_MS` gates the more expensive full rescan. */

/** Flash hold for a completed Codex compact. Codex's `compacted` marker
 * carries no trigger field (no manual/auto distinction) so a single
 * fixed hold is used - between Claude's auto (1.5s) and manual (2.5s)
 * since we can't tell which it was. */
const CODEX_COMPACT_FLASH_MS = 2_000;

export class CodexSessionTokenService extends SessionTokenServiceBase<CodexTokenWidgetState> {
  private cachedRolloutPath: string | null = null;
  private lastRolloutScan = 0;

  /** Watches ~/.codex/sessions/ for new rollout files. Recursive on
   * Windows/macOS to catch date-sharded subdirs, with a fallback to
   * the 51s poll on Linux where recursive watch is unsupported. The
   * callback nulls both `cachedRolloutPath` and `lastRolloutScan` so
   * the next poll re-picks the newest rollout instead of riding the
   * cache through the rescan window. */
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
  /** Latest workspace inventory snapshot. Refreshed inside the same
   * scan that picks the active rollout, surfaced in the emitted
   * state for the multi-session tooltip line. */
  private cachedInventory: { total: number; inProgress: number } = {
    total: 0,
    inProgress: 0,
  };
  /** Wall-clock ms when this service last observed the rollout file
   * grow in byte size. Seeded with kernel mtime on the first poll of a
   * new rollout (so a stale file is not falsely read as live), then
   * `Date.now()` on any later poll where size grew. Feeds
   * `CodexResolvedSession.lastActivityObservedAt` - see that field for
   * why byte-growth, not kernel mtime, drives the freshness gate. */
  private lastObservedGrowthMs: number | null = null;
  /** Smoothed tokens-per-second tracker. Time axis is rollout mtime
   * (not Date.now()) so idle stretches between writes contribute zero
   * seconds to the denominator. Source is cumulative `usage.tokens`
   * because Codex updates that field on every mid-turn `token_count`
   * event. See `shared/sessionTokens/tpsTracker.ts` for the windowing,
   * idle-gap reset, and minimum-age guards. */
  private readonly tpsTracker = new TpsTracker();
  /** Drives the post-compact completion flash. Codex's `compacted`
   * rollout entry is the only observable signal (post-completion, same
   * as Claude) - the shared machine arms a brief flash on each newly-
   * observed boundary. */
  private readonly compactFlash = new CompactFlashMachine();

  /** Detects done-transitions on non-active rollouts in this workspace
   * so the bridge can fire a completion for a session other than the
   * tracked one. Keyed by rollout path, with a 120s fresh window for
   * Codex's long silent reasoning gaps. */
  private readonly nonActiveTracker =
    new NonActiveCompletionTracker<RolloutCandidate>({
      freshWindowMs: 120_000,
      keyOf: (c) => c.path,
      turnStateOf: (c) => c.turnState,
      mtimeOf: (c) => c.mtime,
      buildCompletion: (c, now) => ({
        sessionId: extractSessionId(c.path),
        transcriptPath: c.path,
        label: c.cwd ? basename(c.cwd) : "Codex",
        sessionTitle:
          getSessionTitle(join(homedir(), ".codex"), extractSessionId(c.path)) ?? "",
        completedAtMs: now,
      }),
    });

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".codex"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
    // Re-adopt the session this workspace last tracked so a long-running
    // rollout that has aged past the discovery walk's day-window is
    // picked up again right after a reload, instead of staying invisible
    // until a fresh session is started. The store re-validates the path
    // against the workspace, so a stale or foreign pointer is ignored.
    const seeded = readPersistedRollout(this.workspacePath);
    if (seeded) this.cachedRolloutPath = seeded;
  }

  /** Compact-flash diagnostics for the health command. Mirrors the
   * Claude tier's optional contract method so `WAT321: Show Provider
   * Health` renders Codex compact state too. */
  getCompactDiagnostics(): ReturnType<CompactFlashMachine["getDiagnostics"]> {
    return this.compactFlash.getDiagnostics();
  }

  reset(): void {
    this.cachedRolloutPath = null;
    this.lastRolloutScan = 0;
    clearPersistedRollout();
    this.cachedSessionTitle = null;
    this.cachedSessionTitleId = "";
    this.cachedCwd = null;
    this.cachedCwdPath = "";
    this.cachedModelSlug = null;
    this.cachedAutoCompactTokens = null;
    this.cachedAutoCompactModel = "";
    this.lastObservedGrowthMs = null;
    this.compactFlash.reset();
    this.sessionsWatcher.close();
    this.nonActiveTracker.reset();
    super.reset();
  }

  /** Drain non-active rollout completions since the last call. */
  consumeNonActiveCompletions(): NonActiveCompletion[] {
    return this.nonActiveTracker.drain();
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
      const result = findLatestRollout(
        codexDir,
        this.workspacePath,
        this.cachedRolloutPath
      );
      if (result.path) this.cachedRolloutPath = result.path;
      this.cachedInventory = { total: result.total, inProgress: result.inProgress };
      this.lastRolloutScan = now;
      this.nonActiveTracker.observe(result.candidates, result.path, now);
    }

    if (!this.cachedRolloutPath || !existsSync(this.cachedRolloutPath)) {
      // The tracked rollout has vanished (deleted, Reset WAT321, or
      // ~/.codex cleared). Codex appends to one file per session and
      // never rotates it mid-session, so a missing file means the
      // session is genuinely gone, not transiently unavailable - drop
      // the cached path and go idle rather than rendering last-good
      // forever. An aged-but-present session that simply fell outside
      // the 30-day discovery walk still passes existsSync here, so it
      // keeps rendering and is never cleared by this branch.
      this.cachedRolloutPath = null;
      this.setState({ status: "no-session" });
      return;
    }

    if (this.cachedRolloutPath !== this.cachedTranscriptPath) {
      const prevPath = this.cachedTranscriptPath;
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = this.cachedRolloutPath;
      this.cachedSessionTitle = null;
      this.cachedCwd = null;
      this.cachedModelSlug = null;
      this.cachedAutoCompactTokens = null;
      // New rollout selected. Re-seed the observed-growth watermark on
      // the next size read so we capture this file's kernel mtime as
      // the baseline, rather than carrying forward the prior file's
      // freshness.
      this.lastObservedGrowthMs = null;
      // Log rollout-switches so a missing-notification post-mortem
      // can see exactly when the widget moved between rollouts.
      // The next stat read carries the new rollout's mtime through
      // the normal state flow.
      logNotifEvent({
        at: Date.now(),
        kind: "session-switch",
        provider: "codex",
        fromPath: prevPath,
        toPath: this.cachedRolloutPath,
        fromSessionId: prevPath ? extractSessionId(prevPath) : null,
        toSessionId: extractSessionId(this.cachedRolloutPath),
        source: "rollout-scan",
      });
      // Persist the freshly tracked rollout so a reload can re-adopt it
      // even after its file ages past the discovery walk's day-window.
      persistRollout(this.cachedRolloutPath);
    }

    let rolloutMtime: number;
    let rolloutGrew = false;
    try {
      const st = statSync(this.cachedRolloutPath);
      rolloutGrew = st.size !== this.cachedTranscriptSize;
      if (rolloutGrew) {
        // Seed observed-growth with kernel mtime on the first poll of
        // a new rollout, then wall-clock on subsequent growths so the
        // freshness gate is independent of the kernel mtime cadence.
        this.lastObservedGrowthMs =
          this.lastObservedGrowthMs === null ? st.mtimeMs : Date.now();
        this.cachedTranscriptSize = st.size;
      }
      rolloutMtime = st.mtimeMs;
    } catch {
      return;
    }

    if (!rolloutGrew && this.hasGoodData) return;

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

    const tokensPerSecond = this.tpsTracker.add(
      sessionId,
      rolloutMtime,
      usage.tokens
    );
    // One compact-timestamp read drives both the LOAD banner and the
    // completion flash. Matching both `compacted` + `context_compacted`
    // (parseLastCompactTimestamp) keeps the flash firing even when the
    // large `compacted` line is truncated out of the tail window.
    const lastCompactAt = parseLastCompactTimestamp(tail);
    const compactState = this.compactFlash.sync({
      sessionId,
      now,
      observation: {
        newestBoundaryAt: lastCompactAt,
        flashDurationMs: CODEX_COMPACT_FLASH_MS,
        recentDurationsMs: [],
      },
    });

    const turnState = classifyCodexTurn(tail);
    const lastActivityObservedAt = this.lastObservedGrowthMs ?? rolloutMtime;

    this.emitOk({
      sessionId,
      label: this.cachedCwd ? basename(this.cachedCwd) : "Codex",
      sessionTitle: this.cachedSessionTitle,
      modelSlug: this.cachedModelSlug ?? "",
      contextUsed: usage.tokens,
      contextWindowSize: usage.contextWindowSize,
      autoCompactTokens: this.cachedAutoCompactTokens,
      lastActiveAt: rolloutMtime,
      lastActivityObservedAt,
      turnState,
      lastCompactTimestamp: lastCompactAt,
      tokensPerSecond,
      compactState,
      workspaceSessionInventory: this.cachedInventory,
    });
  }

}
