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
  },
  {
    id: "big-pickle",
    alias: "Big Pickle",
    endpoint: ZEN_BASE_URL,
    model: "big-pickle",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
  {
    id: "gpt-5-nano",
    alias: "GPT 5 Nano",
    endpoint: ZEN_BASE_URL,
    model: "gpt-5-nano",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
  {
    id: "ling-2-6-flash",
    alias: "Ling 2.6 Flash",
    endpoint: ZEN_BASE_URL,
    model: "ling-2.6-flash",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
  {
    id: "hy3-preview-free",
    alias: "Hy3 Preview",
    endpoint: ZEN_BASE_URL,
    model: "hy3-preview-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
  {
    id: "nemotron-3-super-free",
    alias: "Nemotron 3 Super",
    endpoint: ZEN_BASE_URL,
    model: "nemotron-3-super-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
  {
    id: "minimax-m2-5-free",
    alias: "MiniMax M2.5",
    endpoint: ZEN_BASE_URL,
    model: "minimax-m2.5-free",
    kind: "remote",
    dataRetention: "retained",
    apiKeyRef: ZEN_API_KEY_SECRET,
  },
] as const;
