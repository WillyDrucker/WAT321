import { readHead } from "../engine/fs/fileReaders";
import { resolveAutoCompactTokens } from "./autoCompactLimit";
import {
  extractFirstUserMessage,
  parseCwd,
  parseFirstTurnContext,
  parseLatestTurnContext,
} from "./parsers";
import { getSessionTitle } from "./rolloutDiscovery";

/**
 * The slow-changing facts about the tracked rollout: session title,
 * cwd, model slug and effort, and the auto-compact ceiling that
 * depends on the model. Each is re-derived only when its key changes
 * (session, path, or model), so a growth poll pays for the tail parse
 * and nothing else. `forget()` runs when the service switches rollouts.
 */

interface RolloutFacts {
  sessionTitle: string;
  cwd: string | null;
  modelSlug: string | null;
  effort: string | null;
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
  private effort: string | null = null;
  private autoCompactTokens: number | null = null;
  private autoCompactModel = "";

  /** A new rollout was selected: every fact re-derives on the next read. */
  forget(): void {
    this.title = null;
    this.cwd = null;
    this.modelSlug = null;
    this.effort = null;
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

    // Resolve model and effort from the tail on every file-growth poll
    // so a mid-session /model or effort switch is picked up at once.
    // Both come from one turn_context so they always describe the same
    // turn: the newest in the tail, else the last one seen, else the
    // header's first. A long turn pushes its turn_context out of the
    // tail window, and a fresh session has none there yet.
    const turn =
      parseLatestTurnContext(input.tail) ??
      (this.modelSlug !== null
        ? { model: this.modelSlug, effort: this.effort }
        : parseFirstTurnContext(input.rolloutPath));
    this.effort = turn?.effort ?? null;
    const resolvedModel = turn?.model ?? null;
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
      effort: this.effort,
      autoCompactTokens: this.autoCompactTokens,
    };
  }
}
