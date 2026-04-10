import * as vscode from "vscode";
import { ClaudeUsageSharedService } from "../shared/claude-usage/service";
import type { ServiceState } from "../shared/claude-usage/types";
import { ClaudeUsageWeeklyWidget } from "./widget";

export function activateClaudeUsageWeeklyTool(
  context: vscode.ExtensionContext,
  service: ClaudeUsageSharedService
): void {
  const widget = new ClaudeUsageWeeklyWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
