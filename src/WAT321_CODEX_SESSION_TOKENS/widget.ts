import * as vscode from "vscode";
import type { CodexTokenWidgetState, StatusBarWidget } from "./types";
import { CODEX_BASELINE_TOKENS } from "./autoCompactLimit";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { buildSessionTokenTooltip } from "../shared/ui/sessionTokenTooltip";
import { getDisplayMode } from "../shared/displayMode";
import { getSessionTokenColor } from "../shared/ui/heatmap";
import { prefixForMode } from "../shared/ui/sessionTokenPrefix";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";

export class CodexSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.codexSessionTokens)
    );
    this.item.name = "WAT321: Codex Session Tokens";
    this.item.text = `${prefixForMode()} Codex -`;
    this.item.tooltip = "No active Codex session";
    // First state delivered by subscribe() decides visibility.
  }

  update(state: CodexTokenWidgetState): void {
    switch (state.status) {
      case "not-installed":
        // Codex CLI is not installed - hide widget entirely
        this.item.hide();
        break;

      case "no-session":
      case "waiting":
        this.item.text = `${prefixForMode()} Codex -`;
        this.item.tooltip = "No active Codex session";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const { session } = state;
        // Baseline normalization matches Codex native's formula:
        // subtract CODEX_BASELINE_TOKENS from both sides so a fresh
        // session reads near 0% instead of ~5%.
        const effectiveCeiling = session.autoCompactTokens - CODEX_BASELINE_TOKENS;
        const effectiveUsed = Math.max(0, session.contextUsed - CODEX_BASELINE_TOKENS);
        const usedPct = effectiveCeiling > 0
          ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
          : 0;

        const mode = getDisplayMode();
        const prefix = prefixForMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} Codex ${formatTokens(session.contextUsed)} ${formatPct(usedPct)}`;
        } else {
          this.item.text =
            `${prefix} Codex ${formatTokens(session.contextUsed)} / ` +
            `${formatTokens(session.autoCompactTokens)} ${formatPct(usedPct)}`;
        }

        // Warn thresholds 85/90 tuned so yellow appears ~2-4 turns
        // before compact fires.
        this.item.color = getSessionTokenColor(usedPct, 85, 90);

        this.item.tooltip = buildSessionTokenTooltip({
          provider: "Codex",
          sessionTitle: session.sessionTitle,
          label: session.label,
          modelId: session.modelSlug,
          contextUsed: session.contextUsed,
          contextWindowSize: session.contextWindowSize,
          ceiling: session.autoCompactTokens,
          baselineTokens: CODEX_BASELINE_TOKENS,
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
