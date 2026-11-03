import { existsSync, readFileSync } from "node:fs";
import { CODEX_MODELS_CACHE_PATH } from "../shared/providers/codex/codexHome";

/**
 * The Codex session ceiling and auto-compact trigger for the active
 * model, read per slug from `~/.codex/models_cache.json` because the
 * `model/list` RPC carries no context window. Window sizes are OpenAI's
 * to change per model, so neither value is assumed.
 */

/** Codex subtracts this baseline from both numerator and denominator
 * when computing `percent_of_context_window_remaining` (see
 * `codex-rs/protocol/src/protocol.rs`). Accounts for prompts, tools,
 * and space to call compact. Shared by the widget and tooltip. */
export const CODEX_BASELINE_TOKENS = 12_000;

/** Share of the raw window Codex treats as usable when the cache
 * names no `effective_context_window_percent`. */
const DEFAULT_EFFECTIVE_CONTEXT_PCT = 95;

/** Codex fires auto-compact at this share of the raw window, ahead of
 * the usable ceiling. A `model_auto_compact_token_limit` in
 * `config.toml` can lower it, and WAT321 never reads that file. */
const AUTO_COMPACT_PCT = 90;

/** `ceilingTokens` is the usable window Codex's own hover shows, the
 * widget's denominator. `autoCompactEffectiveTokens` is where
 * auto-compact fires, ahead of it. */
export interface CodexCompactLimits {
  ceilingTokens: number;
  autoCompactEffectiveTokens: number;
}

export function resolveCompactLimits(
  reportedContextWindow: number,
  modelSlug: string | null
): CodexCompactLimits {
  const model = modelSlug ? readModelWindow(modelSlug) : null;
  if (model) {
    return {
      ceilingTokens: Math.floor((model.contextWindow * model.effectivePct) / 100),
      autoCompactEffectiveTokens: Math.floor(
        (model.contextWindow * AUTO_COMPACT_PCT) / 100
      ),
    };
  }
  // The rollout's `model_context_window` is already the usable window
  // (upstream applies the effective percent before reporting it), so it
  // stands in as the ceiling and the trigger scales back from it.
  const ceilingTokens = Math.max(1, reportedContextWindow);
  return {
    ceilingTokens,
    autoCompactEffectiveTokens: Math.floor(
      (ceilingTokens * AUTO_COMPACT_PCT) / DEFAULT_EFFECTIVE_CONTEXT_PCT
    ),
  };
}

/** The slug's raw `context_window` and effective percent, or null when
 * the cache lacks the slug (another codex binary overwrote it). The
 * cache's `max_context_window` is a different ceiling and is not read. */
function readModelWindow(
  modelSlug: string
): { contextWindow: number; effectivePct: number } | null {
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
    if (typeof model.context_window !== "number" || model.context_window <= 0) {
      return null;
    }

    const effectivePct =
      typeof model.effective_context_window_percent === "number" &&
      model.effective_context_window_percent > 0
        ? model.effective_context_window_percent
        : DEFAULT_EFFECTIVE_CONTEXT_PCT;

    return { contextWindow: model.context_window, effectivePct };
  } catch {
    return null;
  }
}
