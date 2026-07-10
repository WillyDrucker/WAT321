import * as vscode from "vscode";
import type { CodexEffortLevel } from "../engine/bridgeTypes";
import {
  getCodexModelInfo,
  listSelectableCodexModels,
} from "../shared/providers/codex/models";
import { baselineModel, shortenForRow } from "./codexDefaultsBaseline";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
} from "./menuCommon";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Sub-pickers spawned from the Codex Model Settings parent picker:
 *   - `pickModel`: every non-hidden model the running app-server
 *     advertises, from the live `model/list` catalog. Active row gets a
 *     ✔️ prefix - rows matching the codex config.toml baseline get a
 *     trailing `*default*` tag.
 *   - `pickEffort`: the SELECTED model's own advertised effort list, so
 *     newer levels (`max` and `ultra` on the GPT-5.6 family) surface
 *     without a code change and stay hidden on models that reject them.
 *     Falls back to the low/medium/high/xhigh quartet common to every
 *     model when no model resolves or it advertises no supported set.
 *     Same ✔️ + `*default*` conventions.
 *
 * Callers must pass the EFFECTIVE model to `pickEffort`, not the raw
 * override: a null slug collapses the rows to the quartet and hides
 * `max` / `ultra` from anyone running the config default.
 *
 * Both return a `PickResult<TValue>` discriminated union so the
 * parent can distinguish "user picked a new value" from "user
 * cancelled / paused / went back".
 */

export type PickResult<TValue> =
  | { kind: "cancelled" }
  | { kind: "picked"; value: TValue };

type RowKind = "back" | "value" | "pause" | "resume" | "cancel";

interface ModelRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  slug?: string;
}

interface EffortPickerRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  effort?: CodexEffortLevel;
}

export async function pickModel(
  current: string | null
): Promise<PickResult<string | null>> {
  const models = listSelectableCodexModels();
  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      "Epic Handshake: Codex's local models cache is empty, so the model picker has nothing to list yet. The cache populates whenever Codex runs."
    );
    return { kind: "cancelled" };
  }

  const baseline = baselineModel();
  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, false);
  const cancelItem = makeCancelItem(false);

  const items: ModelRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    ...models.map((m): ModelRow => {
      const isDefault = m.slug === baseline;
      const isCurrent =
        m.slug === current || (current === null && m.slug === baseline);
      // Active row gets a leading green check after the iconPath -
      // *default* still tags the trailing slot so the user can see
      // at a glance whether the active pick matches the baseline.
      const checkPrefix = isCurrent ? "✔️ " : "";
      const tagSuffix = isDefault ? " *default*" : "";
      // Description trimmed to first sentence so the row label does
      // not get truncated mid-word in narrow QuickPick layouts.
      const shortDescription = shortenForRow(m.description);
      const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
      return {
        rowKind: "value",
        slug: m.slug,
        label: `${checkPrefix}${m.displayName.toUpperCase()}${tagSuffix}${descSuffix}`,
        iconPath: new vscode.ThemeIcon("symbol-method"),
      };
    }),
    {
      ...pauseItem,
      rowKind: pauseItem.action === "resume" ? "resume" : "pause",
    },
    { ...cancelItem, rowKind: "cancel" },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<ModelRow>(items, {
      title: "Codex model",
      placeHolder: "Pick a model",
    })
  );
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "value" && pick.slug !== undefined) {
    return { kind: "picked", value: pick.slug };
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

/** Sandbox is a top-level row in the parent picker rather than
 * nested here - this picker stays focused on the single "how hard
 * Codex thinks" axis. Effort picks return immediately so the new
 * value re-renders in the parent. */
export async function pickEffort(
  current: CodexEffortLevel | null,
  modelSlug: string | null
): Promise<PickResult<CodexEffortLevel | null>> {
  const modelInfo = modelSlug !== null ? getCodexModelInfo(modelSlug) : null;
  // Mirrored verbatim from the selected model's advertised levels. No
  // whitelist stands between the cache and the rows, so a level Codex
  // adds appears the moment its cache carries it.
  const supported: { effort: CodexEffortLevel; description: string }[] =
    modelInfo !== null && modelInfo.supportedEfforts.length > 0
      ? modelInfo.supportedEfforts.map((e) => ({
          effort: e.effort,
          description: e.description,
        }))
      : [
          { effort: "low", description: "Fast responses with lighter reasoning." },
          { effort: "medium", description: "Balanced speed and depth." },
          { effort: "high", description: "Greater reasoning depth." },
          { effort: "xhigh", description: "Extra-high reasoning depth." },
        ];

  const baseline: CodexEffortLevel | null =
    (modelInfo?.defaultEffort as CodexEffortLevel | undefined) ?? "medium";

  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, false);
  const cancelItem = makeCancelItem(false);

  const items: EffortPickerRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    ...supported.map((e): EffortPickerRow => {
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
    {
      ...pauseItem,
      rowKind: pauseItem.action === "resume" ? "resume" : "pause",
    },
    { ...cancelItem, rowKind: "cancel" },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<EffortPickerRow>(items, {
      title:
        modelInfo !== null
          ? `Effort for ${modelInfo.displayName}`
          : "Codex effort",
      placeHolder: "Pick an effort level",
    })
  );
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
