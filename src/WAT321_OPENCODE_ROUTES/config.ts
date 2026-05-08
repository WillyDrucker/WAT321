import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { CONFIG_PATH, MODEL_BRIDGE_DIR } from "./constants";
import { CATALOG, LOCAL_INSTANCE_ID } from "../shared/providers/opencode/catalog";
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
 * instances share one SecretStorage-backed API key. Active-instance
 * selection is the only per-task knob in `preferences.json`, driven
 * by the click menu's Active Instance picker.
 *
 * Atomic write ensures `channel.mjs` reading mid-update never sees a
 * torn JSON parse.
 */

export interface OpenCodeRouteInstance {
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
  /** Model context window in tokens, copied from the catalog. The
   * bridge session-tokens poller uses this as the denominator for
   * the %-used display + the Auto-Compact threshold (overflow at
   * `context - reserved_buffer`). Local instances may have this
   * overridden at runtime by llama-server's `/props.n_ctx` probe. */
  contextWindow?: number;
}

export interface OpenCodeRoutesConfig {
  /** Master switch from settings. When false the MCP entry is
   * uninstalled and channel.mjs rejects every tool call. */
  enabled: boolean;

  /** Hardcoded instance catalog with API keys + local endpoint
   * resolved. */
  instances: OpenCodeRouteInstance[];
  /** Resolved active instance id. Defaults to the local instance
   * when the user has not picked one. */
  activeInstanceId: string;

  /** Resolved OpenCode HTTP server URL. Set when the master `enabled`
   * flag is on AND the manager has spawned a live process. Empty
   * otherwise. The bridge bin reads this to decide whether session-
   * attached dispatches can route. */
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
): Promise<OpenCodeRoutesConfig> {
  const cfg = vscode.workspace.getConfiguration("wat321");
  const enabled = cfg.get<boolean>(SETTING.enableOpenCode, false);
  const localEndpoint = cfg
    .get<string>(SETTING.localEndpoint, "")
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

  const instances: OpenCodeRouteInstance[] = filteredCatalog.map((entry) => {
    const endpoint = entry.kind === "local" ? localEndpoint : entry.endpoint;
    const apiKey = entry.apiKeyRef ? resolvedKeys[entry.apiKeyRef] ?? "" : "";
    // Anonymous-access instances (free-tier Zen routes verified to
    // accept no Authorization header) are never "missing" a key -
    // missing key just means they fall through to the free path.
    // Keyed call still wins when a key is present; this only affects
    // the "needs API key" rejection in channel.mjs.
    const apiKeyMissing =
      entry.apiKeyRef.length > 0 &&
      apiKey.length === 0 &&
      !entry.anonymousAccess;
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
      contextWindow: entry.contextWindow,
    };
  });

  const prefs = readPreferences();
  const activeInstanceId = pickActiveInstanceId(instances, prefs.activeInstanceId);

  // Managed OpenCode subprocess URL. Empty when the manager has not
  // (or cannot) spawned one yet, which leaves session-attached
  // dispatches disabled until it does. Managed local is the only
  // harness target supported by this code path.
  const openCodeServerUrl =
    managedOpenCodeUrl.length > 0
      ? managedOpenCodeUrl.replace(/\/+$/, "")
      : "";

  return {
    enabled,
    instances,
    activeInstanceId,
    openCodeServerUrl,
  };
}

/** Resolve the active instance id. Falls back to the local instance
 * when present, otherwise to the first available cloud instance so
 * the bridge can still serve calls when `localEnabled` is off. */
function pickActiveInstanceId(
  instances: OpenCodeRouteInstance[],
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
export function writeConfigFile(config: OpenCodeRoutesConfig): boolean {
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
export function isConfigInstallable(config: OpenCodeRoutesConfig): boolean {
  return config.enabled;
}
