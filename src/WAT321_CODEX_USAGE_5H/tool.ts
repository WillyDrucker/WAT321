import * as vscode from "vscode";
import { CodexUsageSharedService } from "../shared/codex-usage/service";
import type { ServiceState } from "../shared/codex-usage/types";
import { CodexUsage5hrWidget } from "./widget";

export function activateCodexUsage5hrTool(
  context: vscode.ExtensionContext,
  service: CodexUsageSharedService
): void {
  const widget = new CodexUsage5hrWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
