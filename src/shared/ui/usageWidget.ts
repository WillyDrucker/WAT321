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

/** Foreground used by the cached-bars-on-error skin. Dim enough that
 * the widget reads as "paused, not live" against both dark and light
 * VS Code themes, but still legible. Applies to the entire item text -
 * bar emoji squares ignore item.color because they have their own
 * intrinsic color (only the codicon + number + suffix dim). Value
 * matches Tailwind `neutral-700` (~50% darker in luminance than the
 * prior `#7a7a7a` mid-gray) so the dimmed state is unmistakable
 * against the active state. */
const IDLE_DIM_COLOR = "#404040";

export class UsageWidget<TData> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: UsageWidgetDescriptor<TData>;
  /** Last `ok` payload observed. Cached so the cached-bars-on-error
   * skin can keep showing the previous usage bar + percent instead of
   * blanking to a generic pill on a transient error. Null until the
   * first ok state lands - on a brand-new install whose first poll
   * lands a transient error, this stays null and the renderer falls
   * through to the non-ok renderer's pill. Cleared on identity-changing
   * states (`not-connected`, `no-auth`, `token-expired`) so a user
   * signing out and into a different account never sees the previous
   * account's bars under the dimmed skin. */
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

    // Cache the last ok payload + its fetch time so the cached-bars-on-
    // error path can re-render the same bar + percent the user just saw,
    // only dimmed with a status suffix. Caching happens BEFORE any return
    // so a transient ok between two error polls still updates the cache.
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

    // Cached-bars-on-error skin (both 5h and weekly). For transient,
    // same-identity error states (rate-limited cold + warm, offline,
    // API error) keep the last-known bars + percent visible, dimmed,
    // with a short status suffix (`5% - Idle`) instead of dropping to
    // a generic pill that loses the numbers the user was just looking
    // at. Only fires when a cached ok payload exists. Identity-changing
    // states (not-connected, no-auth, token-expired) cleared the cache
    // above and fall through to their dedicated pill / hide treatment -
    // showing a prior account's stale bars there would be misleading.
    const transient = classifyTransientError(state);
    if (transient && this.lastOkData !== null) {
      this.renderCachedBarsWithError(
        this.lastOkData,
        this.lastOkFetchedAt,
        transient.label,
        transient.detail
      );
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

  /** Render the cached-bars-on-error skin: same bar + percent layout as
   * the ok state, dimmed to gray and suffixed with ` - {label}` (e.g.
   * `5% - Idle`, `5% - Offline`). Tooltip keeps showing the real cached
   * tooltip so hovering still gives full context, led by a stale-data
   * disclosure line (the supplied `detail` plus a "Last updated N ago")
   * so the dimmed widget is never read as live. */
  private renderCachedBarsWithError(
    data: TData,
    fetchedAt: number | null,
    label: string,
    detail: string
  ): void {
    const d = this.descriptor;
    const pct = d.getDisplayPct(data);
    const mode = getDisplayMode();
    const bar5 = d.renderBar(pct, 5);
    const bar10 = d.renderBar(pct, 10);

    this.item.text = `${d.formatText(mode, pct, bar5, bar10)} - ${label}`;
    const baseTooltip = d.buildTooltip(data);
    const staleTooltip = new vscode.MarkdownString();
    staleTooltip.isTrusted = baseTooltip.isTrusted;
    staleTooltip.supportThemeIcons = baseTooltip.supportThemeIcons;
    // `supportHtml` is required for the full/compact mode HTML markup
    // and the minimal-mode `&nbsp;` spacing both Claude and Codex
    // tooltips use. Missing this flag renders the entity references
    // as literal `&nbsp;` text rather than the intended layout.
    staleTooltip.supportHtml = baseTooltip.supportHtml;
    const ageLabel =
      fetchedAt !== null ? formatAge(Date.now() - fetchedAt) : "earlier";
    // Lead the tooltip with a stale-data disclosure so the dimmed widget
    // is never misread as live. Recovers automatically on the next
    // activity-driven kickstart / successful poll - no user action.
    staleTooltip.appendMarkdown(`${detail} Last updated ${ageLabel}.\n\n`);
    staleTooltip.appendMarkdown(baseTooltip.value);
    this.item.tooltip = staleTooltip;
    this.item.color = IDLE_DIM_COLOR;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Classify a service state as a transient, same-identity error that
 * should keep the cached bars visible (dimmed + status suffix) rather
 * than drop to a pill. Returns the status-bar suffix label + a one-line
 * tooltip detail, or null for states that must NOT show cached bars
 * (loading has nothing cached yet; not-connected / no-auth / token-
 * expired are identity-changing and already cleared the cache). The
 * caller still gates on `lastOkData !== null`. */
function classifyTransientError<TData>(
  state: GenericServiceState<TData>
): { label: string; detail: string } | null {
  switch (state.status) {
    case "rate-limited": {
      if (state.isColdStart === true) {
        return { label: "Idle", detail: "Idle (cold-poll absorbed)." };
      }
      // Warm throttle (a real rate-limit, not idle cold-poll). Keep the
      // status-bar suffix short but carry the actionable detail the old
      // pill showed - retry countdown + the upstream server message -
      // into the tooltip so the cached-bars skin stays as informative.
      const elapsed = Date.now() - state.rateLimitedAt;
      const remainingMin = Math.max(
        0,
        Math.ceil((state.retryAfterMs - elapsed) / 60_000)
      );
      const countdown =
        remainingMin > 0
          ? ` Reconnecting in up to ${remainingMin} minute${remainingMin !== 1 ? "s" : ""}.`
          : " Reconnecting.";
      const server = state.serverMessage ? ` API: ${state.serverMessage}.` : "";
      return {
        label: "Paused",
        detail: `Temporarily throttled.${countdown}${server}`,
      };
    }
    case "offline":
      return { label: "Offline", detail: "Network unavailable." };
    case "error":
      return { label: "Idle", detail: "Temporarily unavailable, retrying." };
    default:
      return null;
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
