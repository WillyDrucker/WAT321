import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  type ModelBridgeInstance,
  readConfigFromSettings,
} from "./config";
import { SESSIONS_DIR, USAGE_PATH } from "./constants";
import { isPaused, setPaused, writeCancelFlag } from "./runtimeFlags";
import { makeBackItem, makeCancelItem, makePauseResumeItem, makeSeparator } from "./menuCommon";
import type { ModelBridgeLogger } from "./outputChannel";
import { readPreferences, updatePreference } from "./preferences";
import {
  clearZenApiKey,
  promptAndStoreZenApiKey,
  readSecret,
  ZEN_API_KEY_SECRET,
} from "./secrets";

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
 */

const TEMPERATURE_PRESETS = [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.2];

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

const MAX_TOKENS_PRESETS = [500, 1000, 2000, 4000, 8000, 16000, 32000];
const TIMEOUT_PRESETS = [30, 60, 120, 180, 300, 600];
const AUTO_COMPACT_PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

interface ThreadSummary {
  id: string;
  alias: string;
  turns: number;
  compacts: number;
  lastTs: string;
  modifiedMs: number;
}

function listThreadSummaries(): ThreadSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: ThreadSummary[] = [];
  for (const name of names) {
    const dir = join(SESSIONS_DIR, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const rolloutPath = join(dir, "rollout.jsonl");
    if (!existsSync(rolloutPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(rolloutPath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    let alias = "?";
    let turns = 0;
    let compacts = 0;
    let lastTs = "";
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.type === "session_meta") alias = e.alias ?? alias;
        if (e?.type === "turn") {
          turns++;
          lastTs = e.ts ?? lastTs;
        }
        if (e?.type === "compact") compacts++;
      } catch {
        // skip torn line
      }
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(rolloutPath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    out.push({ id: name, alias, turns, compacts, lastTs, modifiedMs: mtimeMs });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out;
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

async function pickActiveInstance(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = await readConfigFromSettings(context);

  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    ...config.instances.map((inst) => {
      const star = inst.id === config.activeInstanceId ? "$(star-full) " : "";
      const status =
        inst.kind === "remote" && inst.apiKeyMissing
          ? "needs Zen API key"
          : `${inst.kind} - ${retentionLabel(inst)}`;
      return {
        label: `${star}${inst.alias}`,
        description: status,
        detail: `${inst.endpoint}${inst.model ? `  ·  model=${inst.model}` : ""}`,
      };
    }),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Active Model Bridge instance",
    placeHolder: "Pick which instance handles tool calls by default",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  const stripped = pick.label.replace(/^\$\(star-full\) /, "");
  const found = config.instances.find((i) => i.alias === stripped);
  if (!found) return;

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

async function pickFromPresets<T extends number | string>(
  title: string,
  current: T,
  presets: readonly T[],
  format: (v: T) => string
): Promise<T | undefined> {
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    ...presets.map((v) => ({
      label: format(v),
      description: v === current ? "(current)" : undefined,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: `Pick a value (current: ${format(current)})`,
  });
  if (!pick || pick.label === "🔵 BACK") return undefined;
  const idx = presets.findIndex((v) => format(v) === pick.label);
  return idx >= 0 ? presets[idx] : undefined;
}

async function pickTemperature(): Promise<void> {
  const prefs = readPreferences();
  const v = await pickFromPresets(
    "Temperature",
    prefs.temperature,
    TEMPERATURE_PRESETS,
    (n) => n.toFixed(1)
  );
  if (typeof v === "number") updatePreference("temperature", v);
}

async function pickMaxTokens(): Promise<void> {
  const prefs = readPreferences();
  const v = await pickFromPresets(
    "Max tokens",
    prefs.maxTokens,
    MAX_TOKENS_PRESETS,
    (n) => `${n.toLocaleString()} tokens`
  );
  if (typeof v === "number") updatePreference("maxTokens", v);
}

async function pickTimeout(): Promise<void> {
  const prefs = readPreferences();
  const v = await pickFromPresets(
    "Timeout (seconds)",
    prefs.timeoutSec,
    TIMEOUT_PRESETS,
    (n) => `${n}s`
  );
  if (typeof v === "number") updatePreference("timeoutSec", v);
}

async function pickAutoCompact(): Promise<void> {
  const prefs = readPreferences();
  const v = await pickFromPresets(
    "Auto-compact threshold (fraction of n_ctx)",
    prefs.autoCompactThreshold,
    AUTO_COMPACT_PRESETS,
    (n) => `${Math.round(n * 100)}%`
  );
  if (typeof v !== "number") return;
  // Aggressive thresholds (<= 60%) trigger summarization frequently
  // and replace older turns with a compressed summary - that loss is
  // permanent for the rollout. Guard with a confirm so a misclick
  // doesn't nuke conversational fidelity.
  if (v <= 0.6) {
    const confirm = await vscode.window.showWarningMessage(
      `Auto-compact at ${Math.round(v * 100)}% will summarize older turns aggressively - the original turns are replaced and cannot be recovered. Continue?`,
      { modal: true },
      "Set"
    );
    if (confirm !== "Set") return;
  }
  updatePreference("autoCompactThreshold", v);
}

async function editSystemPrompt(): Promise<void> {
  const prefs = readPreferences();
  const v = await vscode.window.showInputBox({
    title: "System prompt",
    prompt:
      "Prepended to every chat call. Leave blank to omit. Per-call `system` overrides via the tool's `system` argument win.",
    value: prefs.systemPrompt,
  });
  if (typeof v === "string") updatePreference("systemPrompt", v);
}

async function pickDefaultAgent(): Promise<void> {
  const prefs = readPreferences();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: "build",
      description: prefs.defaultAgent === "build" ? "(current)" : undefined,
      detail: "OpenCode's default. Full file r/w + shell + web tools.",
    },
    {
      label: "explore",
      description: prefs.defaultAgent === "explore" ? "(current)" : undefined,
      detail: "Read-only investigation. No writes; no shell side effects.",
    },
    {
      label: "general",
      description: prefs.defaultAgent === "general" ? "(current)" : undefined,
      detail: "Mixed; lighter than build.",
    },
    {
      label: "plan",
      description: prefs.defaultAgent === "plan" ? "(current)" : undefined,
      detail: "Proposes work without executing. Read-only.",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Default OpenCode Agent",
    placeHolder: `Current: ${prefs.defaultAgent}. Per-call agent argument always wins.`,
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (
    pick.label === "build" ||
    pick.label === "explore" ||
    pick.label === "general" ||
    pick.label === "plan"
  ) {
    updatePreference("defaultAgent", pick.label);
  }
}

async function pickPhasedProtocol(): Promise<void> {
  const prefs = readPreferences();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: "auto",
      description: prefs.phasedProtocol === "auto" ? "(current)" : undefined,
      detail: "Gated 5-step for local instances, off for cloud. Recommended.",
    },
    {
      label: "gated-v1",
      description: prefs.phasedProtocol === "gated-v1" ? "(current)" : undefined,
      detail: "5 separate round-trips: RESTATE > PLAN > SOLVE > REVIEW > ANSWER. Best for small local models.",
    },
    {
      label: "markers-v1",
      description: prefs.phasedProtocol === "markers-v1" ? "(current)" : undefined,
      detail: "Single-shot marker prompt. Model emits all phases inline in one streaming response.",
    },
    {
      label: "off",
      description: prefs.phasedProtocol === "off" ? "(current)" : undefined,
      detail: "No phase scaffolding. Fastest; capable models often do not benefit from gating.",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Phased Protocol",
    placeHolder: `Current: ${prefs.phasedProtocol}`,
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (
    pick.label === "off" ||
    pick.label === "markers-v1" ||
    pick.label === "gated-v1" ||
    pick.label === "auto"
  ) {
    updatePreference("phasedProtocol", pick.label);
  }
}

async function samplingMenu(): Promise<void> {
  const prefs = readPreferences();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: "$(thermometer) Temperature",
      description: prefs.temperature.toFixed(1),
      detail: "Sampling temperature (lower = more deterministic)",
    },
    {
      label: "$(symbol-numeric) Max tokens",
      description: prefs.maxTokens.toLocaleString(),
      detail: "Max response length per call",
    },
    {
      label: "$(watch) Timeout",
      description: `${prefs.timeoutSec}s`,
      detail: "Per-call HTTP timeout",
    },
    {
      label: "$(comment) System prompt",
      description: prefs.systemPrompt ? `${prefs.systemPrompt.slice(0, 40)}…` : "(none)",
      detail: "Prepended to every chat call",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Sampling",
    placeHolder: "Pick a setting to change",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (pick.label.includes("Temperature")) await pickTemperature();
  else if (pick.label.includes("Max tokens")) await pickMaxTokens();
  else if (pick.label.includes("Timeout")) await pickTimeout();
  else if (pick.label.includes("System prompt")) await editSystemPrompt();
}

async function harnessMenu(): Promise<void> {
  const prefs = readPreferences();
  const harnessOn = prefs.useOpenCodeHarness;

  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: harnessOn
        ? "$(check) OpenCode harness: enabled"
        : "$(circle-large-outline) OpenCode harness: disabled",
      description: "Click to toggle",
      detail:
        "Exposes model_bridge_task when on AND the managed OpenCode server is reachable",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "OpenCode Harness",
    placeHolder: harnessOn
      ? "Harness on - toggle off to hide model_bridge_task"
      : "Harness off - enable to expose model_bridge_task",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (pick.label.includes("OpenCode harness:")) {
    updatePreference("useOpenCodeHarness", !harnessOn);
    void vscode.window.showInformationMessage(
      `OpenCode harness ${!harnessOn ? "enabled" : "disabled"}.`
    );
  }
}

async function zenKeyMenu(context: vscode.ExtensionContext): Promise<void> {
  const existing = await readSecret(context, ZEN_API_KEY_SECRET);
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: existing
        ? "$(key) Update OpenCode Zen API Key"
        : "$(key) Set OpenCode Zen API Key",
      description: existing ? "Stored" : "Not set",
      detail: "Used by every Zen instance (Big Pickle, GPT-5 Nano, Ling, Hy3, Nemotron, MiniMax M2.5)",
    },
  ];
  if (existing) {
    items.push({
      label: "$(trash) Clear OpenCode Zen API Key",
      detail: "Remove the stored secret. Zen instances will report 'needs API key' until set again.",
    });
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: "OpenCode Zen API Key",
    placeHolder: existing ? "Update or clear the stored key" : "Store your Zen API key",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (pick.label.includes("Clear")) {
    await clearZenApiKey(context);
    return;
  }
  await promptAndStoreZenApiKey(context);
}

async function manageThreadsMenu(): Promise<void> {
  const threads = listThreadSummaries();
  if (threads.length === 0) {
    void vscode.window.showInformationMessage(
      "Model Bridge: no active threads. Claude can start one via the model_bridge_thread tool."
    );
    return;
  }

  const eraseAllItem: vscode.QuickPickItem = {
    label: "$(trash) Erase all threads",
    description: `${threads.length} thread${threads.length === 1 ? "" : "s"}`,
    detail: "Removes every rollout in ~/.wat321/model-bridge/sessions/",
  };
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    eraseAllItem,
    makeSeparator(),
    ...threads.map((t) => ({
      label: t.id,
      description: `${t.alias} · ${t.turns} turn${t.turns === 1 ? "" : "s"}${
        t.compacts > 0 ? ` · ${t.compacts} compact${t.compacts === 1 ? "" : "s"}` : ""
      }`,
      detail: t.lastTs ? `Last turn ${t.lastTs}` : "No turns yet",
    })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Manage OpenCode Sessions",
    placeHolder: "Pick a thread to erase, or 'Erase all'",
  });
  if (!pick || pick.label === "🔵 BACK") return;

  if (pick === eraseAllItem) {
    const confirm = await vscode.window.showWarningMessage(
      `Erase all ${threads.length} Model Bridge thread${threads.length === 1 ? "" : "s"}? This cannot be undone.`,
      { modal: true },
      "Erase All"
    );
    if (confirm !== "Erase All") return;
    let removed = 0;
    for (const t of threads) {
      try {
        rmSync(join(SESSIONS_DIR, t.id), { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort
      }
    }
    void vscode.window.showInformationMessage(
      `Model Bridge: erased ${removed} of ${threads.length} thread${threads.length === 1 ? "" : "s"}.`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Erase thread '${pick.label}'? This removes its rollout permanently.`,
    { modal: true },
    "Erase"
  );
  if (confirm !== "Erase") return;
  try {
    rmSync(join(SESSIONS_DIR, pick.label), { recursive: true, force: true });
    void vscode.window.showInformationMessage(`Model Bridge: thread '${pick.label}' erased.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Model Bridge: erase failed - ${msg}`);
  }
}

/** Public entry point for the Manage OpenCode Sessions submenu.
 * Invoked directly by the Epic Handshake click menu's "Manage
 * OpenCode Sessions" row so users can reach bridge session
 * management from either widget. */
export async function showModelBridgeSessions(): Promise<void> {
  await manageThreadsMenu();
}

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
      detail: "Fraction of n_ctx that triggers model_bridge_thread auto-compact",
    },
    {
      label: "$(symbol-property) Sampling",
      description: `T ${prefs.temperature.toFixed(1)} · ${prefs.maxTokens.toLocaleString()} max · ${prefs.timeoutSec}s`,
      detail: "Temperature, max tokens, timeout, system prompt",
    },
    {
      label: "$(person) Default Agent",
      description: prefs.defaultAgent,
      detail: "OpenCode agent used for model_bridge_task when the caller omits agent",
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
        : "Click to enable model_bridge_task",
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
  if (pick.label.includes("Manage OpenCode Sessions")) { await manageThreadsMenu(); return; }
  if (pick.label.includes("Reset Session Totals")) { await resetSessionTotals(); return; }
  if (pick.label.includes("Sampling")) { await samplingMenu(); return; }
  if (pick.label.includes("Default Agent")) { await pickDefaultAgent(); return; }
  if (pick.label.includes("Phased Protocol")) { await pickPhasedProtocol(); return; }
  if (pick.label.includes("Auto-Compact")) { await pickAutoCompact(); return; }
  if (pick.label.includes("OpenCode Zen API Key")) { await zenKeyMenu(context); return; }
  if (pick.label.includes("Harness")) { await harnessMenu(); return; }
}
