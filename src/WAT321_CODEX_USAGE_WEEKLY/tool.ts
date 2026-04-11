import * as vscode from "vscode";
import { CodexUsageSharedService } from "../shared/codex-usage/service";
import type { ServiceState } from "../shared/codex-usage/types";
import { CodexUsageWeeklyWidget } from "./widget";

export function activateCodexUsageWeeklyTool(
  service: CodexUsageSharedService
): vscode.Disposable[] {
  const widget = new CodexUsageWeeklyWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
