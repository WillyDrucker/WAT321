import { existsSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import { readConfigFromSettings } from "./config";
import { USAGE_PATH } from "./constants";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  makeSeparator,
} from "./menuCommon";
import type { OpenCodeRoutesLogger } from "./outputChannel";
import { isPaused, setPaused, writeCancelFlag } from "./runtimeFlags";
import { promptAndStoreZenApiKey } from "./secrets";

/**
 * Action handlers spawned from `showOpenCodeRoutesMenu`:
 *
 *   - `pickActiveInstance` - active-instance picker, also dispatched
 *     from the EH session manager via the
 *     `wat321.modelBridge.pickActiveInstance` command (optional
 *     kindFilter narrows the list to `remote` or `local`).
 *   - `testConnection` - probe the active instance's `/v1/models`
 *     with a 5s timeout, surface the result in a toast + log.
 *   - `resetSessionTotals` - delete the usage cache after confirmation.
 *
 * Lives in its own file so the main menu file (`statusBarMenu.ts`)
 * stays focused on row construction + the orchestrator. Symmetric
 * with `WAT321_EPIC_HANDSHAKE/statusBarMenuActions.ts` so a reader
 * who learns one tier's action layout carries it to the other.
 */

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
          : `${inst.kind} - ${inst.dataRetention === "retained" ? "retained" : "local"}`;
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
    title: "Active OpenCode instance",
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
        `OpenCode: '${found.alias}' is set as active but still needs an API key. Use 'OpenCode Zen API Key' from the menu when ready.`
      );
      return;
    }
    return;
  }

  void vscode.window.showInformationMessage(
    `OpenCode: active instance set to ${found.alias}.`
  );
}

export async function testConnection(
  context: vscode.ExtensionContext,
  logger: OpenCodeRoutesLogger
): Promise<void> {
  const config = await readConfigFromSettings(context);
  const active = config.instances.find((i) => i.id === config.activeInstanceId);
  if (!active) {
    void vscode.window.showWarningMessage(
      "OpenCode: no active instance to test. Pick one via Active Instance."
    );
    return;
  }
  if (active.kind === "remote" && active.apiKeyMissing) {
    void vscode.window.showWarningMessage(
      `OpenCode: '${active.alias}' needs an API key. Use 'Set Zen API Key'.`
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
        `OpenCode: '${active.alias}' returned HTTP ${res.status} (${elapsed}ms).`
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
      `OpenCode: '${active.alias}' reachable, ${modelName} (${elapsed}ms).`
    );
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Test connection: ${url} -> ${msg}`);
    void vscode.window.showErrorMessage(`OpenCode Routes: ${active.alias} - ${msg}`);
  }
}

export async function resetSessionTotals(): Promise<void> {
  if (!existsSync(USAGE_PATH)) {
    void vscode.window.showInformationMessage(
      "OpenCode: session totals are already empty."
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "Reset OpenCode session totals? This zeroes the per-instance token + call counters surfaced in the widget tooltip.",
    "Reset",
    "Cancel"
  );
  if (confirm !== "Reset") return;
  try {
    unlinkSync(USAGE_PATH);
    void vscode.window.showInformationMessage("OpenCode: session totals reset.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`OpenCode: reset failed - ${msg}`);
  }
}
