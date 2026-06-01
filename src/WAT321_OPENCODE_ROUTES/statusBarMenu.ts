import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import { readConfigFromSettings, type OpenCodeRouteInstance } from "./config";
import { USAGE_PATH } from "./constants";
import { makeCancelItem, makePauseResumeItem, makeSeparator } from "./menuCommon";
import type { OpenCodeRoutesLogger } from "./outputChannel";
import { isPaused, setPaused, writeCancelFlag } from "./runtimeFlags";
import { showOpenCodeRoutesSessions } from "./sessionsMenu";
import {
  pickActiveInstance,
  resetSessionTotals,
  testConnection,
} from "./statusBarMenuActions";
import { zenKeyMenu } from "./zenKeyMenu";

/**
 * Click-menu surface for the OpenCode Routes widget. Layout follows the
 * Epic Handshake convention so users learning one menu carry the
 * vocabulary to the other:
 *
 *   - Structured rows for the read-only state surfaces (Active
 *     Instance, KV Cache for local instances)
 *   - Action rows: Manage OpenCode Sessions, Reset Session Totals,
 *     Test Connection, Open Output Channel, OpenCode Zen API Key
 *   - 🔵 BACK at the top of every submenu
 *   - 🟡 PAUSE / 🟢 RESUME and 🔴 CANCEL at the bottom of every menu
 *
 * Settings.json carries the master `enabled` flag plus the local
 * endpoint URL. The instance catalog is hardcoded; active-instance
 * selection is the only per-task knob, persisted in preferences.json.
 * Pause/Cancel are flag files under the per-client
 * `~/.wat321/clients/<wsId>/model-bridge/` directory that `channel.mjs`
 * observes per call.
 *
 * Action handlers (pickActiveInstance, testConnection,
 * resetSessionTotals) live in `statusBarMenuActions.ts` symmetric with
 * EH's actions file. Sessions submenu lives in `sessionsMenu.ts`; the
 * Zen API key picker lives in `zenKeyMenu.ts`.
 */

/** llama-server's `/props` endpoint reports the server's actual
 * `n_ctx`. The click menu surfaces it as a read-only row so users
 * can see what KV cache size the local LLM is running with without
 * having to SSH in and read the launcher script. Mutation requires
 * a server restart, so the row is informational only.
 *
 * Cached for 30s per endpoint so a flurry of menu opens does not
 * pound /props. The cache invalidates after the TTL; if the user
 * restarts the server with a different `-c`, the next menu open
 * after the TTL picks up the new value. */
const N_CTX_CACHE_TTL_MS = 30_000;
const nCtxCache = new Map<string, { at: number; nCtx: number | null }>();

async function probeLocalNCtx(endpoint: string): Promise<number | null> {
  const cached = nCtxCache.get(endpoint);
  if (cached && Date.now() - cached.at < N_CTX_CACHE_TTL_MS) return cached.nCtx;
  let nCtx: number | null = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/props`, {
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = (await res.json()) as {
        default_generation_settings?: { n_ctx?: number; n_ctx_train?: number };
        n_ctx?: number;
      };
      const n =
        j?.default_generation_settings?.n_ctx ??
        j?.default_generation_settings?.n_ctx_train ??
        j?.n_ctx ??
        null;
      if (typeof n === "number" && n > 0) nCtx = n;
    }
  } catch {
    // probe failure falls back to "(unknown)"
  }
  nCtxCache.set(endpoint, { at: Date.now(), nCtx });
  return nCtx;
}

function formatKvCache(nCtx: number | null): string {
  if (nCtx === null) return "(unknown)";
  if (nCtx >= 1024) return `${Math.round(nCtx / 1024)}K`;
  return String(nCtx);
}

function retentionLabel(instance: OpenCodeRouteInstance): string {
  return instance.dataRetention === "retained" ? "retained" : "local";
}

interface UsageSummary {
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
}

function readUsageSummary(): UsageSummary | null {
  if (!existsSync(USAGE_PATH)) return null;
  try {
    const raw = readFileSync(USAGE_PATH, "utf8");
    const data = JSON.parse(raw) as {
      instances?: Record<string, { input?: number; output?: number; calls?: number }>;
    };
    const instances = Object.values(data.instances ?? {});
    return {
      totalCalls: instances.reduce((a, b) => a + (b.calls ?? 0), 0),
      totalInput: instances.reduce((a, b) => a + (b.input ?? 0), 0),
      totalOutput: instances.reduce((a, b) => a + (b.output ?? 0), 0),
    };
  } catch {
    return null;
  }
}

export { pickActiveInstance, showOpenCodeRoutesSessions };

export async function showOpenCodeRoutesMenu(
  context: vscode.ExtensionContext,
  logger: OpenCodeRoutesLogger
): Promise<void> {
  const config = await readConfigFromSettings(context);
  const active = config.instances.find((i) => i.id === config.activeInstanceId);
  const usage = readUsageSummary();
  const paused = isPaused();

  // Probe llama-server's /props for the active local instance so the
  // menu can surface its actual `n_ctx`. The probe has a tight 1.5s
  // ceiling and a 30s cache; if the server is unreachable the row
  // falls back to "(unknown)" instead of blocking the menu open.
  const localKvNCtx =
    active?.kind === "local"
      ? await probeLocalNCtx(active.endpoint)
      : null;

  const activeSummary = active
    ? `${active.alias} (${active.kind} - ${retentionLabel(active)})`
    : "(none picked)";

  const usageDescription = usage && usage.totalCalls > 0
    ? `${usage.totalInput.toLocaleString()} in / ${usage.totalOutput.toLocaleString()} out · ${usage.totalCalls} call${usage.totalCalls === 1 ? "" : "s"}`
    : "no calls yet";

  const items: vscode.QuickPickItem[] = [
    {
      label: "$(target) Active Instance",
      description: activeSummary,
      detail: "Pick the local LLM, Big Pickle, or any other Zen route",
    },
    ...(active?.kind === "local"
      ? [{
          label: "$(database) KV Cache",
          description: `${formatKvCache(localKvNCtx)} (read-only)`,
          detail: "n_ctx reported by llama-server's /props endpoint. Mutation requires a server restart - edit the launcher script and re-Start LLM.",
        }]
      : []),
    makeSeparator(),
    {
      label: "$(list-tree) Manage OpenCode Sessions",
      description: "List or erase rollouts",
    },
    {
      label: "$(graph) Reset Session Totals",
      description: usageDescription,
      detail: "Zero the per-instance token + call counters",
    },
    {
      label: "$(plug) Test Connection",
      description: active ? `Probe ${active.alias} /v1/models` : "(no active instance)",
    },
    { label: "$(output) Open Output Channel", description: "WAT321: OpenCode Routes log" },
    makeSeparator(),
    {
      label: "$(key) OpenCode Zen API Key",
      description: "Set / update / clear the shared Zen secret",
    },
    makeSeparator(),
    makePauseResumeItem(paused),
    makeCancelItem(),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: paused ? "OpenCode Routes (paused)" : "OpenCode Routes",
    placeHolder: paused ? "Paused - new tool calls refused until you Resume" : "Pick an action",
  });
  if (!pick) return;

  if (pick.label === "🟡 PAUSE") {
    setPaused(true);
    void vscode.window.showInformationMessage("OpenCode Routes paused. New tool calls will be refused until you Resume.");
    return;
  }
  if (pick.label === "🟢 RESUME") {
    setPaused(false);
    void vscode.window.showInformationMessage("OpenCode Routes resumed.");
    return;
  }
  if (pick.label === "🔴 CANCEL") {
    writeCancelFlag();
    void vscode.window.showInformationMessage("OpenCode Routes: cancel requested. The in-flight call will abort.");
    return;
  }

  if (pick.label.includes("Active Instance")) { await pickActiveInstance(context); return; }
  if (pick.label.includes("Open Output")) { logger.show(); return; }
  if (pick.label.includes("Test Connection")) { await testConnection(context, logger); return; }
  if (pick.label.includes("Manage OpenCode Sessions")) { await showOpenCodeRoutesSessions(); return; }
  if (pick.label.includes("Reset Session Totals")) { await resetSessionTotals(); return; }
  if (pick.label.includes("OpenCode Zen API Key")) { await zenKeyMenu(context); return; }
}
