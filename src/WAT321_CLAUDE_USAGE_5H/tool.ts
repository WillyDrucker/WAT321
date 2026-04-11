import * as vscode from "vscode";
import { ClaudeUsageSharedService } from "../shared/claude-usage/service";
import type { ServiceState } from "../shared/claude-usage/types";
import { ClaudeUsage5hrWidget } from "./widget";

export function activateClaudeUsage5hrTool(
  service: ClaudeUsageSharedService
): vscode.Disposable[] {
  const widget = new ClaudeUsage5hrWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
