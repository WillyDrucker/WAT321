import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";

/**
 * Encapsulates the red "! ARMED" status bar item surfaced while the
 * experimental Force Claude Auto-Compact service is armed. Peeled
 * out of the service so service.ts stays focused on the arm/disarm
 * state machine and this file owns every VS Code status bar surface
 * concern for the armed widget.
 *
 * The item is an error-severity banner: red background, white text,
 * red exclamation glyph prefix. Clicking it invokes
 * `CANCEL_COMMAND_ID`, which is wired by
 * `registerCancelExperimentalAutoCompactCommand` in `service.ts`
 * to the active service's `cancelFromWidget()` handler.
 */

/** Internal command id for the armed status bar item's click target.
 * NOT listed in `package.json contributes.commands` so it never
 * appears in the palette - it exists only as a click target on the
 * armed widget. */
export const CANCEL_COMMAND_ID = "wat321.cancelExperimentalAutoCompact";

/** Red exclamation glyph. Unicode U+2757 HEAVY EXCLAMATION MARK
 * renders as its own red emoji regardless of theme. Paired with the
 * `errorBackground` theme color on the item so the whole row reads
 * as a red error banner. */
const RED_EXCLAIM = "\u2757";

/** Idempotent wrapper around the armed status bar item. `show()`
 * constructs the item on first call and no-ops on subsequent calls
 * until `dispose()`. `dispose()` tears down the VS Code item and
 * resets internal state so a later `show()` creates a fresh one. */
export class ArmedStatusBarItem {
  private item: vscode.StatusBarItem | null = null;

  show(): void {
    if (this.item) return;
    const item = vscode.window.createStatusBarItem(
      "wat321.claudeAutoCompactArmed",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeAutoCompactArmed)
    );
    item.name = "WAT321: Claude Auto-Compact (Armed)";
    item.text = `${RED_EXCLAIM} ARMED`;
    // VS Code's StatusBarItem API only honors "prominent" theme
    // colors for foreground (statusBarItem.errorForeground,
    // warningForeground, prominentForeground). On default themes
    // statusBarItem.errorForeground is WHITE (intended to contrast
    // with errorBackground) which is why "ARMED" rendered white in
    // an earlier pass. Setting both color and backgroundColor gives
    // the sanctioned VS Code "error" look: dark-red banner with
    // contrasting white text, plus the red emoji prefix that renders
    // its own color on top of both.
    item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(
      "\u2757 Claude Auto-Compact - Armed\n\nYour Claude session will Auto-Compact on next prompt.\n\n**Click to disarm.**"
    );
    item.tooltip = tooltip;
    item.command = CANCEL_COMMAND_ID;
    item.show();
    this.item = item;
  }

  dispose(): void {
    if (!this.item) return;
    this.item.dispose();
    this.item = null;
  }
}
