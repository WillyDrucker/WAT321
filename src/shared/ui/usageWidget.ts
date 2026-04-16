import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import type { ServiceState as GenericServiceState } from "../serviceTypes";
import {
  renderUsageNonOkState,
  renderWeeklyUsageNonOkState,
  type UsageNonOkOptions,
} from "./usageNonOkRenderer";
/**
 * Config-driven usage widget. Replaces the four near-identical
 * widget files (Claude 5h/weekly, Codex 5h/weekly) with a single
 * class parameterized by a descriptor. Each provider still defines
 * its own descriptor with provider-specific rendering callbacks.
 */

export interface UsageWidgetDescriptor<TData> {
  id: string;
  name: string;
  slot: number;
  /** "5h" widgets use renderUsageNonOkState (shows status pill on
   * error). "weekly" widgets use renderWeeklyUsageNonOkState (hides
   * on all error states). */
  variant: "5h" | "weekly";
  /** Non-ok renderer options (provider name, key, loading text).
   * Only used by 5h variant. */
  nonOkOptions?: UsageNonOkOptions;
  /** Loading text for weekly variant. */
  loadingText?: string;
  /** Loading tooltip for weekly variant. */
  loadingTooltip?: string;
  /** Extract the display percentage from the ok data. This is
   * whatever the widget shows to the user: "used %" for Claude,
   * "remaining %" for Codex. The `renderBar` and `getTextColor`
   * callbacks receive this same value and must convert internally
   * if their underlying helpers expect a different semantic. */
  getDisplayPct(data: TData): number;
  /** Render the progress bar at a given width. */
  renderBar(pct: number, width: number): string;
  /** Build the full tooltip from the ok data. */
  buildTooltip(data: TData): vscode.MarkdownString;
  /** Resolve the text color for the current state. */
  getTextColor(mode: ReturnType<typeof getDisplayMode>, pct: number): string | undefined;
  /** Format the status bar text for each display mode. */
  formatText(mode: ReturnType<typeof getDisplayMode>, pct: number, bar5: string, bar10: string): string;
}

export class UsageWidget<TData> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: UsageWidgetDescriptor<TData>;

  constructor(descriptor: UsageWidgetDescriptor<TData>) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = descriptor.name;
    this.item.text = descriptor.loadingText ?? `${descriptor.id} $(loading~spin)`;
    this.item.color = undefined;
  }

  update(state: GenericServiceState<TData>): void {
    const d = this.descriptor;

    if (d.variant === "weekly") {
      const handled = renderWeeklyUsageNonOkState(this.item, state, {
        loadingText: d.loadingText ?? "",
        loadingTooltip: d.loadingTooltip ?? "",
      });
      if (handled) return;
    } else {
      if (d.nonOkOptions) {
        const handled = renderUsageNonOkState(this.item, state, d.nonOkOptions);
        if (handled) return;
      }
    }

    if (state.status !== "ok") return;
    const { data } = state;
    const pct = d.getDisplayPct(data);
    const mode = getDisplayMode();
    const bar5 = d.renderBar(pct, 5);
    const bar10 = d.renderBar(pct, 10);

    this.item.text = d.formatText(mode, pct, bar5, bar10);
    this.item.tooltip = d.buildTooltip(data);
    this.item.color = d.getTextColor(mode, pct);
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
