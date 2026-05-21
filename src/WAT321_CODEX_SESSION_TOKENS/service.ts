import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexResolvedSession, CodexTokenWidgetState } from "./types";
import { parseStageInfo } from "../shared/codex-rollout/phaseParser";
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

/** Flash hold for a completed Codex compact. Codex's `compacted` marker
 * carries no trigger field (no manual/auto distinction) so a single
 * fixed hold is used - between Claude's auto (1.5s) and manual (2.5s)
 * since we can't tell which it was. */
const CODEX_COMPACT_FLASH_MS = 2_000;

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
  /** Smoothed tokens-per-second tracker. Time axis is rollout mtime
   * (not Date.now()) so idle stretches between writes contribute zero
   * seconds to the denominator. Source is cumulative `usage.tokens`
   * because Codex updates that field on every mid-turn `token_count`
   * event - `stageInfo.outputTokens` only refreshes at turn boundary
   * and would either miss the entire turn or jump in one tick. See
   * `shared/sessionTokens/tpsTracker.ts` for the windowing, idle-gap
   * reset, and minimum-age guards. */
  private readonly tpsTracker = new TpsTracker();
  /** Drives the post-compact completion flash. Codex's `compacted`
   * rollout entry is the only observable signal (post-completion, same
   * as Claude); the shared machine arms a brief flash on each newly-
   * observed boundary. */
  private readonly compactFlash = new CompactFlashMachine();

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".codex"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      SESSION_TOKEN_POLL_MS
    );
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
    this.cachedSessionTitle = null;
    this.cachedSessionTitleId = "";
    this.cachedCwd = null;
    this.cachedCwdPath = "";
    this.cachedModelSlug = null;
    this.cachedAutoCompactTokens = null;
    this.cachedAutoCompactModel = "";
    this.compactFlash.reset();
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
      lastCompactTimestamp: lastCompactAt,
      tokensPerSecond,
      compactState,
    });
  }

}
