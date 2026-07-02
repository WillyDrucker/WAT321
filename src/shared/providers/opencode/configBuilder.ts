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
 * Local llama.cpp's `limit` block is omitted entirely so reasoning
 * models (Qwen3, DeepSeek R1) have headroom to emit chain-of-thought
 * before tool_calls. OpenCode's schema rejects a partial limit block
 * (recent OpenCode releases require both `context` and `output` when `limit` is
 * present), so the choice is "both fields" or "no block at all" -
 * the latter lets OpenCode's 32K fallback apply, which matches what
 * the widget already shows for the local route.
 *
 * When a catalog entry has no `contextWindow` (route with unknown
 * underlying model, e.g. `hy3-preview-free`), the limit block is
 * omitted entirely and OpenCode falls back to its 32K default.
 */

/** Per-Zen-route minimum output budget. Reasoning + tool-call payload
 * both need to fit inside OpenCode's max-tokens send to the provider.
 * The verifier checks running catalog entries against this floor. */
export const ZEN_MODEL_OUTPUT_FLOOR = 8192;

/** Agent name dispatched against on every WAT321 bridge call.
 * Replaces OpenCode's default `build` (coding-assistant) framing with
 * a research-assistant framing that only exposes `webfetch`. Same
 * agent serves Local LLM and Zen routes. */
export const WAT321_RESEARCH_AGENT = "wat321-research";

const RESEARCH_AGENT_PROMPT =
  "You are a research assistant answering general questions for the user. " +
  "Your only tool is `webfetch` (fetch the contents of a URL).\n\n" +
  "POLICY:\n" +
  "When the question matches ANY of these patterns, call webfetch BEFORE answering from training data:\n" +
  "- contains 'right now', 'currently', 'today', 'this week', 'this month', 'this year', 'recent', 'latest'\n" +
  "- asks 'who is the best', 'what is the best', 'top X', 'most popular', 'leaderboard', 'ranking'\n" +
  "- names a specific living person, team, game, product, or service whose status changes over time\n" +
  "- asks about prices, scores, standings, releases, versions, news, or events\n" +
  "- asks for an opinion or recommendation that depends on current state\n" +
  "- the user names a specific website (Cars.com, Steam, IMDb, Wikipedia, Reddit, GitHub, etc.)\n\n" +
  "URL CONSTRUCTION HINTS (use these patterns when no exact URL is given; they are not exhaustive, infer similar shapes for other sites):\n" +
  "- Wikipedia: https://en.wikipedia.org/wiki/<Topic_With_Underscores>\n" +
  "- Cars.com search: https://www.cars.com/shopping/results/?makes[]=<make>&models[]=<make>-<model>&sort=list_price\n" +
  "- Steam store: https://store.steampowered.com/app/<id>/<slug>/  (use search if id unknown: https://store.steampowered.com/search/?term=<query>)\n" +
  "- IMDb title: https://www.imdb.com/find/?q=<query>\n" +
  "- Reddit search: https://www.reddit.com/search/?q=<query>\n" +
  "- GitHub repo: https://github.com/<owner>/<repo>  (search: https://github.com/search?q=<query>&type=repositories)\n" +
  "- Generic search fallback if no domain fits: https://duckduckgo.com/html/?q=<query>\n\n" +
  "PROCEDURE:\n" +
  "1. Pick the most specific URL pattern that fits the question. Encode spaces as `+` or `_` per the pattern.\n" +
  "2. Call webfetch with that URL.\n" +
  "3. If the fetch fails, returns an error page, or contains nothing relevant, try ONE alternative URL (e.g. swap the search query, use the duckduckgo fallback).\n" +
  "4. Synthesize the answer from the fetched content. Quote specifics (prices, dates, names) directly from the page when possible.\n" +
  "5. Only after BOTH attempts fail may you fall back to training data, and you MUST tell the user the data could be stale and what URLs you tried.\n\n" +
  "DO NOT confabulate that you 'checked the website' or 'looked up the leaderboard' if you have not actually called webfetch in this turn. Either call the tool, or be explicit that you didn't and answer from training with a caveat.\n\n" +
  "DO NOT refuse webfetch citing 'I cannot access live data' or 'I don't have real-time tools' - you literally have webfetch, use it.\n\n" +
  "Skip webfetch only for questions answerable from stable general knowledge (math, definitions, well-established history, code logic).";

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
        // local LLM is whatever llama.cpp / Ollama / vLLM has loaded -
        // llama.cpp ignores the request's `model` field entirely so
        // one fixed canonical name suffices and stays correct across
        // server-side model swaps.
        models: {
          local: {
            name: "Local LLM",
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
    agent: {
      [WAT321_RESEARCH_AGENT]: {
        mode: "primary",
        prompt: RESEARCH_AGENT_PROMPT,
        // Default-deny + explicit webfetch allow. OpenCode's `tools`
        // map shape is deprecated in favor of `permission` - this also
        // future-proofs against new tools OpenCode adds upstream
        // (a wildcard deny keeps newcomers off by default rather than
        // auto-allowing whatever ships next).
        permission: {
          "*": "deny",
          webfetch: "allow",
        },
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
