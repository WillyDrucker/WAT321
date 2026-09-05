import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readTail } from "../engine/fs/fileReaders";
import type { NonActiveCompletion } from "../engine/sessionResponseBridge";
import { parseStageInfo } from "../shared/codex-rollout/stageInfoParser";
import { CompactFlashMachine } from "../shared/polling/compactFlashMachine";
import { SESSION_TOKEN_POLL_MS } from "../shared/polling/pollingTimings";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import { NonActiveCompletionTracker } from "../shared/sessionTokens/nonActiveCompletionTracker";
import { TpsTracker } from "../shared/sessionTokens/tpsTracker";
import { ActiveRolloutTracker } from "./activeRolloutTracker";
import type { CodexResolvedSession, CodexTokenWidgetState } from "./codexSessionTokenTypes";
import {
  extractSessionId,
  parseLastCompactTimestamp,
  parseLastTokenCount,
} from "./parsers";
import { getSessionTitle } from "./rolloutDiscovery";
import type { RolloutCandidate } from "./rolloutRanking";
import { RolloutFactsCache } from "./rolloutFactsCache";
import { classifyCodexTurn } from "./turnClassifier";

/** The shared `SESSION_TOKEN_POLL_MS` cadence is a safety net for
 * session discovery and missed watcher events. Which rollout is
 * tracked, and whether it is still growing, lives in
 * `activeRolloutTracker.ts`. Title, cwd, model, and auto-compact facts
 * about the tracked rollout live in `rolloutFactsCache.ts`. */

/** Flash hold for a completed Codex compact. Codex's `compacted` marker
 * carries no trigger field (no manual/auto distinction) so a single
 * fixed hold is used - between Claude's auto (1.5s) and manual (2.5s)
 * since we can't tell which it was. */
const CODEX_COMPACT_FLASH_MS = 2_000;

export class CodexSessionTokenService extends SessionTokenServiceBase<CodexTokenWidgetState> {
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
  private readonly rollout = new ActiveRolloutTracker(
    this.workspacePath,
    this.nonActiveTracker,
    () => this.triggerPoll()
  );
  private readonly facts = new RolloutFactsCache();
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
   * as Claude) - the shared machine arms a brief flash on each newly-
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
    this.rollout.reset();
    this.facts.reset();
    this.compactFlash.reset();
    this.nonActiveTracker.reset();
    super.reset();
  }

  /** Drain non-active rollout completions since the last call. */
  consumeNonActiveCompletions(): NonActiveCompletion[] {
    return this.nonActiveTracker.drain();
  }

  dispose(): void {
    this.rollout.close();
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
    const codexDir = join(homedir(), ".codex");

    if (!existsSync(codexDir)) {
      this.rollout.close();
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    const rolloutPath = this.rollout.resolve(codexDir, now);
    if (rolloutPath === null) {
      this.setState({ status: "no-session" });
      return;
    }

    if (rolloutPath !== this.cachedTranscriptPath) {
      const prevPath = this.cachedTranscriptPath;
      this.cachedTranscriptSize = 0;
      this.cachedTranscriptPath = rolloutPath;
      this.facts.forget();
      this.rollout.adopt(rolloutPath, prevPath);
    }

    const growth = this.rollout.observeGrowth(rolloutPath, this.cachedTranscriptSize);
    if (growth === null) return;
    if (growth.grew) this.cachedTranscriptSize = growth.size;
    const rolloutMtime = growth.mtimeMs;

    if (!growth.grew && this.hasGoodData) return;

    const tail = readTail(rolloutPath);
    if (!tail) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = parseLastTokenCount(tail);
    if (!usage) {
      if (!this.hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const sessionId = extractSessionId(rolloutPath);
    const facts = this.facts.read({
      codexDir,
      rolloutPath,
      sessionId,
      tail,
      contextWindowSize: usage.contextWindowSize,
    });

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

    const turnState = classifyCodexTurn(tail);
    const lastActivityObservedAt =
      this.rollout.lastActivityObservedAt ?? rolloutMtime;

    this.emitOk({
      sessionId,
      label: facts.cwd ? basename(facts.cwd) : "Codex",
      sessionTitle: facts.sessionTitle,
      modelSlug: facts.modelSlug ?? "",
      contextUsed: usage.tokens,
      contextWindowSize: usage.contextWindowSize,
      autoCompactTokens: facts.autoCompactTokens,
      lastActiveAt: rolloutMtime,
      lastActivityObservedAt,
      turnState,
      stageInfo,
      lastCompactTimestamp: lastCompactAt,
      tokensPerSecond,
      compactState,
      workspaceSessionInventory: this.rollout.inventory,
    });
  }
}
