import * as vscode from "vscode";
import type { CodexServiceTier } from "../../shared/providers/codex/modelCatalog";
import { shortenForRow } from "./codexDefaultsBaseline";
import { EPIC_HANDSHAKE_MENU_TEXT, type PickResult } from "../statusBar/menuActions";
import { makeBackItem, makeCancelItem, makePauseResumeItem } from "../../shared/ui/menuRows";
import { isPaused, setPaused } from "../statusBar/statusBarState";

/**
 * The Codex speed picker, opened from the Codex Model Settings picker
 * when the session's model offers more than one tier beyond standard.
 * Rows are standard plus every tier the model advertises, each with
 * Codex's own description, because a faster tier spends usage faster.
 * A single tier needs no picker: the Speed row toggles it in place.
 */

type RowKind = "back" | "value" | "pause" | "resume" | "cancel";

interface SpeedRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  /** The tier id, null for standard. */
  tier?: string | null;
}

function speedRow(
  tier: string | null,
  name: string,
  description: string,
  current: string | null,
  tag = ""
): SpeedRow {
  const checkPrefix = tier === current ? "✔️ " : "";
  const shortDescription = shortenForRow(description);
  const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
  return {
    rowKind: "value",
    tier,
    label: `${checkPrefix}${name.toUpperCase()}${tag}${descSuffix}`,
    iconPath: new vscode.ThemeIcon("zap"),
  };
}

/** `current` is the tier the session runs, null for standard. Picks
 * resolve to a tier id, or null for standard. */
export async function pickSpeed(
  tiers: readonly CodexServiceTier[],
  current: string | null
): Promise<PickResult<string | null>> {
  const pauseItem = makePauseResumeItem(isPaused(), EPIC_HANDSHAKE_MENU_TEXT);
  const cancelItem = makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT);
  const items: SpeedRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    speedRow(null, "Standard", "Standard speed and usage", current, " *default*"),
    ...tiers.map((t) => speedRow(t.id, t.name, t.description, current)),
    { ...pauseItem, rowKind: pauseItem.action === "resume" ? "resume" : "pause" },
    { ...cancelItem, rowKind: "cancel" },
  ];

  const pick = await vscode.window.showQuickPick<SpeedRow>(items, {
    title: "Codex speed",
    placeHolder: "Pick a speed",
  });
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "value" && pick.tier !== undefined) {
    return { kind: "picked", value: pick.tier };
  }
  if (pick.rowKind === "pause") {
    setPaused(true);
    return { kind: "cancelled" };
  }
  if (pick.rowKind === "resume") {
    setPaused(false);
    return { kind: "cancelled" };
  }
  return { kind: "cancelled" };
}
