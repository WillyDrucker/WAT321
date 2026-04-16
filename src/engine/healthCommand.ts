import * as vscode from "vscode";
import type { EngineContext } from "./engineContext";
import type { ProviderKey } from "./contracts";

/**
 * Hidden debug command that dumps engine state to an output panel.
 * Not listed in package.json `contributes.commands` so it never
 * appears in the command palette by default. Registered internally
 * and invocable via `code --command wat321.showProviderHealth` or
 * by manually typing the command id in the palette.
 */

const COMMAND_ID = "wat321.showProviderHealth";

function formatProviderStatus(
  ctx: EngineContext,
  key: ProviderKey
): string {
  const group = ctx.providers.getGroup(key);
  if (!group) return `${key}: not activated`;

  const descriptor = ctx.providers.getDescriptor(key);
  const displayName = descriptor?.displayName ?? key;
  return `${displayName}: activated`;
}

export function registerHealthCommand(
  context: vscode.ExtensionContext,
  getCtx: () => EngineContext | null
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, () => {
      const ctx = getCtx();
      if (!ctx) {
        vscode.window.showWarningMessage("WAT321 engine not initialized.");
        return;
      }

      const providerLines: string[] = [];
      for (const key of ctx.providers.keys()) {
        providerLines.push(formatProviderStatus(ctx, key));
      }

      const lines: string[] = [
        "WAT321 Provider Health",
        "=".repeat(30),
        "",
        ...providerLines,
        "",
        `Active providers: ${ctx.providers.activeCount()}`,
        `Event hub handlers: active`,
        "",
        `Timestamp: ${new Date().toLocaleString()}`,
      ];

      const panel = vscode.window.createOutputChannel("WAT321 Health");
      panel.clear();
      for (const line of lines) panel.appendLine(line);
      panel.show();
    })
  );
}
