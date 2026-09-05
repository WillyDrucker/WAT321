import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the Codex session token ceiling that matches Codex's own
 * native hover display. Upstream Codex computes this as
 *
 *   context_window * effective_context_window_percent / 100
 *
 * which for a `context_window = 272000` model at
 * `effective_context_window_percent = 95` works out to 258,400. Window
 * sizes are OpenAI's to change per model and over time (one 5.6 slug
 * has reported both 372000 and 272000 across releases), so both values
 * are always read per slug rather than assumed. The cache's newer
 * `max_context_window` is a different ceiling and is not what Codex's
 * own hover measures against.
 * This is the "usable input budget" - the raw context window minus
 * reserved headroom for system prompts, tool schemas, and model
 * output. It is NOT the same as the literal compact trigger, which
 * upstream fires at `context_window * 0.9 = 244,800`. The session
 * token widget warns near the compact trigger via its own 80 / 85
 * threshold rule in `getSessionTokenColor`, so the ceiling we return
 * here is purely the display denominator and should match Codex
 * native byte-for-byte.
 *
 * Preferred source is `~/.codex/models_cache.json` for the active
 * model slug, which carries the authoritative `context_window` and
 * `effective_context_window_percent` fields. Falls back to the
 * reported context window value from the rollout's `token_count`
 * event, which upstream already exposes as the effective window
 * (so no further math is needed on the fallback path).
 *
 * This is the one Codex model fact that CANNOT move onto the live
 * `model/list` catalog in `shared/providers/codex/modelCatalog.ts`:
 * the RPC carries no `context_window` field at all (verified against
 * codex-cli 0.142.5, 0.144.x, and 0.153.x). Reading the shared cache
 * file here is therefore deliberate, not an oversight.
 *
 * It degrades safely. When another codex binary overwrites that file
 * with a catalog lacking the active slug, the lookup misses and we
 * return the rollout's reported window, which is already the effective
 * value. So a clobbered cache costs us nothing on this path.
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
  const modelsCachePath = join(homedir(), ".codex", "models_cache.json");
  if (!existsSync(modelsCachePath)) return null;

  try {
    const raw = readFileSync(modelsCachePath, "utf8");
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
