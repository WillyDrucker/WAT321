import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import { prefixForMode } from "./sessionTokenPrefix";
import { buildSessionTokenTooltip } from "./sessionTokenTooltip";
import { getSessionTokenColor } from "./textColors";
import { formatPct, formatTokens } from "./tokenFormatters";

/**
 * Config-driven session token widget. Mirrors the UsageWidget
 * descriptor pattern: each provider supplies a thin descriptor with
 * provider-specific callbacks, and this class handles the shared
 * lifecycle (StatusBarItem creation, not-installed/no-session/waiting
 * states, display-mode formatting, color thresholds, tooltip build).
 */

/** Fields the descriptor must extract from its provider-specific
 * session object for the shared rendering logic. */
export interface SessionTokenRenderData {
  sessionTitle: string;
  label: string;
  modelId: string;
  contextUsed: number;
  contextWindowSize: number;
  /** Ceiling in tokens (auto-compact trigger for Claude, effective
   * context window for Codex). */
  ceiling: number;
  /** Tokens subtracted from both sides before computing pct.
   * Codex passes 12,000; Claude passes 0. */
  baselineTokens: number;
  /** When present, tooltip shows "Last active: X ago". */
  lastActiveAt?: number;
}

export interface SessionTokenWidgetDescriptor<TState extends { status: string }> {
  id: string;
  name: string;
  slot: number;
  provider: "Claude" | "Codex";
  /** White/yellow warn thresholds for `getSessionTokenColor`. */
  whitePct: number;
  yellowPct: number;
  /** Extract render data from an ok state. Only called when
   * `status === "ok"`. */
  getRenderData(state: TState & { status: "ok" }): SessionTokenRenderData;
}

export class SessionTokenWidget<TState extends { status: string }> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: SessionTokenWidgetDescriptor<TState>;

  constructor(descriptor: SessionTokenWidgetDescriptor<TState>) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = `WAT321: ${descriptor.provider} Session Tokens`;
    this.item.text = `${prefixForMode()} ${descriptor.provider} -`;
    this.item.tooltip = `No active ${descriptor.provider} session`;
  }

  update(state: TState): void {
    switch (state.status) {
      case "not-installed":
        this.item.hide();
        break;

      case "no-session":
      case "waiting":
        this.item.text = `${prefixForMode()} ${this.descriptor.provider} -`;
        this.item.tooltip = `No active ${this.descriptor.provider} session`;
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const d = this.descriptor;
        const data = d.getRenderData(state as TState & { status: "ok" });

        const effectiveCeiling = Math.max(0, data.ceiling - data.baselineTokens);
        const effectiveUsed = Math.max(0, data.contextUsed - data.baselineTokens);
        const pctOfCeiling = effectiveCeiling > 0
          ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
          : 0;

        const mode = getDisplayMode();
        const prefix = prefixForMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} ${d.provider} ${formatTokens(data.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `${prefix} ${d.provider} ${formatTokens(data.contextUsed)} / ${formatTokens(data.ceiling)} ${formatPct(pctOfCeiling)}`;
        }

        this.item.color = getSessionTokenColor(pctOfCeiling, d.whitePct, d.yellowPct);

        this.item.tooltip = buildSessionTokenTooltip({
          provider: d.provider,
          sessionTitle: data.sessionTitle,
          label: data.label,
          modelId: data.modelId,
          contextUsed: data.contextUsed,
          contextWindowSize: data.contextWindowSize,
          ceiling: data.ceiling,
          baselineTokens: data.baselineTokens,
          lastActiveAt: data.lastActiveAt,
        });
        this.item.show();
        break;
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
