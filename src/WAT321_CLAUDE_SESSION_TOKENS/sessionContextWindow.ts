import { claudeReachesMillionOnVariant, resolveContextWindow } from "../engine/contracts";
import { modelSettingSelectsMillionVariant } from "../shared/providers/claude/settings";

const MILLION = 1_000_000;

/**
 * The context window a Claude session actually runs at.
 *
 * The transcript names the model and never its window, so the answer
 * starts from the model table in `engine/contracts.ts`. Opus 4.6 and
 * Sonnet 4.6 are the case that table cannot settle alone: Claude Code
 * runs them at 200K unless the user picked their `[1m]` variant, and the
 * transcript names both the same way. Two signals prove the 1M variant:
 *
 *   - Claude Code's `model` setting names a `[1m]` variant.
 *   - The session has held more than the model's window, which a 200K
 *     window cannot. That proof sticks for the session, so a compaction
 *     back under 200K does not shrink the denominator.
 */
export class SessionContextWindow {
  private readonly provenMillion = new Set<string>();

  windowFor(sessionId: string, modelId: string, contextUsed: number): number {
    const modelWindow = resolveContextWindow(modelId);
    if (modelWindow >= MILLION) return modelWindow;
    if (contextUsed > modelWindow) this.provenMillion.add(sessionId);
    if (this.provenMillion.has(sessionId)) return MILLION;
    if (claudeReachesMillionOnVariant(modelId) && modelSettingSelectsMillionVariant()) {
      return MILLION;
    }
    return modelWindow;
  }

  reset(): void {
    this.provenMillion.clear();
  }
}
