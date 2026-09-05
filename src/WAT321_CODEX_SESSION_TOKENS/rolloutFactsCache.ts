import { readHead } from "../engine/fs/fileReaders";
import { resolveAutoCompactTokens } from "./autoCompactLimit";
import {
  extractFirstUserMessage,
  parseCwd,
  parseLatestModelSlug,
  parseModelSlug,
} from "./parsers";
import { getSessionTitle } from "./rolloutDiscovery";

/**
 * The slow-changing facts about the tracked rollout: session title,
 * cwd, model slug, and the auto-compact ceiling that depends on the
 * model. Each is re-derived only when its key changes (session, path,
 * or model), so a growth poll pays for the tail parse and nothing
 * else. `forget()` runs when the service switches rollouts.
 */

interface RolloutFacts {
  sessionTitle: string;
  cwd: string | null;
  modelSlug: string | null;
  autoCompactTokens: number;
}

interface RolloutFactsInput {
  codexDir: string;
  rolloutPath: string;
  sessionId: string;
  tail: string;
  contextWindowSize: number;
}

export class RolloutFactsCache {
  private title: string | null = null;
  private titleSessionId = "";
  private cwd: string | null = null;
  private cwdPath = "";
  private modelSlug: string | null = null;
  private autoCompactTokens: number | null = null;
  private autoCompactModel = "";

  /** A new rollout was selected: every fact re-derives on the next read. */
  forget(): void {
    this.title = null;
    this.cwd = null;
    this.modelSlug = null;
    this.autoCompactTokens = null;
  }

  reset(): void {
    this.forget();
    this.titleSessionId = "";
    this.cwdPath = "";
    this.autoCompactModel = "";
  }

  read(input: RolloutFactsInput): RolloutFacts {
    if (this.title === null || this.titleSessionId !== input.sessionId) {
      let title = getSessionTitle(input.codexDir, input.sessionId);
      if (!title) {
        const head = readHead(input.rolloutPath, 32_768);
        if (head) title = extractFirstUserMessage(head);
      }
      this.title = title;
      this.titleSessionId = input.sessionId;
    }

    if (this.cwd === null || this.cwdPath !== input.rolloutPath) {
      this.cwd = parseCwd(input.rolloutPath);
      this.cwdPath = input.rolloutPath;
    }

    // Resolve model from the tail on every file-growth poll so a
    // mid-session /model switch is picked up immediately. Fall back
    // to the header parser for fresh sessions that don't yet have a
    // turn_context in the tail window.
    const latestModel = parseLatestModelSlug(input.tail);
    const resolvedModel =
      latestModel ?? this.modelSlug ?? parseModelSlug(input.rolloutPath);
    if (resolvedModel !== this.modelSlug) {
      this.modelSlug = resolvedModel;
      // Model changed - invalidate ceiling cache so it recomputes.
      this.autoCompactTokens = null;
    }

    if (
      this.autoCompactTokens === null ||
      this.autoCompactModel !== this.modelSlug
    ) {
      this.autoCompactTokens = resolveAutoCompactTokens(
        input.contextWindowSize,
        this.modelSlug
      );
      this.autoCompactModel = this.modelSlug ?? "";
    }

    return {
      sessionTitle: this.title,
      cwd: this.cwd,
      modelSlug: this.modelSlug,
      autoCompactTokens: this.autoCompactTokens,
    };
  }
}
