import * as vscode from "vscode";
import { CodexUsageSharedService } from "../shared/codex-usage/service";
import type { ServiceState } from "../shared/codex-usage/types";
import { CodexUsage5hrWidget } from "./widget";

export function activateCodexUsage5hrTool(
  service: CodexUsageSharedService
): vscode.Disposable[] {
  const widget = new CodexUsage5hrWidget();
  const listener = (state: ServiceState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
