import * as vscode from "vscode";
import { ClaudeUsageSharedService } from "../shared/claude-usage/service";
import type { ServiceState } from "../shared/claude-usage/types";
import { ClaudeUsageWeeklyWidget } from "./widget";

export function activateClaudeUsageWeeklyTool(
  service: ClaudeUsageSharedService
): vscode.Disposable[] {
  const widget = new ClaudeUsageWeeklyWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
