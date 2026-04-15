import * as vscode from "vscode";
import type { CodexTokenWidgetState, StatusBarWidget } from "./types";
import { CodexSessionTokenService } from "./service";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { buildSessionTokenTooltip } from "../shared/ui/sessionTokenTooltip";
import { getDisplayMode } from "../shared/displayMode";
import { getSessionTokenColor } from "../shared/ui/heatmap";
import { prefixForMode } from "../shared/ui/sessionTokenPrefix";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";

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
        // Match Codex native's `percent_of_context_window_remaining`
        // from codex-rs/protocol/src/protocol.rs which subtracts a
        // 12,000-token baseline (`prompts, tools and space to call
        // compact`) from both numerator and denominator. Normalizes
        // the percentage so a fresh session starts near 0% used
        // rather than ~5% from the baseline overhead, and matches
        // the number shown in Codex's own hover byte-for-byte.
        const BASELINE_TOKENS = 12_000;
        const effectiveCeiling = session.autoCompactTokens - BASELINE_TOKENS;
        const effectiveUsed = Math.max(0, session.contextUsed - BASELINE_TOKENS);
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

        // Codex ceiling is the effective context window (258k for
        // gpt-5.x). Under the baseline-normalized formula above,
        // actual compact (244,800 tokens) reads as ~94% on the
        // display. 85 / 90 keeps the warn rungs close to the compact
        // point - yellow lands ~11k before compact (2-4 turns of
        // runway) while still leaving a visible white stage.
        this.item.color = getSessionTokenColor(usedPct, 85, 90);

        this.item.tooltip = buildSessionTokenTooltip({
          provider: "Codex",
          sessionTitle: session.sessionTitle,
          label: session.label,
          contextUsed: session.contextUsed,
          ceiling: session.autoCompactTokens,
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

export function activateCodexTokenWidget(
  service: CodexSessionTokenService
): vscode.Disposable[] {
  const widget = new CodexSessionTokensWidget();
  const listener = (state: CodexTokenWidgetState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
