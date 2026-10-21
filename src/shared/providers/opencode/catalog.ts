/**
 * Hardcoded OpenCode Routes instance catalog. Lives in code, not
 * settings, so users never have to hand-edit JSON to pick a model.
 *
 * The local instance's endpoint is supplied at config-build time
 * from the `wat321.localEndpoint` setting (the only
 * piece of instance state worth exposing - whichever LLM you have
 * loaded on that server is what the local instance answers with -
 * swap freely via the LLMs desktop shortcuts and WAT321 follows).
 *
 * Cloud instances are hardcoded since their endpoints + model ids
 * are determined by OpenCode Zen and don't vary per user. All Zen
 * instances share a single API key in SecretStorage.
 */

import { ZEN_API_KEY_SECRET } from "./zenApiKeySecret";

interface CatalogEntry {
  id: string;
  alias: string;
  /** For local instances, this is overridden at config-build time
   * by the user's settings. For cloud instances, this is the canonical
   * Zen endpoint. */
  endpoint: string;
  /** Model id sent in the chat-completion body. Empty string for the
   * local instance because llama.cpp answers with whatever is loaded
   * regardless. */
  model: string;
  kind: "local" | "remote";
  dataRetention: "local" | "retained";
  /** SecretStorage key name. Empty for local instances. */
  apiKeyRef: string;
  /** OpenCode provider id used by the harness on dispatch. Maps to
   * the provider key registered in the WAT321-managed `opencode.json`.
   * Local instances drive the harness via the `llama.cpp` provider -
   * cloud instances drive it via the `zen` provider with a shared API
   * key. The harness needs an explicit provider - auto-discovery only
   * fills in the model id for local entries. */
  harnessProviderID: "llama.cpp" | "zen";
  /** Dispatchable without an API key when true. Free-tier Zen routes
   * (Big Pickle, GPT-5 Nano, etc) hit opencode.ai's
   * `/zen/v1/chat/completions` with no Authorization header and route
   * to a rotating free-model pool with `cost: "0"`. Best-effort free
   * use, not an SLA: SST controls quota per IP and can revoke at any
   * time. When `apiKeyRef` is non-empty AND the user has set a key,
   * the keyed request takes precedence (paid quota, no rate limits). */
  anonymousAccess?: boolean;
  /** Model context window in tokens. Drives the session-tokens widget
   * %-used + Auto-Compact threshold display. OpenCode does not
   * disclose Zen route limits via its `/provider` catalog (it returns
   * `limit.context: 0` for our user-added providers), so the Zen values
   * here come from the models.dev registry OpenCode itself reads. Local
   * LLM is resolved at runtime via llama-server's `/props.n_ctx` since
   * the loaded model decides - the catalog value is a fallback only.
   * Leave undefined when the route's underlying model is unknown - the
   * widget then renders cumulative tokens without a percentage bar. */
  contextWindow?: number;
}

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

export const LOCAL_INSTANCE_ID = "local-llm";

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: LOCAL_INSTANCE_ID,
    alias: "Local LLM",
    endpoint: "", // overridden by wat321.localEndpoint
    model: "",
    kind: "local",
    dataRetention: "local",
    apiKeyRef: "",
    harnessProviderID: "llama.cpp",
    // Fallback only - actual value resolved at runtime from
    // llama-server's `/props.n_ctx`. Mid-range default for the case
    // where the probe fails (server unreachable) so the widget can
    // still render a percentage instead of going blank.
    contextWindow: 32_768,
  },
  {
    id: "big-pickle",
    alias: "Big Pickle",
    endpoint: ZEN_BASE_URL,
    model: "big-pickle",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    // Conservative lower-bound estimate. Big Pickle rotates between
    // multiple frontier models with varying windows, so 200K is the
    // safest assumption that covers common Claude / GPT routes.
    contextWindow: 200_000,
  },
  {
    id: "gpt-5-nano",
    alias: "GPT 5 Nano",
    endpoint: ZEN_BASE_URL,
    model: "gpt-5-nano",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 400_000,
  },
  {
    id: "glm-5-3-flash-free",
    alias: "GLM 5.3 Flash",
    endpoint: ZEN_BASE_URL,
    model: "glm-5.3-flash-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 200_000,
  },
  {
    id: "deepseek-v4-1-flash-free",
    alias: "DeepSeek V4.1 Flash",
    endpoint: ZEN_BASE_URL,
    model: "deepseek-v4.1-flash-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 200_000,
  },
  {
    id: "nemotron-3-5-super-vl-free",
    alias: "Nemotron 3.5 Super VL",
    endpoint: ZEN_BASE_URL,
    model: "nemotron-3.5-super-vl-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 1_048_576,
  },
  {
    id: "minimax-m3-1-flash-free",
    alias: "MiniMax M3.1 Flash",
    endpoint: ZEN_BASE_URL,
    model: "minimax-m3.1-flash-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 1_000_000,
  },
] as const;

/** Aliases of every Zen-routed instance, for the API key prompts. */
/** Routes the catalog has retired, keyed to the route that took over
 * the slot. Saved preferences and session alias bindings migrate
 * through this table at activation. */
export const RETIRED_INSTANCE_IDS: Readonly<Record<string, string>> = {
  "ling-2-6-flash": "glm-5-3-flash-free",
  "hy3-preview-free": "deepseek-v4-1-flash-free",
  "nemotron-3-super-free": "nemotron-3-5-super-vl-free",
  "minimax-m2-5-free": "minimax-m3-1-flash-free",
};

export const ZEN_INSTANCE_ALIASES: readonly string[] = CATALOG.filter(
  (entry) => entry.harnessProviderID === "zen"
).map((entry) => entry.alias);
