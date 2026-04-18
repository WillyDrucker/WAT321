import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexResolvedSession, CodexTokenWidgetState } from "./types";
import { readHead, readTail } from "../shared/fs/fileReaders";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import {
  classifyCodexTurn,
  extractSessionId,
  parseCwd,
  extractFirstUserMessage,
  parseLastTokenCount,
  parseLatestModelSlug,
  parseModelSlug,
} from "./parsers";
import { findLatestRollout, getSessionTitle } from "./rolloutDiscovery";
import { resolveAutoCompactTokens } from "./autoCompactLimit";

/** Fallback poll cadence. fs.watch in the base class handles
 * instant transcript-change detection; this interval serves only
 * as a safety net for session discovery and any missed watcher
 * events. 15s keeps discovery responsive without wasting cycles.
 *
 * Discovery runs on every poll. The walk is bounded to 30 days and
 * skips the first-line read on any file that cannot beat the current
 * best mtime, so cost is a handful of statSync calls. A longer
 * interval masks two failure modes: (1) fs.watch on Windows
 * occasionally drops the event for a newly created dated subdir
 * (YYYY/MM/DD) so a brand new rollout is not discovered until the
 * next scan tick, and (2) the user switching to a different session
 * whose rollout file already existed would otherwise wait out the
 * interval. */
const POLL_INTERVAL = 15_000;

export class CodexSessionTokenService extends SessionTokenServiceBase<CodexTokenWidgetState> {
  private cachedRolloutPath: string | null = null;

  /** Watches ~/.codex/sessions/ for new rollout files. Recursive
   * on Windows/macOS to catch date-sharded subdirs; falls back to
   * per-poll discovery on Linux where recursive watch is
   * unsupported. */
  private readonly sessionsWatcher = new PathWatcher(() => {
    this.triggerPoll();
  }, 100, true);
  private cachedSessionTitle: string | null = null;
  private cachedSessionTitleId = "";
  private cachedCwd: string | null = null;
  private cachedCwdPath = "";
  private cachedModelSlug: string | null = null;
  private cachedAutoCompactTokens: number | null = null;
  private cachedAutoCompactModel = "";

  constructor(workspacePath: string) {
    super(
      workspacePath,
      existsSync(join(homedir(), ".codex"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      POLL_INTERVAL
    );
  }

  reset(): void {
    this.cachedRolloutPath = null;
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

    const found = findLatestRollout(codexDir, this.workspacePath);
    if (found) this.cachedRolloutPath = found;

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
    });
  }
}
