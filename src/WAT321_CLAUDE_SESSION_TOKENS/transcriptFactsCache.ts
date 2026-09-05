import { SESSION_TOKEN_RESCAN_MS } from "../shared/polling/pollingTimings";
import { readAutoCompactPct } from "../shared/providers/claude/settings";
import { parseFirstUserMessage } from "./parsers";

/**
 * The slow-changing facts about the tracked transcript: the session
 * title, read once per transcript, and the auto-compact threshold,
 * re-read from settings on the rescan cadence or when the settings
 * watcher or a rebroadcast invalidates it.
 */

interface TranscriptFacts {
  sessionTitle: string;
  autoCompactPct: number;
}

export class TranscriptFactsCache {
  private title: string | null = null;
  private titlePath = "";
  private autoCompactPct: number | null = null;
  private autoCompactReadAt = 0;

  /** Settings changed, or a rebroadcast wants fresh numbers. */
  invalidateAutoCompact(): void {
    this.autoCompactPct = null;
  }

  /** A new transcript was selected: the title re-derives on the next read. */
  forgetTitle(): void {
    this.title = null;
  }

  reset(): void {
    this.title = null;
    this.titlePath = "";
    this.autoCompactPct = null;
    this.autoCompactReadAt = 0;
  }

  read(transcriptPath: string, contextWindowSize: number, now: number): TranscriptFacts {
    if (this.title === null || this.titlePath !== transcriptPath) {
      this.title = parseFirstUserMessage(transcriptPath);
      this.titlePath = transcriptPath;
    }
    if (
      this.autoCompactPct === null ||
      now - this.autoCompactReadAt >= SESSION_TOKEN_RESCAN_MS
    ) {
      this.autoCompactPct = readAutoCompactPct(contextWindowSize);
      this.autoCompactReadAt = now;
    }
    return { sessionTitle: this.title, autoCompactPct: this.autoCompactPct };
  }
}
