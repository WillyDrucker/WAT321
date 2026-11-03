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
  /** A free route, dispatchable without an API key. OpenCode serves
   * free models keyless only to its own client, so a direct keyless
   * call from outside a session can hit the free-usage limit. A key,
   * when set, takes precedence. */
  anonymousAccess?: boolean;
  /** Context window in tokens, for the session-tokens percentage and
   * Auto-Compact line. Zen values are `limit.context` from the Zen
   * model list, since `opencode serve` reports 0 for user-added
   * providers. The local value only backs up llama-server's
   * `/props.n_ctx`. Undefined renders tokens without a percentage. */
  contextWindow?: number;
}

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

export const LOCAL_INSTANCE_ID = "local-llm";

/** The Zen route a remote dispatch or a new remote session falls back
 * to when no remote instance is configured or active. */
export const DEFAULT_ZEN_ROUTE: CatalogEntry = {
  id: "big-pickle",
  alias: "Big Pickle",
  endpoint: ZEN_BASE_URL,
  model: "big-pickle",
  kind: "remote",
  dataRetention: "retained",
  apiKeyRef: ZEN_API_KEY_SECRET,
  harnessProviderID: "zen",
  anonymousAccess: true,
  contextWindow: 200_000,
};

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
  DEFAULT_ZEN_ROUTE,
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
    id: "nemotron-3-5-lightning-free",
    alias: "Nemotron 3.5 Lightning",
    endpoint: ZEN_BASE_URL,
    model: "nemotron-3.5-lightning-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 262_144,
  },
  {
    id: "beam-free",
    alias: "Beam",
    endpoint: ZEN_BASE_URL,
    model: "beam-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 1_048_576,
  },
  {
    id: "flint-40b-free",
    alias: "Flint 40B",
    endpoint: ZEN_BASE_URL,
    model: "flint-40b-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 262_144,
  },
  {
    id: "mimo-v2-6-flash-free",
    alias: "MiMo V2.6 Flash",
    endpoint: ZEN_BASE_URL,
    model: "mimo-v2.6-flash-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 200_000,
  },
  {
    id: "pulse-alpha-free",
    alias: "Pulse Alpha",
    endpoint: ZEN_BASE_URL,
    model: "pulse-alpha-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
    contextWindow: 1_048_576,
  },
] as const;

/** Routes the catalog has retired, keyed to the live route that took
 * over the slot, or the default route when the family has no free
 * successor. Saved preferences and session alias bindings migrate
 * through this table once at activation, so every value is a live id. */
export const RETIRED_INSTANCE_IDS: Readonly<Record<string, string>> = {
  "ling-2-6-flash": "glm-5-3-flash-free",
  "hy3-preview-free": "deepseek-v4-1-flash-free",
  "nemotron-3-super-free": "nemotron-3-5-super-vl-free",
  "minimax-m2-5-free": DEFAULT_ZEN_ROUTE.id,
  "minimax-m3-1-flash-free": DEFAULT_ZEN_ROUTE.id,
  "gpt-5-nano": DEFAULT_ZEN_ROUTE.id,
};

/** Aliases of every Zen-routed instance, for the API key prompts. */
export const ZEN_INSTANCE_ALIASES: readonly string[] = CATALOG.filter(
  (entry) => entry.harnessProviderID === "zen"
).map((entry) => entry.alias);
