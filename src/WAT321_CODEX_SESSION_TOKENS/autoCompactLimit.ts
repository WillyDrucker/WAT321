import { existsSync, readFileSync } from "node:fs";
import { CODEX_MODELS_CACHE_PATH } from "../shared/providers/codex/codexHome";

/**
 * The Codex session token ceiling, matching Codex's own hover:
 * `context_window * effective_context_window_percent / 100`, both read
 * per slug from `~/.codex/models_cache.json` because the `model/list`
 * RPC carries no context window at all. Window sizes are OpenAI's to
 * change per model and per release, so neither value is assumed, and
 * the cache's `max_context_window` is a different ceiling. When the
 * cache lacks the active slug (another codex binary overwrote it), the
 * rollout's reported `model_context_window` stands in, which upstream
 * already computes as the effective window.
 *
 * This ceiling is the display denominator, the usable input budget
 * after reserved headroom. The compact trigger itself fires earlier,
 * at `context_window * 0.9`, and `getSessionTokenColor` warns ahead of
 * it with its own thresholds.
 */

/** Codex subtracts this baseline from both numerator and denominator
 * when computing `percent_of_context_window_remaining` (see
 * `codex-rs/protocol/src/protocol.rs`). Accounts for prompts, tools,
 * and space to call compact. Shared by the widget and tooltip. */
export const CODEX_BASELINE_TOKENS = 12_000;

const DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT = 95;

export function resolveAutoCompactTokens(
  reportedContextWindow: number,
  modelSlug: string | null
): number {
  if (modelSlug) {
    const fromCache = readEffectiveFromModelsCache(modelSlug);
    if (fromCache !== null) return fromCache;
  }
  // The `model_context_window` value Codex ships in its `token_count`
  // events is already the effective window (upstream computes it as
  // `context_window * effective_context_window_percent / 100` inside
  // `TurnContext::model_context_window`), so we can return it as-is
  // on the fallback path.
  return Math.max(1, reportedContextWindow);
}

function readEffectiveFromModelsCache(modelSlug: string): number | null {
  if (!existsSync(CODEX_MODELS_CACHE_PATH)) return null;

  try {
    const raw = readFileSync(CODEX_MODELS_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        context_window?: number;
        effective_context_window_percent?: number;
      }>;
    };

    const model = parsed.models?.find((entry) => entry.slug === modelSlug);
    if (!model) return null;

    const contextWindow =
      typeof model.context_window === "number" && model.context_window > 0
        ? model.context_window
        : null;
    if (contextWindow === null) return null;

    const effectivePct =
      typeof model.effective_context_window_percent === "number" &&
      model.effective_context_window_percent > 0
        ? model.effective_context_window_percent
        : DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT;

    return Math.floor((contextWindow * effectivePct) / 100);
  } catch {
    return null;
  }
}
