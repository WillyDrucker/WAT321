import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CodexTokenWidgetState } from "./types";
import { readHead, readTail } from "../shared/fs/fileReaders";
import { SessionTokenServiceBase } from "../shared/polling/sessionTokenServiceBase";
import {
  extractSessionId,
  parseCwd,
  parseFirstUserMessage,
  parseLastTokenCount,
  parseModelSlug,
} from "./parsers";
import { findLatestRollout, getSessionTitle } from "./rolloutDiscovery";
import { resolveAutoCompactTokens } from "./autoCompactLimit";

const POLL_INTERVAL = 6_000;
const SESSION_SCAN_INTERVAL = 51_000;

export class CodexSessionTokenService extends SessionTokenServiceBase<CodexTokenWidgetState> {
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
    super(
      workspacePath,
      existsSync(join(homedir(), ".codex"))
        ? { status: "no-session" }
        : { status: "not-installed" },
      POLL_INTERVAL
    );
  }

  private setOkState(
    sessionId: string,
    label: string,
    sessionTitle: string,
    modelSlug: string,
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
        prev.modelSlug === modelSlug &&
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
        modelSlug,
        contextUsed,
        contextWindowSize,
        autoCompactTokens,
        lastActiveAt,
      },
    });
  }

  protected poll(): void {
    if (this.disposed) return;

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
      if (this.hasGoodData) return;
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
      if (st.size === this.lastFileSize && this.hasGoodData) return;
      this.lastFileSize = st.size;
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
      this.cachedModelSlug ?? "",
      usage.tokens,
      usage.contextWindowSize,
      this.cachedAutoCompactTokens,
      rolloutMtime
    );
  }
}
