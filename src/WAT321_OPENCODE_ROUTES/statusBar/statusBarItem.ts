import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../../engine/widgetCatalog";
import { TpsThrottle } from "../../shared/ui/tpsThrottle";
import { readOpenCodeRoutesConfigSnapshot } from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import {
  refreshStatusBarItem,
  type RefreshContext,
} from "./openCodeStatusBarRefresh";
import type { OutputChannelLogger } from "../../engine/outputChannelLogger";
import type { SessionTarget } from "../../shared/bridge/sessionAliases";
import { BridgeSessionTokensPoller } from "./sessionTokensPoller";

/**
 * OpenCode Routes status-bar widget factory. Tooltip-only widget
 * (no `item.command` ever set): session and instance management
 * routes through the Epic Handshake dropdown. Render states (hidden,
 * idle, in-flight, stale) live in `openCodeStatusBarRefresh.ts`, data
 * sources in `openCodeStatusBarSources.ts`. This file owns the VS Code
 * item lifecycle: creation, command registration, poller wiring, 1Hz
 * refresh interval, dispose.
 */

const REFRESH_INTERVAL_MS = 1000;

export function createOpenCodeRoutesStatusBarItem(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger
): { dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    "wat321.modelBridge",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.openCodeRoutes)
  );
  item.name = "OpenCode Routes";
  item.hide();

  // Kept so settings descriptions and external integrations still
  // referencing it keep working.
  const showCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.show",
    () => logger.show()
  );

  // Background poller that hydrates per-session token totals from
  // OpenCode's message log so the widget renders `S1 12K 31%` style
  // figures parallel to Claude / Codex session tokens. Lookups are
  // closures over the merged config so the poller stays decoupled
  // from the config-file path - refreshes every 3s and caches by
  // sessionId.
  const sessionTokensPoller = new BridgeSessionTokensPoller({
    serveUrl: () => readOpenCodeRoutesConfigSnapshot()?.openCodeServerUrl ?? "",
    localEndpoint: () => {
      const snap = readOpenCodeRoutesConfigSnapshot();
      const local = snap?.instances.find((i) => i.kind === "local");
      return local?.endpoint ?? "";
    },
    catalogContextWindow: (target: SessionTarget) => {
      const snap = readOpenCodeRoutesConfigSnapshot();
      if (!snap) return null;
      const inst = snap.instances.find((i) =>
        target === "local" ? i.kind === "local" : i.kind === "remote"
      );
      return inst?.contextWindow ?? null;
    },
  });
  sessionTokensPoller.start();

  // Display-refresh throttle for the in-flight `@ N/s` rate suffix.
  // Caches the displayed rate on a flat 1s cadence so the
  // heartbeat's sub-second tokensPerSec updates do not flicker.
  // Reset whenever the active instance changes so a fresh route's
  // first reading lands immediately rather than waiting out the
  // prior route's throttle interval.
  const tpsThrottle = new TpsThrottle();
  const ctx: RefreshContext = {
    item,
    sessionTokensPoller,
    tpsThrottle,
    state: {},
  };

  refreshStatusBarItem(ctx);
  const timer = setInterval(() => refreshStatusBarItem(ctx), REFRESH_INTERVAL_MS);

  context.subscriptions.push(
    showCommand,
    item
  );

  return {
    dispose: (): void => {
      clearInterval(timer);
      sessionTokensPoller.dispose();
      item.dispose();
    },
  };
}
