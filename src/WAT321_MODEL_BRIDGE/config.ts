import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { CONFIG_PATH, MODEL_BRIDGE_DIR } from "./constants";
import { CATALOG, LOCAL_INSTANCE_ID } from "./instanceCatalog";
import { readPreferences, resolveOpenCodeServerUrl } from "./preferences";
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
  phasedProtocol: "off" | "markers-v1";
  autoCompactThreshold: number;
  /** Resolved OpenCode HTTP server URL. Empty when the harness is
   * unavailable - harness toggle off, active instance not local, or
   * URL could not be derived. */
  openCodeServerUrl: string;
}

/** Read settings + preferences + SecretStorage and produce a merged
 * config. Async because SecretStorage reads are async. */
export async function readConfigFromSettings(
  context: vscode.ExtensionContext
): Promise<ModelBridgeConfig> {
  const cfg = vscode.workspace.getConfiguration("wat321");
  const enabled = cfg.get<boolean>(SETTING.modelBridgeEnabled, false);
  const localEndpoint = cfg
    .get<string>(SETTING.modelBridgeLocalEndpoint, "http://10.0.0.91:8080")
    .trim()
    .replace(/\/+$/, "");

  const refs = CATALOG.map((c) => c.apiKeyRef).filter((r) => r.length > 0);
  const resolvedKeys = await resolveApiKeys(context, refs);

  const instances: ModelBridgeInstance[] = CATALOG.map((entry) => {
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
    };
  });

  const prefs = readPreferences();
  const activeInstanceId = pickActiveInstanceId(instances, prefs.activeInstanceId);

  // Harness URL derives from the active instance when it is local.
  // Cloud instances never run the local OpenCode harness.
  const active = instances.find((i) => i.id === activeInstanceId);
  const harnessSourceEndpoint =
    active?.kind === "local" ? active.endpoint : "";
  const openCodeServerUrl =
    prefs.useOpenCodeHarness && harnessSourceEndpoint.length > 0
      ? (resolveOpenCodeServerUrl(prefs, harnessSourceEndpoint) ?? "")
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
    openCodeServerUrl,
  };
}

/** Resolve the active instance id. Falls back to the local instance
 * when the preference is empty or names a removed instance. The
 * local instance is always available (even with no API key) so this
 * never returns "". */
function pickActiveInstanceId(
  instances: ModelBridgeInstance[],
  preferred: string
): string {
  if (preferred.length > 0) {
    const match = instances.find((i) => i.id === preferred);
    if (match) return match.id;
  }
  return LOCAL_INSTANCE_ID;
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
