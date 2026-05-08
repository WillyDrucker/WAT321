import { CATALOG } from "./catalog";

/**
 * `opencode.json` builder for the WAT321-managed harness.
 *
 * Declares both providers (`llama.cpp` for local, `zen` for cloud
 * routes). The Zen API key flows via the `OPENCODE_ZEN_KEY` env so
 * the JSON file is safe to leave on disk - it carries only the
 * substitution placeholder.
 *
 * Zen model blocks are derived from `CATALOG` so context windows stay
 * in lock-step with the widget's source of truth. Output ceilings are
 * layered on top here because they are harness budgeting, not a model
 * fact the widget needs.
 *
 * Local llama.cpp's output ceiling is intentionally unset so reasoning
 * models (Qwen3, DeepSeek R1) have headroom to emit chain-of-thought
 * before tool_calls. A tight output budget pushes them to skip the
 * tool_call entirely and answer from training data instead.
 *
 * When a catalog entry has no `contextWindow` (route with unknown
 * underlying model, e.g. `hy3-preview-free`), the limit block is
 * omitted entirely and OpenCode falls back to its 32K default.
 */

/** Per-Zen-route minimum output budget. Reasoning + tool-call payload
 * both need to fit inside OpenCode's max-tokens send to the provider.
 * The verifier checks running catalog entries against this floor. */
export const ZEN_MODEL_OUTPUT_FLOOR = 8192;

/** Local provider context advertised to opencode.json. Mid-range so
 * auto-compact triggers at a sensible point even when the runtime
 * `/props.n_ctx` probe never lands. The widget overrides this from
 * the live probe; this value only governs the harness's budgeting. */
const LOCAL_CONTEXT_WINDOW = 40960;

export function buildOpenCodeJson(localEndpoint: string): string {
  const zenModels: Record<string, { name: string; limit?: { context: number; output: number } }> = {};
  for (const entry of CATALOG) {
    if (entry.harnessProviderID !== "zen") continue;
    zenModels[entry.model] =
      typeof entry.contextWindow === "number"
        ? {
            name: entry.alias,
            limit: { context: entry.contextWindow, output: ZEN_MODEL_OUTPUT_FLOOR },
          }
        : { name: entry.alias };
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "llama.cpp": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${localEndpoint.replace(/\/+$/, "")}/v1`,
          apiKey: "not-needed",
        },
        // OpenCode rejects any modelID not declared in this map. The
        // local LLM is whatever llama.cpp / Ollama / vLLM has loaded;
        // llama.cpp ignores the request's `model` field entirely so
        // one fixed canonical name suffices and stays correct across
        // server-side model swaps.
        models: {
          local: {
            name: "Local LLM",
            limit: { context: LOCAL_CONTEXT_WINDOW },
          },
        },
      },
      zen: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://opencode.ai/zen/v1",
          apiKey: "{env:OPENCODE_ZEN_KEY}",
        },
        models: zenModels,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Zen routes the verifier checks for explicit output ceilings. Routes
 * without a catalog `contextWindow` (e.g. `hy3-preview-free`) are
 * intentionally absent - the builder skips their `limit` block, so
 * the verifier should not flag the absence either. */
export const ZEN_VERIFIED_MODELS = CATALOG
  .filter((e) => e.harnessProviderID === "zen" && typeof e.contextWindow === "number")
  .map((e) => e.model);
