import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { CONFIG_PATH, MODEL_BRIDGE_DIR } from "./constants";
import { CATALOG, LOCAL_INSTANCE_ID } from "./instanceCatalog";
import { readPreferences } from "./preferences";
import { resolveApiKeys } from "./secrets";

/**
 * Read VS Code settings + runtime preferences + SecretStorage and
 * atomically write the merged config the MCP server consumes.
 * `channel.mjs` runs in a separate process spawned by Claude Code
 * and cannot reach VS Code; this file is the bridge between the
 * three state surfaces and the MCP server.
 *
 * The instance catalog is hardcoded (`instanceCatalog.ts`); only the
 * local endpoint is user-configurable via settings. All Zen
 * instances share one SecretStorage-backed API key. Per-task tuning
 * (active instance, sampling, system prompt, phased protocol,
 * harness toggle, OpenCode URL) lives in preferences.json driven by
 * the click menu.
 *
 * Atomic write ensures `channel.mjs` reading mid-update never sees a
 * torn JSON parse.
 */

export interface ModelBridgeInstance {
  id: string;
  alias: string;
  endpoint: string;
  model: string;
  kind: "local" | "remote";
  dataRetention: "local" | "retained";
  /** Resolved API key value. Empty when the instance has no
   * `apiKeyRef` or when the referenced secret is not stored. */
  apiKey: string;
  /** True when the instance declares an `apiKeyRef` but the
   * referenced secret is not in SecretStorage. */
  apiKeyMissing: boolean;
  /** The reference name itself, preserved so channel.mjs can name
   * the missing-key error clearly. Empty for local instances. */
  apiKeyRef: string;
  /** OpenCode provider id used by the harness. Mirrors the catalog
   * entry's `harnessProviderID`; `channel.mjs` reads it directly when
   * building `{providerID, modelID}` for `/session/:id/message`. */
  harnessProviderID: "llama.cpp" | "zen";
}

export interface ModelBridgeConfig {
  /** Master switch from settings. When false the MCP entry is
   * uninstalled and channel.mjs rejects every tool call. */
  enabled: boolean;
  /** Toggle for the OpenCode harness (from preferences.json, not
   * settings). When true AND the active instance is local AND the
   * harness URL probe succeeds, `model_bridge_task` is exposed. */
  useOpenCodeHarness: boolean;

  /** Hardcoded instance catalog with API keys + local endpoint
   * resolved. */
  instances: ModelBridgeInstance[];
  /** Resolved active instance id. Defaults to the local instance
   * when the user has not picked one. */
  activeInstanceId: string;

  // Runtime preferences below - all driven by the click menu and
  // persisted in preferences.json.

  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  systemPrompt: string;
  phasedProtocol: "off" | "markers-v1" | "gated-v1" | "auto";
  autoCompactThreshold: number;
  /** Default OpenCode agent for `model_bridge_task` calls when the
   * caller omits an explicit `agent`. */
  defaultAgent: "build" | "explore" | "general" | "plan";
  /** Resolved OpenCode HTTP server URL. Empty when the harness is
   * unavailable - harness toggle off, active instance not local, or
   * URL could not be derived. */
  openCodeServerUrl: string;
}

/** Read settings + preferences + SecretStorage and produce a merged
 * config. Async because SecretStorage reads are async.
 *
 * `managedOpenCodeUrl` is the URL of the WAT321-spawned local
 * `opencode serve` process when the bridge is enabled and the
 * manager has a live process. Empty otherwise. The caller (Model
 * Bridge `index.ts`) owns the manager and passes the URL in,
 * keeping `config.ts` free of subprocess lifecycle concerns. */
export async function readConfigFromSettings(
  context: vscode.ExtensionContext,
  managedOpenCodeUrl = ""
): Promise<ModelBridgeConfig> {
  const cfg = vscode.workspace.getConfiguration("wat321");
  const enabled = cfg.get<boolean>(SETTING.modelBridgeEnabled, false);
  const localEndpoint = cfg
    .get<string>(SETTING.modelBridgeLocalEndpoint, "http://127.0.0.1:8080")
    .trim()
    .replace(/\/+$/, "");
  // Empty localEndpoint means "no local LLM" - the catalog drops the
  // local instance entirely. Any non-empty value enables it. The
  // boolean toggle was redundant: VS Code settings do not have
  // conditional visibility, but empty-string-as-off is cleaner than
  // a separate bool that has to stay in sync.
  const localEnabled = localEndpoint.length > 0;

  const refs = CATALOG.map((c) => c.apiKeyRef).filter((r) => r.length > 0);
  const resolvedKeys = await resolveApiKeys(context, refs);

  // Filter out the local instance entirely when `localEnabled` is
  // off. Users with no llama-server reachable get a clean cloud-only
  // catalog instead of a perpetually-failing entry.
  const filteredCatalog = CATALOG.filter(
    (entry) => entry.kind !== "local" || localEnabled
  );

  const instances: ModelBridgeInstance[] = filteredCatalog.map((entry) => {
    const endpoint = entry.kind === "local" ? localEndpoint : entry.endpoint;
    const apiKey = entry.apiKeyRef ? resolvedKeys[entry.apiKeyRef] ?? "" : "";
    const apiKeyMissing = entry.apiKeyRef.length > 0 && apiKey.length === 0;
    return {
      id: entry.id,
      alias: entry.alias,
      endpoint,
      model: entry.model,
      kind: entry.kind,
      dataRetention: entry.dataRetention,
      apiKey,
      apiKeyMissing,
      apiKeyRef: entry.apiKeyRef,
      harnessProviderID: entry.harnessProviderID,
    };
  });

  const prefs = readPreferences();
  const activeInstanceId = pickActiveInstanceId(instances, prefs.activeInstanceId);

  // Harness URL is the managed local subprocess URL the caller passed
  // in. Empty when the manager has not yet (or cannot) spawn one,
  // which leaves model_bridge_task disabled until it does. The harness
  // is always managed local under the simplified settings shape -
  // external OpenCode is no longer a configurable target.
  const openCodeServerUrl =
    prefs.useOpenCodeHarness && managedOpenCodeUrl.length > 0
      ? managedOpenCodeUrl.replace(/\/+$/, "")
      : "";

  return {
    enabled,
    useOpenCodeHarness: prefs.useOpenCodeHarness,
    instances,
    activeInstanceId,
    temperature: prefs.temperature,
    maxTokens: prefs.maxTokens,
    timeoutSec: prefs.timeoutSec,
    systemPrompt: prefs.systemPrompt,
    phasedProtocol: prefs.phasedProtocol,
    autoCompactThreshold: prefs.autoCompactThreshold,
    defaultAgent: prefs.defaultAgent,
    openCodeServerUrl,
  };
}

/** Resolve the active instance id. Falls back to the local instance
 * when present, otherwise to the first available cloud instance so
 * the bridge can still serve calls when `localEnabled` is off. */
function pickActiveInstanceId(
  instances: ModelBridgeInstance[],
  preferred: string
): string {
  if (preferred.length > 0) {
    const match = instances.find((i) => i.id === preferred);
    if (match) return match.id;
  }
  const localPresent = instances.some((i) => i.id === LOCAL_INSTANCE_ID);
  if (localPresent) return LOCAL_INSTANCE_ID;
  return instances[0]?.id ?? "";
}

/** Atomically persist the merged config to disk so channel.mjs picks
 * it up on its next read. Called both on settings changes and on
 * preferences.json edits via the click menu. */
export function writeConfigFile(config: ModelBridgeConfig): boolean {
  if (!existsSync(MODEL_BRIDGE_DIR)) {
    try {
      mkdirSync(MODEL_BRIDGE_DIR, { recursive: true });
    } catch {
      return false;
    }
  }
  if (!existsSync(dirname(CONFIG_PATH))) {
    try {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    } catch {
      return false;
    }
  }
  return writeFileAtomic(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** The MCP entry only registers when the bridge is enabled. The
 * local instance is always available, so a single `enabled: true`
 * is enough to install. */
export function isConfigInstallable(config: ModelBridgeConfig): boolean {
  return config.enabled;
}
