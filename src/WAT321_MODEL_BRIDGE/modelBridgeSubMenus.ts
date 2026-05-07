import * as vscode from "vscode";
import { makeBackItem, makeSeparator } from "./menuCommon";
import { readPreferences, updatePreference } from "./preferences";
import {
  clearZenApiKey,
  promptAndStoreZenApiKey,
  readSecret,
  ZEN_API_KEY_SECRET,
} from "./secrets";

/**
 * Sub-menu pickers for the Model Bridge widget: sampling knobs
 * (temperature, max tokens, timeout, system prompt), default agent,
 * phased protocol, harness toggle, and Zen API key management. All
 * reach `~/.wat321/model-bridge/preferences.json` via
 * `updatePreference`. Top-level menu shell lives in `statusBarMenu.ts`.
 */

const TEMPERATURE_PRESETS = [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.2];
const MAX_TOKENS_PRESETS = [500, 1000, 2000, 4000, 8000, 16000, 32000];
const TIMEOUT_PRESETS = [30, 60, 120, 180, 300, 600];
const AUTO_COMPACT_PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

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
      label: `${v === current ? "✔️ " : ""}${format(v)}`,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: `Pick a value (current: ${format(current)})`,
  });
  if (!pick || pick.label === "🔵 BACK") return undefined;
  const cleanedLabel = pick.label.replace(/^✔️ /, "");
  const idx = presets.findIndex((v) => format(v) === cleanedLabel);
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

export async function pickAutoCompact(): Promise<void> {
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

export async function pickDefaultAgent(): Promise<void> {
  const prefs = readPreferences();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: `${prefs.defaultAgent === "build" ? "✔️ " : ""}build`,
      detail: "OpenCode's default. Full file r/w + shell + web tools.",
    },
    {
      label: `${prefs.defaultAgent === "explore" ? "✔️ " : ""}explore`,
      detail: "Read-only investigation. No writes; no shell side effects.",
    },
    {
      label: `${prefs.defaultAgent === "general" ? "✔️ " : ""}general`,
      detail: "Mixed; lighter than build.",
    },
    {
      label: `${prefs.defaultAgent === "plan" ? "✔️ " : ""}plan`,
      detail: "Proposes work without executing. Read-only.",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Default OpenCode Agent",
    placeHolder: `Current: ${prefs.defaultAgent}. Per-call agent argument always wins.`,
  });
  if (!pick || pick.label === "🔵 BACK") return;
  const cleaned = pick.label.replace(/^✔️ /, "");
  if (
    cleaned === "build" ||
    cleaned === "explore" ||
    cleaned === "general" ||
    cleaned === "plan"
  ) {
    updatePreference("defaultAgent", cleaned);
  }
}

export async function pickPhasedProtocol(): Promise<void> {
  const prefs = readPreferences();
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: `${prefs.phasedProtocol === "auto" ? "✔️ " : ""}auto`,
      detail: "Gated 5-step for local instances, off for cloud. Recommended.",
    },
    {
      label: `${prefs.phasedProtocol === "gated-v1" ? "✔️ " : ""}gated-v1`,
      detail: "5 separate round-trips: RESTATE > PLAN > SOLVE > REVIEW > ANSWER. Best for small local models.",
    },
    {
      label: `${prefs.phasedProtocol === "markers-v1" ? "✔️ " : ""}markers-v1`,
      detail: "Single-shot marker prompt. Model emits all phases inline in one streaming response.",
    },
    {
      label: `${prefs.phasedProtocol === "off" ? "✔️ " : ""}off`,
      detail: "No phase scaffolding. Fastest; capable models often do not benefit from gating.",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Phased Protocol",
    placeHolder: `Current: ${prefs.phasedProtocol}`,
  });
  if (!pick || pick.label === "🔵 BACK") return;
  const cleaned = pick.label.replace(/^✔️ /, "");
  if (
    cleaned === "off" ||
    cleaned === "markers-v1" ||
    cleaned === "gated-v1" ||
    cleaned === "auto"
  ) {
    updatePreference("phasedProtocol", cleaned);
  }
}

export async function samplingMenu(): Promise<void> {
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

export async function harnessMenu(): Promise<void> {
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
        "Spawns the managed OpenCode server when on. Surface for a future tool-using sub-agent loop.",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "OpenCode Harness",
    placeHolder: harnessOn
      ? "Harness on - toggle off to stop the OpenCode server"
      : "Harness off - enable to spawn the OpenCode server",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  if (pick.label.includes("OpenCode harness:")) {
    updatePreference("useOpenCodeHarness", !harnessOn);
    void vscode.window.showInformationMessage(
      `OpenCode harness ${!harnessOn ? "enabled" : "disabled"}.`
    );
  }
}

export async function zenKeyMenu(context: vscode.ExtensionContext): Promise<void> {
  const existing = await readSecret(context, ZEN_API_KEY_SECRET);
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    {
      label: existing
        ? "$(key) Update OpenCode Zen API Key"
        : "$(key) Set OpenCode Zen API Key",
      description: existing ? "Stored" : "Not set",
      detail: "Used by every Zen instance (Big Pickle, GPT-5 Nano, Ling, Hy3, Nemotron, MiniMax M2.7)",
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
