import * as vscode from "vscode";
import { codexCatalogAgeMs } from "../../shared/providers/codex/modelCatalog";
import {
  defaultCodexModelSlug,
  getCodexModelInfo,
  listKnownCodexSlugs,
  listSelectableCodexModels,
  listUnlistedCodexModels,
  type CodexModelInfo,
} from "../../shared/providers/codex/models";
import { rememberUnlistedPin } from "../../shared/providers/codex/unlistedModelPins";
import { refreshCodexCatalog } from "./codexCatalogRefresh";
import {
  baselineModel,
  retirementNote,
  shortenForRow,
} from "./codexDefaultsBaseline";
import { EPIC_HANDSHAKE_MENU_TEXT, type PickResult } from "../statusBar/menuActions";
import { makeBackItem, makeCancelItem, makePauseResumeItem, makeSeparator } from "../../shared/ui/menuRows";
import { epicHandshakeLogger } from "../epicHandshakeLogger";
import { isPaused, setPaused } from "../statusBar/statusBarState";

/**
 * The Codex model picker, opened from the Codex Model Settings picker.
 *
 * Rows come from the live `model/list` catalog: first the models Codex
 * itself shows, then under an Unlisted heading the ones it hides from
 * its own picker plus any slug the user pinned by hand. The active row
 * gets a ✔️ prefix, the row Codex marks `isDefault` a `*default*` tag,
 * and a model OpenAI is retiring a ⚠ plus the successor Codex names.
 * That tag names Codex's recommendation, never a default of WAT321's and
 * never this machine's `config.toml`.
 *
 * Two rows exist for the day a model goes live for this account: PIN A
 * MODEL BY SLUG takes a slug Codex has not sent yet (GPT-6 Astra shipped
 * hidden from every picker), and REFRESH MODELS asks the app-server
 * again on the spot.
 *
 * Returns a `PickResult<string | null>` so the parent can distinguish
 * "user picked a model" from "user cancelled / paused / went back".
 */

type RowKind = "back" | "value" | "pin" | "refresh" | "pause" | "resume" | "cancel";

interface ModelRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  slug?: string;
}

function modelRow(m: CodexModelInfo, current: string | null, baseline: string | null): ModelRow {
  const isDefault = m.slug === baseline;
  const isCurrent = m.slug === current || (current === null && m.slug === baseline);
  // Active row gets a leading green check after the iconPath -
  // *default* still tags the trailing slot so the user can see at a
  // glance whether the active pick matches the baseline.
  const checkPrefix = isCurrent ? "✔️ " : "";
  const tagSuffix = isDefault ? " *default*" : "";
  // A retirement notice outranks the marketing description: the row's
  // job is to keep the user off a model that is going away.
  const retiring = retirementNote(m);
  const warnPrefix = retiring === null ? "" : "⚠ ";
  const shortDescription = retiring ?? shortenForRow(m.description);
  const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
  return {
    rowKind: "value",
    slug: m.slug,
    label: `${checkPrefix}${warnPrefix}${m.displayName.toUpperCase()}${tagSuffix}${descSuffix}`,
    iconPath: new vscode.ThemeIcon("symbol-method"),
  };
}

/** Take a slug by hand. A slug the catalog already carries, hidden or
 * not, pins without ceremony. Anything else asks once, then pins with
 * the API left to give the real answer on the next prompt. */
async function pinModelBySlug(): Promise<string | null> {
  const typed = await vscode.window.showInputBox({
    title: "Pin a Codex model by slug",
    prompt:
      "Type the slug exactly as Codex names it, for example gpt-6-astra. For a model OpenAI has enabled for your account that Codex keeps out of its picker.",
    placeHolder: "model slug",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Slug cannot be empty";
      if (/\s/.test(trimmed)) return "Slug cannot contain whitespace";
      return null;
    },
  });
  if (typed === undefined) return null;
  const slug = typed.trim();
  if (listKnownCodexSlugs().includes(slug)) return slug;

  const choice = await vscode.window.showWarningMessage(
    `Codex does not list "${slug}" for this account yet. Pin it anyway? The next prompt to Codex shows whether your account can run it, and the pin drops on its own once Codex lists the model.`,
    "Pin it",
    "Cancel"
  );
  if (choice !== "Pin it") return null;
  rememberUnlistedPin(slug);
  return slug;
}

/** Re-ask the app-server and tell the user what came back. The toast is
 * the point: someone pressing REFRESH is looking for a model that is not
 * there yet, and "Codex lists 6 models" answers that where a silent
 * redraw would not. A failed probe keeps the previous answer in place,
 * so success is read off the catalog's age rather than its size. */
async function refreshModelsWithFeedback(): Promise<void> {
  const ageBefore = codexCatalogAgeMs();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "WAT321: reading Codex models",
    },
    () => refreshCodexCatalog(epicHandshakeLogger())
  );
  const models = listSelectableCodexModels();
  if (models.length === 0 || codexCatalogAgeMs() >= ageBefore) {
    void vscode.window.showWarningMessage(
      "Epic Handshake: Codex could not be reached, so the model list could not be refreshed. Showing the last known list."
    );
    return;
  }
  const unlisted = listUnlistedCodexModels().length;
  const dflt = defaultCodexModelSlug();
  const dfltName =
    dflt === null ? null : (getCodexModelInfo(dflt)?.displayName ?? dflt);
  void vscode.window.showInformationMessage(
    `Epic Handshake: Codex lists ${models.length} model${models.length === 1 ? "" : "s"}${
      unlisted > 0 ? ` plus ${unlisted} unlisted` : ""
    }${dfltName === null ? "" : `, default ${dfltName}`}.`
  );
}

export async function pickModel(
  current: string | null
): Promise<PickResult<string | null>> {
  // Looped so REFRESH and PIN redraw the rows in place instead of
  // dropping the user back to the parent picker.
  while (true) {
    const models = listSelectableCodexModels();
    const unlisted = listUnlistedCodexModels();
    // With nothing listed the picker still opens: REFRESH and PIN are
    // the only ways out of an empty catalog, so they cannot hide
    // behind it.
    const nothingListed = models.length === 0 && unlisted.length === 0;

    const baseline = baselineModel();
    const pauseItem = makePauseResumeItem(isPaused(), EPIC_HANDSHAKE_MENU_TEXT);
    const cancelItem = makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT);

    const items: ModelRow[] = [
      { ...makeBackItem(), rowKind: "back" },
      ...models.map((m) => modelRow(m, current, baseline)),
      ...(unlisted.length > 0
        ? [
            { ...makeSeparator("Unlisted by Codex"), rowKind: "value" as const },
            ...unlisted.map((m) => modelRow(m, current, baseline)),
          ]
        : []),
      {
        rowKind: "pin",
        label: "⌨️ PIN A MODEL BY SLUG",
        description: "Type a slug Codex has not listed yet, such as gpt-6-astra.",
        iconPath: new vscode.ThemeIcon("edit"),
      },
      {
        rowKind: "refresh",
        label: "🔄 REFRESH MODELS",
        description:
          "Ask Codex again. New models appear as OpenAI enables them for your account.",
        iconPath: new vscode.ThemeIcon("refresh"),
      },
      { ...pauseItem, rowKind: pauseItem.action === "resume" ? "resume" : "pause" },
      { ...cancelItem, rowKind: "cancel" },
    ];

    const pick = await vscode.window.showQuickPick<ModelRow>(items, {
      title: "Codex model",
      placeHolder: nothingListed
        ? "Codex has not listed any model yet. Refresh, or pin a slug by hand."
        : "Pick a model",
    });
    if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
    if (pick.rowKind === "value" && pick.slug !== undefined) {
      return { kind: "picked", value: pick.slug };
    }
    if (pick.rowKind === "pin") {
      const slug = await pinModelBySlug();
      if (slug !== null) return { kind: "picked", value: slug };
      continue;
    }
    if (pick.rowKind === "refresh") {
      await refreshModelsWithFeedback();
      continue;
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
}
