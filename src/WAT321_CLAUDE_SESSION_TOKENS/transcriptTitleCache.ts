import { parseFirstUserMessage } from "./transcriptParsers";

/**
 * The tracked transcript's title, parsed from its first user message
 * once per transcript. A transcript with no user message yet yields an
 * empty title and is re-read on the next emission, so a new session's
 * title lands as soon as the first prompt is written instead of
 * waiting for the widget to switch transcripts.
 */
export class TranscriptTitleCache {
  private title = "";
  private path = "";

  reset(): void {
    this.title = "";
    this.path = "";
  }

  read(transcriptPath: string): string {
    if (this.title === "" || this.path !== transcriptPath) {
      this.title = parseFirstUserMessage(transcriptPath);
      this.path = transcriptPath;
    }
    return this.title;
  }
}
