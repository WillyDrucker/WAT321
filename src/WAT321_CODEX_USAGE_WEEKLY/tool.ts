import * as vscode from "vscode";
import { CodexUsageSharedService } from "../shared/codex-usage/service";
import type { ServiceState } from "../shared/codex-usage/types";
import { CodexUsageWeeklyWidget } from "./widget";

export function activateCodexUsageWeeklyTool(
  context: vscode.ExtensionContext,
  service: CodexUsageSharedService
): void {
  const widget = new CodexUsageWeeklyWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
