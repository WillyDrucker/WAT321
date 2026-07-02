import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import { TpsThrottle } from "../shared/ui/tpsThrottle";
import { readConfigSnapshot } from "./openCodeStatusBarSources";
import {
  refreshStatusBarItem,
  type RefreshContext,
} from "./openCodeStatusBarRefresh";
import type { OpenCodeRoutesLogger } from "./outputChannel";
import {
  BridgeSessionTokensPoller,
  type BridgeTarget,
} from "./sessionTokensPoller";
import {
  showOpenCodeRoutesMenu,
  showOpenCodeRoutesSessions,
} from "./statusBarMenu";

/**
 * OpenCode Routes status-bar widget factory. Tooltip-only widget
 * (no `item.command` ever set) - all session/instance management
 * routes through the Epic Handshake dropdown or the command palette
 * surface this file registers. Render states (hidden / idle / in-
 * flight / stale) live in `openCodeStatusBarRefresh.ts` - data
 * sources live in `openCodeStatusBarSources.ts`. This file owns the
 * VS Code item lifecycle: creation, command registration, poller
 * wiring, 1Hz refresh interval, dispose.
 *
 * Re-exports `Heartbeat` and `PhaseEntry` so `tooltip.ts` and any
 * other callers can import their types from the historical path.
 */

export type { Heartbeat, PhaseEntry } from "./openCodeStatusBarSources";

const REFRESH_INTERVAL_MS = 1000;

export function createOpenCodeRoutesStatusBarItem(
  context: vscode.ExtensionContext,
  logger: OpenCodeRoutesLogger
): { dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    "wat321.modelBridge",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.openCodeRoutes)
  );
  item.name = "OpenCode Routes";
  item.hide();

  const legacyMenuCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.legacyMenu",
    async () => {
      await showOpenCodeRoutesMenu(context, logger);
    }
  );
  // Cross-tier hook: Epic Handshake dispatches to this command from
  // its "Manage OpenCode Sessions" row so users reach bridge session
  // management without leaving the EH dropdown.
  const sessionsCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.manageSessions",
    async () => {
      await showOpenCodeRoutesSessions();
    }
  );
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
    serveUrl: () => readConfigSnapshot()?.openCodeServerUrl ?? "",
    localEndpoint: () => {
      const snap = readConfigSnapshot();
      const local = snap?.instances.find((i) => i.kind === "local");
      return local?.endpoint ?? "";
    },
    catalogContextWindow: (target: BridgeTarget) => {
      const snap = readConfigSnapshot();
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
    legacyMenuCommand,
    sessionsCommand,
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
