import * as vscode from "vscode";
import { makeBackItem, makeSeparator } from "./menuCommon";
import {
  clearZenApiKey,
  promptAndStoreZenApiKey,
  readSecret,
  ZEN_API_KEY_SECRET,
} from "./secrets";

/**
 * Zen API key sub-menu for the OpenCode Routes widget. Set / update /
 * clear flow with a single SecretStorage key shared by every Zen
 * instance. Top-level menu shell lives in `statusBarMenu.ts`.
 */

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
