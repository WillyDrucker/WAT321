import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolves Codex's actual auto-compact token ceiling for the active
 * model. Upstream Codex core derives this from model metadata as 90%
 * of the model context window, NOT 100% of the effective window
 * reported in `token_count` events.
 */

const DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT = 95;
const DEFAULT_CODEX_AUTO_COMPACT_PCT = 90;

/** Resolve the auto-compact ceiling in tokens. Prefers
 * `~/.codex/models_cache.json` metadata when available. Falls back to
 * a heuristic that multiplies the reported effective context window by
 * `auto_compact_pct / effective_context_pct` when the models cache is
 * unavailable or does not know the active model. */
export function resolveAutoCompactTokens(
  reportedContextWindow: number,
  modelSlug: string | null
): number {
  const fallback = heuristicFallback(reportedContextWindow);
  if (!modelSlug) return fallback;

  const modelsCachePath = join(homedir(), ".codex", "models_cache.json");
  if (!existsSync(modelsCachePath)) return fallback;

  try {
    const raw = readFileSync(modelsCachePath, "utf8");
    const parsed = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        context_window?: number;
        auto_compact_token_limit?: number;
      }>;
    };

    const model = parsed.models?.find((entry) => entry.slug === modelSlug);
    if (!model) return fallback;

    const contextWindow =
      typeof model.context_window === "number" && model.context_window > 0
        ? model.context_window
        : null;
    const configuredLimit =
      typeof model.auto_compact_token_limit === "number" &&
      model.auto_compact_token_limit > 0
        ? model.auto_compact_token_limit
        : null;

    if (contextWindow !== null) {
      const defaultLimit = Math.floor(
        contextWindow * (DEFAULT_CODEX_AUTO_COMPACT_PCT / 100)
      );
      return configuredLimit === null
        ? defaultLimit
        : Math.min(configuredLimit, defaultLimit);
    }

    return configuredLimit ?? fallback;
  } catch {
    return fallback;
  }
}

function heuristicFallback(reportedContextWindow: number): number {
  return Math.max(
    1,
    Math.min(
      reportedContextWindow,
      Math.floor(
        reportedContextWindow *
          (DEFAULT_CODEX_AUTO_COMPACT_PCT / DEFAULT_CODEX_EFFECTIVE_CONTEXT_PCT)
      )
    )
  );
}
