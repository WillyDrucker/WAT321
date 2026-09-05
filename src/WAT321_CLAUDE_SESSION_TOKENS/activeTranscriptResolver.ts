import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectKey } from "../engine/fs/pathIdentity";
import { SESSION_TOKEN_RESCAN_MS } from "../shared/polling/pollingTimings";
import {
  findLastKnownTranscript,
  rankActiveSession,
  type LastKnownTranscript,
  type SessionCandidate,
} from "./transcriptDiscovery";

/**
 * Which transcript the widget follows. A live CLI session for this
 * workspace wins when its transcript exists on disk. Otherwise the
 * newest transcript the workspace ever produced stands in, found by
 * a full scan gated to `SESSION_TOKEN_RESCAN_MS` and cached between
 * scans. `source` tells the tooltip and the health panel which path
 * won, and `pid` is only known for a live session.
 */

interface ActiveTranscript {
  transcriptPath: string;
  sessionId: string;
  cwdForLabel: string;
  source: "live" | "lastKnown";
  pid?: number;
}

export class ActiveTranscriptResolver {
  private cachedLastKnown: LastKnownTranscript | null = null;
  private lastFallbackScan = 0;

  constructor(private readonly workspacePath: string) {}

  /** The sessions dir changed: the next resolve rescans the fallback. */
  invalidate(): void {
    this.lastFallbackScan = 0;
  }

  reset(): void {
    this.cachedLastKnown = null;
    this.lastFallbackScan = 0;
  }

  resolve(
    home: string,
    candidates: readonly SessionCandidate[],
    now: number
  ): ActiveTranscript | null {
    const live = rankActiveSession(candidates);
    if (live) {
      const transcriptPath = join(
        home,
        ".claude",
        "projects",
        getProjectKey(live.cwd),
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
    return {
      transcriptPath: this.cachedLastKnown.path,
      sessionId: this.cachedLastKnown.sessionId,
      cwdForLabel: this.cachedLastKnown.cwd || this.workspacePath,
      source: "lastKnown",
    };
  }
}
