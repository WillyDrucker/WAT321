import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import type { ServiceState as GenericServiceState } from "../../engine/serviceTypes";
import { getWidgetPriority } from "../../engine/widgetCatalog";
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

/** Foreground color used by the cold-start idle skin. Dim enough that
 * the widget reads as "paused, not active" against both dark and
 * light VS Code themes, but still legible. Applies to the entire item
 * text - bar emoji squares ignore item.color because they have their
 * own intrinsic color (only the codicon + number + suffix dim). */
const IDLE_DIM_COLOR = "#7a7a7a";

export class UsageWidget<TData> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: UsageWidgetDescriptor<TData>;
  /** Last `ok` payload observed. Cached so the cold-start idle skin
   * can keep showing the previous usage bar + percent instead of
   * blanking to a generic "Idle" pill. Null until the first ok state
   * lands - on a brand-new install whose first poll lands a cold-start
   * 429, this stays null and the renderer falls through to the
   * non-ok renderer's generic "Idle" text. Cleared on identity-changing
   * states (`not-connected`, `no-auth`, `token-expired`) so a user
   * signing out and into a different account never sees the previous
   * account's bars under the idle skin. */
  private lastOkData: TData | null = null;
  /** Wall-clock ms (Date.now()) when `lastOkData` was captured. Drives
   * the "Last updated X ago" disclosure on the idle tooltip so the
   * dimmed widget never reads as live. Null when no cached data. */
  private lastOkFetchedAt: number | null = null;

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

    // Cache the last ok payload + its fetch time so the cold-start idle
    // path can re-render the same bar + percent the user just saw, only
    // dimmed and tagged "Idle." Caching happens BEFORE any return so a
    // transient ok between two rate-limited polls still updates the
    // cache.
    if (state.status === "ok") {
      this.lastOkData = state.data;
      this.lastOkFetchedAt = state.fetchedAt;
    }

    // Identity-changing states drop the cache so a sign-out / token-
    // expiry / disconnect followed by a new-account cold-start 429
    // does NOT bleed the previous account's bars onto the new widget.
    // The other non-ok states (offline, error, rate-limited) are
    // transient connection issues for the SAME identity; cache survives.
    if (
      state.status === "not-connected" ||
      state.status === "no-auth" ||
      state.status === "token-expired"
    ) {
      this.lastOkData = null;
      this.lastOkFetchedAt = null;
    }

    // Cold-start idle skin (5h widgets only). The park was entered while
    // the user was idle - Anthropic's usage endpoint 429s cold polls on
    // accounts with no recent OAuth use. That is NOT an incident; it is
    // a "paused for now" state that recovers on the next activity. Keep
    // the last-known usage bar + percent visible so the user does not
    // lose the data they were looking at moments ago. Dim everything to
    // signal "this is stale, not live" without dropping the data. Other
    // non-ok states (no-auth, token-expired, offline, error, rate-limited
    // non-cold-start) keep their dedicated "Standard error" pills via
    // renderUsageNonOkState - those are real failures where showing
    // stale data could be misleading.
    if (
      d.variant === "5h" &&
      state.status === "rate-limited" &&
      state.isColdStart === true &&
      this.lastOkData !== null
    ) {
      this.renderIdleWithLastUsage(this.lastOkData, this.lastOkFetchedAt);
      return;
    }

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

  /** Render the "Idle with last usage" skin: same bar + percent layout
   * as the ok state, dimmed to gray and suffixed with `Idle`. Tooltip
   * keeps showing the real cached tooltip so hovering during idle still
   * gives full context, with a leading stale-data disclosure line so
   * the dimmed widget is never read as live. */
  private renderIdleWithLastUsage(
    data: TData,
    fetchedAt: number | null
  ): void {
    const d = this.descriptor;
    const pct = d.getDisplayPct(data);
    const mode = getDisplayMode();
    const bar5 = d.renderBar(pct, 5);
    const bar10 = d.renderBar(pct, 10);

    this.item.text = `${d.formatText(mode, pct, bar5, bar10)} Idle`;
    const baseTooltip = d.buildTooltip(data);
    const idleTooltip = new vscode.MarkdownString();
    idleTooltip.isTrusted = baseTooltip.isTrusted;
    idleTooltip.supportThemeIcons = baseTooltip.supportThemeIcons;
    // `supportHtml` is required for the full/compact mode HTML markup
    // and the minimal-mode `&nbsp;` spacing both Claude and Codex
    // tooltips use. Missing this flag renders the entity references
    // as literal `&nbsp;` text rather than the intended layout.
    idleTooltip.supportHtml = baseTooltip.supportHtml;
    const ageLabel =
      fetchedAt !== null ? formatAge(Date.now() - fetchedAt) : "earlier";
    // Lead the tooltip with a stale-data disclosure so the dimmed widget
    // is never misread as live. Resumes automatically on the next
    // activity-driven kickstart - no user action required.
    idleTooltip.appendMarkdown(
      `Idle (cold-poll absorbed). Last updated ${ageLabel}.\n\n`
    );
    idleTooltip.appendMarkdown(baseTooltip.value);
    this.item.tooltip = idleTooltip;
    this.item.color = IDLE_DIM_COLOR;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Format an elapsed-ms duration as a short human label for the idle
 * tooltip ("12s ago", "3m ago", "1h 22m ago"). Granularity matches what
 * a user sees on a status-bar hover - no decimals, single-unit for
 * sub-minute, two-unit for hours. Negative inputs (clock skew on
 * cached `fetchedAt`) clamp to "just now." */
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
