import * as vscode from "vscode";
import { ClaudeUsageSharedService } from "../shared/claude-usage/service";
import type { ServiceState } from "../shared/claude-usage/types";
import { ClaudeUsage5hWidget } from "./widget";

export function activateClaudeUsage5hTool(
  context: vscode.ExtensionContext,
  service: ClaudeUsageSharedService
): void {
  const widget = new ClaudeUsage5hWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
