import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexTokenWidgetState } from "./types";
import { readHead, readTail } from "../shared/fs/fileReaders";
import {
  extractSessionId,
  parseCwd,
  parseFirstUserMessage,
  parseLastTokenCount,
  parseModelSlug,
} from "./parsers";
import { findLatestRollout, getSessionTitle } from "./rolloutDiscovery";
import { resolveAutoCompactTokens } from "./autoCompactLimit";

// Staggered 1 s off the Claude session token poll (5_000) so two
// concurrent providers do not stat on the same tick. The 30 s
// kickstart activity window still contains multiple Codex polls, so
// the stagger is free from the usage-service's perspective.
const POLL_INTERVAL = 6_000;
const SESSION_SCAN_INTERVAL = 51_000;

type Listener = (state: CodexTokenWidgetState) => void;

export class CodexSessionTokenService {
  // Initial state reflects Codex CLI presence so widgets stay hidden on
  // startup when the CLI is not installed (no startup flash).
  private state: CodexTokenWidgetState = existsSync(join(homedir(), ".codex"))
    ? { status: "no-session" }
    : { status: "not-installed" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workspacePath: string;

  private lastFilePath = "";
  private lastFileSize = 0;
  private cachedRolloutPath: string | null = null;
  private lastRolloutScan = 0;

  private cachedSessionTitle: string | null = null;
  private cachedSessionTitleId = "";
  private cachedCwd: string | null = null;
  private cachedCwdPath = "";
  private cachedModelSlug: string | null = null;
  private cachedModelPath = "";
  private cachedAutoCompactTokens: number | null = null;
  private cachedAutoCompactModel = "";

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath.replace(/\\/g, "/");
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  rebroadcast(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Most recent active-rollout mtime in ms, or null if no session
   * has been resolved. Mirror of the Claude side - consumed by the
   * Codex usage service as the activity signal that gates the
   * kickstart out of the rate-limited park. */
  getLastActivityMs(): number | null {
    if (this.state.status !== "ok") return null;
    return this.state.session.lastActiveAt;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private setState(s: CodexTokenWidgetState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Only emit if visible values actually changed. */
  private setOkState(
    sessionId: string,
    label: string,
    sessionTitle: string,
    contextUsed: number,
    contextWindowSize: number,
    autoCompactTokens: number,
    lastActiveAt: number
  ): void {
    if (this.state.status === "ok") {
      const prev = this.state.session;
      if (
        prev.sessionId === sessionId &&
        prev.label === label &&
        prev.sessionTitle === sessionTitle &&
        prev.contextUsed === contextUsed &&
        prev.contextWindowSize === contextWindowSize &&
        prev.autoCompactTokens === autoCompactTokens &&
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
        contextUsed,
        contextWindowSize,
        autoCompactTokens,
        lastActiveAt,
      },
    });
  }

  private poll(): void {
    if (this.disposed) return;

    const hasGoodData = this.state.status === "ok";
    const now = Date.now();
    const home = homedir();
    const codexDir = join(home, ".codex");

    if (!existsSync(codexDir)) {
      if (this.state.status !== "not-installed") {
        this.setState({ status: "not-installed" });
      }
      return;
    }

    if (
      now - this.lastRolloutScan >= SESSION_SCAN_INTERVAL ||
      !this.cachedRolloutPath
    ) {
      const found = findLatestRollout(codexDir, this.workspacePath);
      if (found) this.cachedRolloutPath = found;
      this.lastRolloutScan = now;
    }

    if (!this.cachedRolloutPath || !existsSync(this.cachedRolloutPath)) {
      // Never degrade "ok" back to "no-session" once we have good data.
      // The most recent rollout for this workspace is always shown until
      // a better one appears.
      if (hasGoodData) return;
      this.setState({ status: "no-session" });
      return;
    }

    if (this.cachedRolloutPath !== this.lastFilePath) {
      this.lastFileSize = 0;
      this.lastFilePath = this.cachedRolloutPath;
      this.cachedSessionTitle = null;
      this.cachedCwd = null;
      this.cachedModelSlug = null;
      this.cachedAutoCompactTokens = null;
    }

    let rolloutMtime: number;
    try {
      const st = statSync(this.cachedRolloutPath);
      if (st.size === this.lastFileSize && hasGoodData) return;
      this.lastFileSize = st.size;
      rolloutMtime = st.mtimeMs;
    } catch {
      return;
    }

    const tail = readTail(this.cachedRolloutPath);
    if (!tail) {
      if (!hasGoodData) this.setState({ status: "waiting" });
      return;
    }

    const usage = parseLastTokenCount(tail);
    if (!usage) {
      if (!hasGoodData) this.setState({ status: "waiting" });
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
        if (head) title = parseFirstUserMessage(head);
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

    if (
      this.cachedModelSlug === null ||
      this.cachedModelPath !== this.cachedRolloutPath
    ) {
      this.cachedModelSlug = parseModelSlug(this.cachedRolloutPath);
      this.cachedModelPath = this.cachedRolloutPath;
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

    this.setOkState(
      sessionId,
      this.cachedCwd ? basename(this.cachedCwd) : "Codex",
      this.cachedSessionTitle,
      usage.tokens,
      usage.contextWindowSize,
      this.cachedAutoCompactTokens,
      rolloutMtime
    );
  }
}
