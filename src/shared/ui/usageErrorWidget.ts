import * as vscode from "vscode";
import type { ProviderKey } from "../../engine/contracts";
import type { ServiceState as GenericServiceState } from "../../engine/serviceTypes";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import { IDLE_DIM_COLOR } from "./idleColor";
import { classifyUsageNonOk } from "./usageNonOkClassifier";

/**
 * Conditional per-provider error-status widget. Sits between the 5h
 * and weekly bars and is the only surface that carries the one-word
 * state label (`Loading`, `Refreshing`, `Idle`, `Offline`, ...).
 * Hidden while the provider is `ok` so the status-bar footprint
 * matches the two-widget bars-only layout in the happy path. Tooltip
 * repeats the full classifier `detail` so a hover discloses the same
 * countdown / server message / incident the bar widget tooltip shows.
 */

export interface UsageErrorWidgetDescriptor {
  id: string;
  name: string;
  slot: number;
  providerName: string;
  providerKey: ProviderKey;
}

export class UsageErrorWidget<TData> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: UsageErrorWidgetDescriptor;

  constructor(descriptor: UsageErrorWidgetDescriptor) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = descriptor.name;
    // Constructor leaves the item hidden so it never paints stale
    // text before the first service tick. The first `update()` call
    // paints whatever state lands first - usually `loading` until the
    // initial fetch completes, then ok hides it again.
  }

  update(state: GenericServiceState<TData>): void {
    if (state.status === "ok") {
      this.item.hide();
      return;
    }
    const { label, detail } = classifyUsageNonOk(
      state,
      this.descriptor.providerName,
      this.descriptor.providerKey
    );
    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.supportThemeIcons = true;
    tip.appendMarkdown(`**${this.descriptor.providerName} usage: ${label}**`);
    tip.appendMarkdown(`\n\n${detail}`);
    this.item.text = label;
    this.item.tooltip = tip;
    this.item.color = IDLE_DIM_COLOR;
    this.item.command = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
