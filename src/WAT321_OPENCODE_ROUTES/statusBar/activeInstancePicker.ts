import * as vscode from "vscode";
import { readConfigFromSettings } from "../openCodeRoutesConfig";
import { makeBackItem, makeSeparator } from "../../shared/ui/menuRows";
import { updatePreference } from "../preferences";
import { promptAndStoreZenApiKey } from "../serve/secrets";

/**
 * Active-instance picker for OpenCode Routes, behind the
 * `wat321.modelBridge.pickActiveInstance` command. The Epic Handshake
 * session manager dispatches it with `kindFilter: "remote"` from its
 * MODEL row so Local LLM, which has its own submenu, stays out of the
 * list, and the palette command passes nothing to show every kind.
 * Picking a remote instance that still needs the Zen key prompts for
 * the key in place.
 */

export async function pickActiveInstance(
  context: vscode.ExtensionContext,
  kindFilter?: "remote" | "local"
): Promise<void> {
  const config = await readConfigFromSettings(context);
  const visibleInstances = kindFilter
    ? config.instances.filter((i) => i.kind === kindFilter)
    : config.instances;

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
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Active OpenCode instance",
    placeHolder: "Pick which instance handles tool calls by default",
  });
  if (!pick || pick.label === "🔵 BACK") return;
  const stripped = pick.label.replace(/^✔️ /, "");
  const found = config.instances.find((i) => i.alias === stripped);
  if (!found) return;

  updatePreference("activeInstanceId", found.id);

  if (found.kind === "remote" && found.apiKeyMissing) {
    const stored = await promptAndStoreZenApiKey(context);
    if (!stored) {
      void vscode.window.showWarningMessage(
        `OpenCode: '${found.alias}' is set as active but still needs an API key. Set the Zen API key from the command palette when ready.`
      );
      return;
    }
    return;
  }

  void vscode.window.showInformationMessage(
    `OpenCode: active instance set to ${found.alias}.`
  );
}
