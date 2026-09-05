import * as vscode from "vscode";
import type { CodexEffortLevel } from "../../engine/bridgeTypes";
import {
  getCodexModelInfo,
  listCodexEffortLevelsAcrossModels,
} from "../../shared/providers/codex/models";
import { shortenForRow } from "./codexDefaultsBaseline";
import { EPIC_HANDSHAKE_MENU_TEXT, type PickResult } from "../statusBar/menuActions";
import { makeBackItem, makeCancelItem, makePauseResumeItem } from "../../shared/ui/menuRows";
import { isPaused, setPaused } from "../statusBar/statusBarState";

/**
 * The Codex effort picker, opened from the Codex Model Settings picker.
 *
 * Rows mirror the SELECTED model's own advertised effort list, so newer
 * levels (`max` and `ultra` on Astra and the 5.6 family) surface without a
 * code change and stay hidden on models that reject them. A model no
 * source describes yet (a slug pinned by hand before Codex lists it)
 * gets every level any known model advertises, marked unverified,
 * because refusing to offer `max` to GPT-6 Astra on its first day would
 * be the wrong kind of caution. With nothing known at all, the quartet
 * every model has ever shared.
 *
 * Callers must pass the EFFECTIVE model, not the raw override: a null
 * slug collapses the rows to the fallback and hides `max` / `ultra`
 * from anyone running the config default.
 *
 * Sandbox is a top-level row in the parent picker rather than nested
 * here, so this picker stays on the single "how hard Codex thinks" axis.
 */

type RowKind = "back" | "value" | "pause" | "resume" | "cancel";

interface EffortRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  effort?: CodexEffortLevel;
}

const FALLBACK_QUARTET: { effort: CodexEffortLevel; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning." },
  { effort: "medium", description: "Balanced speed and depth." },
  { effort: "high", description: "Greater reasoning depth." },
  { effort: "xhigh", description: "Extra-high reasoning depth." },
];

export async function pickEffort(
  current: CodexEffortLevel | null,
  modelSlug: string | null
): Promise<PickResult<CodexEffortLevel | null>> {
  const modelInfo = modelSlug !== null ? getCodexModelInfo(modelSlug) : null;
  const advertised =
    modelInfo !== null && modelInfo.supportedEfforts.length > 0
      ? modelInfo.supportedEfforts
      : null;
  const acrossModels = advertised === null ? listCodexEffortLevelsAcrossModels() : [];
  const unverified = advertised === null && acrossModels.length > 0;
  const supported: { effort: CodexEffortLevel; description: string }[] =
    advertised ?? (unverified ? acrossModels : FALLBACK_QUARTET);

  const baseline: CodexEffortLevel | null =
    (modelInfo?.defaultEffort as CodexEffortLevel | undefined) ?? "medium";

  const pauseItem = makePauseResumeItem(isPaused(), EPIC_HANDSHAKE_MENU_TEXT);
  const cancelItem = makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT);

  const items: EffortRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    ...supported.map((e): EffortRow => {
      const isDefault = e.effort === baseline;
      const isCurrent =
        e.effort === current || (current === null && e.effort === baseline);
      const checkPrefix = isCurrent ? "✔️ " : "";
      const tagSuffix = isDefault ? " *default*" : "";
      const shortDescription = shortenForRow(e.description);
      const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
      return {
        rowKind: "value",
        effort: e.effort,
        label: `${checkPrefix}${e.effort.toUpperCase()}${tagSuffix}${descSuffix}`,
        iconPath: new vscode.ThemeIcon("dashboard"),
      };
    }),
    { ...pauseItem, rowKind: pauseItem.action === "resume" ? "resume" : "pause" },
    { ...cancelItem, rowKind: "cancel" },
  ];

  const modelName = modelInfo?.displayName ?? modelSlug;
  const pick = await vscode.window.showQuickPick<EffortRow>(items, {
    title:
      modelName === null
        ? "Codex effort"
        : `Effort for ${modelName}${unverified ? " (levels unverified for this model)" : ""}`,
    placeHolder: "Pick an effort level",
  });
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "value" && pick.effort !== undefined) {
    return { kind: "picked", value: pick.effort };
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
