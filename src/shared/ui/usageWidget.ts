import * as vscode from "vscode";
import type { ProviderKey } from "../../engine/contracts";
import { getDisplayMode } from "../../engine/displayMode";
import type { ServiceState as GenericServiceState } from "../../engine/serviceTypes";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import { refreshIfStale } from "../incidentStatusPoller";
import {
  clearProviderSnapshot,
  loadSnapshot,
  saveSnapshot,
} from "../usage/snapshotStore";
import { IDLE_DIM_COLOR } from "./idleColor";
import { classifyUsageNonOk } from "./usageNonOkClassifier";

/**
 * Config-driven usage widget. Bars are always visible. The ok branch
 * renders fresh data with the provider's text color; every non-ok branch
 * reuses the same bar layout (last-known cached data when available, else
 * a 0% scaffold) under the dim idle color. The one-word state label
 * ("Loading", "Refreshing", "Idle", "Offline", ...) lives on a separate
 * conditional error-status widget (`UsageErrorWidget`) sitting between
 * this 5h widget and the matching weekly widget - this widget itself
 * stays bars-only so the user always sees usage shape, never text where
 * a bar should be. The non-ok tooltip still leads with the cached ok
 * content (reset times etc.) and closes with the error detail so hover
 * disclosure remains identical.
 */

export interface UsageWidgetDescriptor<TData> {
  id: string;
  name: string;
  slot: number;
  /** Display name used inside non-ok tooltips ("Claude", "Codex"). */
  providerName: string;
  /** Provider key for incident-status lookups on the rate-limited (warm)
   * path - the renderer asks `incidentStatusPoller` for a cached status
   * indicator and surfaces it as a tooltip line when an incident is live. */
  providerKey: ProviderKey;
  /** Extract the display percentage from the ok data. This is whatever
   * the widget shows: "used %" for Claude, "remaining %" for Codex. The
   * `renderBar` and `getTextColor` callbacks receive this same value. */
  getDisplayPct(data: TData): number;
  /** Render the progress bar at a given width. Width 0 inputs (no cached
   * data yet) must produce a full-blank bar - that is what makes the
   * scaffold "bars always" instead of falling back to a pill. */
  renderBar(pct: number, width: number): string;
  /** Build the full ok-state tooltip from the ok data. Reused on non-ok
   * when a cached payload exists so the user still sees their last-known
   * reset times under the idle skin. */
  buildTooltip(data: TData): vscode.MarkdownString;
  /** Resolve the text color for the ok state. Non-ok states ignore this
   * and use the idle dim color directly. */
  getTextColor(mode: ReturnType<typeof getDisplayMode>, pct: number): string | undefined;
  /** Format the status-bar text for a given display mode. Used for
   * both ok and non-ok states. The bar widget never adds a state-
   * label suffix - the sibling `UsageErrorWidget` owns that disclosure. */
  formatText(mode: ReturnType<typeof getDisplayMode>, pct: number, bar5: string, bar10: string): string;
}

export class UsageWidget<TData> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: UsageWidgetDescriptor<TData>;
  /** Last `ok` payload observed. The non-ok render path uses this so the
   * widget keeps showing the user's previous bar + percent under the dim
   * skin instead of dropping to a blank 0%. Null until the first ok lands
   * - on a brand-new install or a freshly-cleared cache, the renderer
   * falls through to the 0% scaffold so the widget is still a bar, never
   * a pill. Cleared on identity-changing states (`not-connected`,
   * `no-auth`, `token-expired`) so a user signing into a different
   * account never sees the prior account's bars. */
  private lastOkData: TData | null = null;
  /** Wall-clock ms (Date.now()) when `lastOkData` was captured. Drives
   * the "Last updated N ago" disclosure on the non-ok tooltip. Null when
   * no cached data is available. */
  private lastOkFetchedAt: number | null = null;

  constructor(descriptor: UsageWidgetDescriptor<TData>) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = descriptor.name;
    // Hydrate the last-known-good payload from disk so a VS Code
    // restart, extension reload, or long error stretch never wipes
    // the bars the user was last seeing. Both 5h and weekly widgets
    // for the same provider share one snapshot slot (the upstream
    // payload carries both windows), so each widget reads the same
    // file and extracts its own field via descriptor.getDisplayPct.
    // Cleared by the identity-change branch below (per-provider) and
    // by Reset WAT321's per-client state-dir wipe (full sweep).
    const persisted = loadSnapshot<TData>(descriptor.providerKey);
    if (persisted !== null) {
      this.lastOkData = persisted.data;
      this.lastOkFetchedAt = persisted.fetchedAt;
    }
    // Paint a 0% scaffold (or the persisted bars if we just hydrated)
    // the moment the widget exists so the first frame is a bar instead
    // of a spinner or empty text - the bars-always contract holds even
    // before the first service tick lands.
    this.renderNonOk(`Fetching ${descriptor.providerName} usage data.`);
  }

  update(state: GenericServiceState<TData>): void {
    // Cache the ok payload + fetch time so a later non-ok render shows
    // the same bar + percent dimmed instead of dropping to 0%. Caching
    // happens before the renders so a transient ok between two errors
    // still refreshes the cache. Persist the payload to disk too so a
    // VS Code restart or extension reload keeps the bars across
    // sessions. Cleared per-provider on identity-changing states below
    // and fully by Reset WAT321.
    if (state.status === "ok") {
      this.lastOkData = state.data;
      this.lastOkFetchedAt = state.fetchedAt;
      saveSnapshot(this.descriptor.providerKey, state.data, state.fetchedAt);
    }

    // Identity-changing states clear BOTH the in-memory cache and the
    // persisted snapshot so sign-out / token expiry / disconnect
    // followed by a new account never bleed the previous account's
    // bars onto the new widget, including across a VS Code restart.
    // Other non-ok states are transient for the SAME identity and keep
    // both caches. Per-provider clear so the sibling provider's
    // snapshot stays intact.
    if (
      state.status === "not-connected" ||
      state.status === "no-auth" ||
      state.status === "token-expired"
    ) {
      this.lastOkData = null;
      this.lastOkFetchedAt = null;
      clearProviderSnapshot(this.descriptor.providerKey);
    }

    if (state.status === "ok") {
      this.renderOk(state.data);
      return;
    }

    // Kick a lazy refresh of the provider's public status page when we
    // hit the rate-limited path. TTL-gated, fires at most once per 5
    // min per window. Lives here (not in the classifier) so the
    // sibling error widget's update never double-fires the same kick
    // for the same state tick.
    if (state.status === "rate-limited") {
      refreshIfStale(this.descriptor.providerKey);
    }

    const { detail } = classifyUsageNonOk(
      state,
      this.descriptor.providerName,
      this.descriptor.providerKey
    );
    this.renderNonOk(detail);
  }

  private renderOk(data: TData): void {
    const d = this.descriptor;
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

  /** Render any non-ok state through the same bar layout as ok - cached
   * data when available, a 0% scaffold otherwise - with the dim color
   * and a tooltip that leads with the cached ok content (reset times
   * etc.) and closes with the error detail. The one-word state label
   * lives on the sibling `UsageErrorWidget`, so the bar widget itself
   * carries no suffix - the user always reads usage shape here, never
   * text where a bar should be. No `hide()`, no spinner-only pill. */
  private renderNonOk(detail: string): void {
    const d = this.descriptor;
    const data = this.lastOkData;
    const pct = data !== null ? d.getDisplayPct(data) : 0;
    const mode = getDisplayMode();
    const bar5 = d.renderBar(pct, 5);
    const bar10 = d.renderBar(pct, 10);

    // No click affordance on non-ok - the auto-kickstart on the service
    // handles recovery, no user action is required or possible.
    this.item.command = undefined;
    this.item.text = d.formatText(mode, pct, bar5, bar10);
    this.item.tooltip = this.buildNonOkTooltip(data, detail);
    this.item.color = IDLE_DIM_COLOR;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  /** Tooltip layout for non-ok. With a cached ok payload, the ok tooltip
   * (reset times, full row breakdown) sits on top, a horizontal rule
   * separates, and the error detail plus a "Last updated N ago"
   * disclosure closes the bottom. Without a cached payload (first
   * install / fresh cache clear), only the error detail is shown so the
   * tooltip never lies about reset data we don't have. */
  private buildNonOkTooltip(data: TData | null, detail: string): vscode.MarkdownString {
    const tip = new vscode.MarkdownString();
    // Default the trust flag off. Provider error detail is assembled
    // from transient API state, so isTrusted stays false unless we are
    // embedding the cached ok tooltip, in which case the provider's
    // own tooltip builder owns the flag and we adopt its setting.
    tip.isTrusted = false;
    tip.supportThemeIcons = true;
    tip.supportHtml = true;

    if (data !== null) {
      const base = this.descriptor.buildTooltip(data);
      tip.isTrusted = base.isTrusted;
      tip.supportThemeIcons = base.supportThemeIcons;
      tip.supportHtml = base.supportHtml;
      tip.appendMarkdown(base.value);
      const age =
        this.lastOkFetchedAt !== null
          ? formatAge(Date.now() - this.lastOkFetchedAt)
          : "earlier";
      tip.appendMarkdown(`\n\n---\n\n${detail} Last updated ${age}.`);
    } else {
      tip.appendMarkdown(detail);
    }
    return tip;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Format an elapsed-ms duration as a short human label for the non-ok
 * tooltip ("12s ago", "3m ago", "1h 22m ago"). No decimals, single-unit
 * sub-minute, two-unit for hours. Negative inputs (clock skew on cached
 * `fetchedAt`) clamp to "just now." */
function formatAge(ms: number): string {
  if (ms < 0 || ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m ago` : `${h}h ago`;
}
