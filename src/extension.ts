import * as vscode from "vscode";
import { UsageService } from "./usageService";
import { SessionWidget } from "./widgets/sessionWidget";
import { WeeklyWidget } from "./widgets/weeklyWidget";
import type { StatusBarWidget } from "./types";

const COMMAND_ID = "wat321.refresh";

let service: UsageService;
let widgets: StatusBarWidget[];

export function activate(context: vscode.ExtensionContext) {
  service = new UsageService();

  const session = new SessionWidget(COMMAND_ID);
  const weekly = new WeeklyWidget(COMMAND_ID);
  widgets = [session, weekly];

  // Wire widgets to service state
  const listener = (state: Parameters<typeof session.update>[0]) => {
    for (const w of widgets) w.update(state);
  };
  service.subscribe(listener);

  // Manual refresh command
  const cmd = vscode.commands.registerCommand(COMMAND_ID, () =>
    service.forceRefresh()
  );

  context.subscriptions.push(
    { dispose: () => service.dispose() },
    session,
    weekly,
    cmd
  );

  service.start();
}

export function deactivate() {
  service?.dispose();
}
