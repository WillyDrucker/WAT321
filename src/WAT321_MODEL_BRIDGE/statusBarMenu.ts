import { existsSync, readFileSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import {
  type ModelBridgeInstance,
  readConfigFromSettings,
} from "./config";
import { USAGE_PATH } from "./constants";
import { isPaused, setPaused, writeCancelFlag } from "./runtimeFlags";
import { makeBackItem, makeCancelItem, makePauseResumeItem, makeSeparator } from "./menuCommon";
import { showModelBridgeSessions } from "./modelBridgeSessionsMenu";
import {
  harnessMenu,
  pickAutoCompact,
  pickDefaultAgent,
  pickPhasedProtocol,
  samplingMenu,
  zenKeyMenu,
} from "./modelBridgeSubMenus";
import type { ModelBridgeLogger } from "./outputChannel";
import { readPreferences } from "./preferences";
import { promptAndStoreZenApiKey } from "./secrets";

/**
 * Click-menu surface for the Model Bridge widget. Layout follows the
 * Epic Handshake convention so users learning one menu carry the
 * vocabulary to the other:
 *
 *   - Structured rows for state and configuration (Active Instance,
 *     Phased Protocol, Auto-Compact, Sampling, etc.)
 *   - Submenus for grouped actions (Manage Sessions, Sampling Config,
 *     Harness, Zen API Key)
 *   - 🔵 BACK at the top of every submenu
 *   - 🟡 PAUSE / 🟢 RESUME and 🔴 CANCEL at the bottom of every menu
 *
 * Settings.json carries instance identity (`instances[]`) and tier-
 * wide flags (`enabled`, `useOpenCodeHarness`). Everything tunable
 * per task lives in preferences.json and is reachable from this
 * menu. Pause/Cancel are flag files under `~/.wat321/model-bridge/`
 * that `channel.mjs` observes per call.
 *
 * Sessions submenu lives in `modelBridgeSessionsMenu.ts`; per-setting
 * pickers (sampling, harness, zen key, agent, phased protocol) live in
 * `modelBridgeSubMenus.ts`.
 */

/** llama-server's `/props` endpoint reports the server's actual
 * `n_ctx`. The click menu surfaces it as a read-only row so users
 * can see what KV cache size the local LLM is running with without
 * having to SSH in and read the launcher script. Mutation needs a
 * server restart and is deferred to a future lifecycle slice.
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
    // probe failure is non-fatal - row falls back to "(unknown)"
  }
  nCtxCache.set(endpoint, { at: Date.now(), nCtx });
  return nCtx;
}

function formatKvCache(nCtx: number | null): string {
  if (nCtx === null) return "(unknown)";
  if (nCtx >= 1024) return `${Math.round(nCtx / 1024)}K`;
  return String(nCtx);
}

function retentionLabel(instance: ModelBridgeInstance): string {
  return instance.dataRetention === "retained" ? "retained" : "local";
}

interface UsageSummary {
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  perInstance: Array<{ id: string; input: number; output: number; calls: number }>;
}

function readUsageSummary(): UsageSummary | null {
  if (!existsSync(USAGE_PATH)) return null;
  try {
    const raw = readFileSync(USAGE_PATH, "utf8");
    const data = JSON.parse(raw) as {
      instances?: Record<string, { input?: number; output?: number; calls?: number }>;
    };
    const instances = data.instances ?? {};
    const perInstance = Object.entries(instances).map(([id, u]) => ({
      id,
      input: u.input ?? 0,
      output: u.output ?? 0,
      calls: u.calls ?? 0,
    }));
    return {
      totalCalls: perInstance.reduce((a, b) => a + b.calls, 0),
      totalInput: perInstance.reduce((a, b) => a + b.input, 0),
      totalOutput: perInstance.reduce((a, b) => a + b.output, 0),
      perInstance,
    };
  } catch {
    return null;
  }
}

async function resetSessionTotals(): Promise<void> {
  if (!existsSync(USAGE_PATH)) {
    void vscode.window.showInformationMessage("Model Bridge: session totals are already empty.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "Reset Model Bridge session totals? This zeroes the per-instance token + call counters surfaced in the widget tooltip.",
    { modal: true },
    "Reset"
  );
  if (confirm !== "Reset") return;
  try {
    unlinkSync(USAGE_PATH);
    void vscode.window.showInformationMessage("Model Bridge: session totals reset.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Model Bridge: reset failed - ${msg}`);
  }
}

export async function pickActiveInstance(
  context: vscode.ExtensionContext,
  kindFilter?: "remote" | "local"
): Promise<void> {
  const config = await readConfigFromSettings(context);

  // Optional kind filter for cross-tier dispatch from the EH session
  // pickers. The OpenCode session manager's MODEL row passes "remote"
  // so Local LLM doesn't appear (Local LLM has its own session-
  // management submenu and its own active-instance picker entry).
  // The standalone palette command passes nothing, showing all kinds.
  const visibleInstances = kindFilter
    ? config.instances.filter((i) => i.kind === kindFilter)
    : config.instances;

  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused);
  const cancelItem = makeCancelItem();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    ...visibleInstances.map((inst) => {
      const check = inst.id === config.activeInstanceId ? "✔️ " : "";
      const status =
        inst.kind === "remote" && inst.apiKeyMissing
          ? "needs Zen API key"
          : `${inst.kind} - ${retentionLabel(inst)}`;
      return {
        label: `${check}${inst.alias}`,
        description: status,
        detail: `${inst.endpoint}${inst.model ? `  ·  model=${inst.model}` : ""}`,
      };
    }),
    pauseItem,
    cancelItem,
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Active Model Bridge instance",
    placeHolder: "Pick which instance handles tool calls by default",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (pick.label === pauseItem.label) {
    setPaused(pauseItem.action !== "resume");
    return;
  }
  if (pick.label === cancelItem.label) {
    writeCancelFlag();
    return;
  }
  const stripped = pick.label.replace(/^✔️ /, "");
  const found = config.instances.find((i) => i.alias === stripped);
  if (!found) return;

  const { updatePreference } = await import("./preferences");
  updatePreference("activeInstanceId", found.id);

  if (found.kind === "remote" && found.apiKeyMissing) {
    const stored = await promptAndStoreZenApiKey(context);
    if (!stored) {
      void vscode.window.showWarningMessage(
        `Model Bridge: '${found.alias}' is set as active but still needs an API key. Use 'OpenCode Zen API Key' from the menu when ready.`
      );
      return;
    }
    return;
  }

  void vscode.window.showInformationMessage(
    `Model Bridge: active instance set to ${found.alias}.`
  );
}

async function testConnection(
  context: vscode.ExtensionContext,
  logger: ModelBridgeLogger
): Promise<void> {
  const config = await readConfigFromSettings(context);
  const active = config.instances.find((i) => i.id === config.activeInstanceId);
  if (!active) {
    void vscode.window.showWarningMessage(
      "Model Bridge: no active instance to test. Pick one via Active Instance."
    );
    return;
  }
  if (active.kind === "remote" && active.apiKeyMissing) {
    void vscode.window.showWarningMessage(
      `Model Bridge: '${active.alias}' needs an API key. Use 'Set Zen API Key'.`
    );
    return;
  }

  const url = `${active.endpoint.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = {};
  if (active.kind === "remote" && active.apiKey) {
    headers.Authorization = `Bearer ${active.apiKey}`;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    if (!res.ok) {
      logger.warn(`Test connection: ${url} -> HTTP ${res.status} in ${elapsed}ms`);
      void vscode.window.showWarningMessage(
        `Model Bridge: '${active.alias}' returned HTTP ${res.status} (${elapsed}ms).`
      );
      return;
    }
    let modelName = "(unknown)";
    try {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      if (json?.data?.[0]?.id) modelName = json.data[0].id;
    } catch {
      // body parse optional
    }
    logger.info(`Test connection: ${url} -> 200 in ${elapsed}ms, model=${modelName}`);
    void vscode.window.showInformationMessage(
      `Model Bridge: '${active.alias}' reachable, ${modelName} (${elapsed}ms).`
    );
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Test connection: ${url} -> ${msg}`);
    void vscode.window.showErrorMessage(`Model Bridge: ${active.alias} - ${msg}`);
  }
}

export { showModelBridgeSessions };

export async function showModelBridgeMenu(
  context: vscode.ExtensionContext,
  logger: ModelBridgeLogger
): Promise<void> {
  const config = await readConfigFromSettings(context);
  const prefs = readPreferences();
  const harnessOn = prefs.useOpenCodeHarness;
  const phasedSummary = prefs.phasedProtocol === "off" ? "off" : prefs.phasedProtocol;
  const compactSummary = `${Math.round(prefs.autoCompactThreshold * 100)}%`;
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
    {
      label: "$(beaker) Phased Protocol",
      description: phasedSummary,
      detail: "Marker scaffolding that walks small models through reasoning phases",
    },
    {
      label: "$(zap) Auto-Compact",
      description: compactSummary,
      detail: "Fraction of n_ctx at which the legacy harness rolls a compact summary",
    },
    {
      label: "$(symbol-property) Sampling",
      description: `T ${prefs.temperature.toFixed(1)} · ${prefs.maxTokens.toLocaleString()} max · ${prefs.timeoutSec}s`,
      detail: "Temperature, max tokens, timeout, system prompt",
    },
    {
      label: "$(person) Default Agent",
      description: prefs.defaultAgent,
      detail: "Default OpenCode agent for harness calls when the caller omits agent",
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
    { label: "$(output) Open Output Channel", description: "WAT321: Model Bridge log" },
    makeSeparator(),
    {
      label: "$(key) OpenCode Zen API Key",
      description: "Set / update / clear the shared Zen secret",
    },
    {
      label: harnessOn
        ? "$(rocket) OpenCode Harness: enabled"
        : "$(circle-large-outline) OpenCode Harness: disabled",
      description: harnessOn
        ? "managed at 127.0.0.1:4096"
        : "Click to spawn the OpenCode server",
    },
    makeSeparator(),
    makePauseResumeItem(paused),
    makeCancelItem(),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: paused ? "Model Bridge (paused)" : "Model Bridge",
    placeHolder: paused ? "Paused - new tool calls refused until you Resume" : "Pick an action",
  });
  if (!pick) return;

  if (pick.label === "🟡 PAUSE") {
    setPaused(true);
    void vscode.window.showInformationMessage("Model Bridge paused. New tool calls will be refused until you Resume.");
    return;
  }
  if (pick.label === "🟢 RESUME") {
    setPaused(false);
    void vscode.window.showInformationMessage("Model Bridge resumed.");
    return;
  }
  if (pick.label === "🔴 CANCEL") {
    writeCancelFlag();
    void vscode.window.showInformationMessage("Model Bridge: cancel requested. The in-flight call will abort.");
    return;
  }

  if (pick.label.includes("Active Instance")) { await pickActiveInstance(context); return; }
  if (pick.label.includes("Open Output")) { logger.show(); return; }
  if (pick.label.includes("Test Connection")) { await testConnection(context, logger); return; }
  if (pick.label.includes("Manage OpenCode Sessions")) { await showModelBridgeSessions(); return; }
  if (pick.label.includes("Reset Session Totals")) { await resetSessionTotals(); return; }
  if (pick.label.includes("Sampling")) { await samplingMenu(); return; }
  if (pick.label.includes("Default Agent")) { await pickDefaultAgent(); return; }
  if (pick.label.includes("Phased Protocol")) { await pickPhasedProtocol(); return; }
  if (pick.label.includes("Auto-Compact")) { await pickAutoCompact(); return; }
  if (pick.label.includes("OpenCode Zen API Key")) { await zenKeyMenu(context); return; }
  if (pick.label.includes("Harness")) { await harnessMenu(); return; }
}
