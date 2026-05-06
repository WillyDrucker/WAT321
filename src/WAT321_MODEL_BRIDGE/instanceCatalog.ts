/**
 * Hardcoded Model Bridge instance catalog. Lives in code, not
 * settings, so users never have to hand-edit JSON to pick a model.
 *
 * The local instance's endpoint is supplied at config-build time
 * from the `wat321.modelBridge.localEndpoint` setting (the only
 * piece of instance state worth exposing - whichever LLM you have
 * loaded on that server is what the local instance answers with;
 * swap freely via the LLMs desktop shortcuts and WAT321 follows).
 *
 * Cloud instances are hardcoded since their endpoints + model ids
 * are determined by OpenCode Zen and don't vary per user. All Zen
 * instances share a single API key in SecretStorage.
 */

import { ZEN_API_KEY_SECRET } from "./secrets";

export interface CatalogEntry {
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
  /** OpenCode provider id used by the harness (`model_bridge_task`).
   * Maps to the provider key registered in the WAT321-managed
   * `opencode.json`. Local instances drive the harness via the
   * `llama.cpp` provider; cloud instances drive it via the `zen`
   * provider with a shared API key. The harness needs an explicit
   * provider; auto-discovery only fills in the model id for local
   * entries. */
  harnessProviderID: "llama.cpp" | "zen";
  /** When true, the instance is dispatchable without an API key.
   * Used by free-tier OpenCode Zen routes (Big Pickle, GPT-5 Nano,
   * etc) - opencode.ai's `/zen/v1/chat/completions` endpoint accepts
   * anonymous requests with no Authorization header and routes them
   * to a rotating free-model pool with `cost: "0"`. Verified via
   * curl probe against the live endpoint on 2026-05-06. SST controls
   * quota per IP and can revoke at will - so this is best-effort
   * free use, not an SLA. When `apiKeyRef` is non-empty AND the user
   * has set a key, the keyed request takes precedence (paid quota,
   * no rate limits). */
  anonymousAccess?: boolean;
}

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

export const LOCAL_INSTANCE_ID = "local-llm";

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: LOCAL_INSTANCE_ID,
    alias: "Local LLM",
    endpoint: "", // overridden by wat321.modelBridge.localEndpoint
    model: "",
    kind: "local",
    dataRetention: "local",
    apiKeyRef: "",
    harnessProviderID: "llama.cpp",
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
  },
  {
    id: "ling-2-6-flash",
    alias: "Ling 2.6 Flash",
    endpoint: ZEN_BASE_URL,
    model: "ling-2.6-flash",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
  },
  {
    id: "hy3-preview-free",
    alias: "Hy3 Preview",
    endpoint: ZEN_BASE_URL,
    model: "hy3-preview-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
  },
  {
    id: "nemotron-3-super-free",
    alias: "Nemotron 3 Super",
    endpoint: ZEN_BASE_URL,
    model: "nemotron-3-super-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
  },
  {
    id: "minimax-m2-5-free",
    alias: "MiniMax M2.5",
    endpoint: ZEN_BASE_URL,
    model: "minimax-m2.5-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
    harnessProviderID: "zen",
    anonymousAccess: true,
  },
] as const;
