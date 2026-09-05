import * as vscode from "vscode";
import { getCodexModelInfo } from "../../shared/providers/codex/models";
import { ensureCodexCatalog } from "./codexCatalogRefresh";
import {
  baselineEffort,
  capitalizeFirst,
  currentWorkspacePathOrSentinel,
  currentWsHash,
  effortRowLabel,
  everythingAtDefault,
  modelRowDescription,
  modelRowLabel,
  retirementNote,
  sandboxIsDefault,
} from "./codexDefaultsBaseline";
import { pickEffort } from "./codexEffortPicker";
import { pickModel } from "./codexModelPicker";
import {
  readCodexSandboxOverride,
  sandboxHasBeenTouched,
  writeCodexSandboxOverride,
} from "./codexRuntimeOverrides";
import {
  readSessionPin,
  writeSessionEffort,
  writeSessionModel,
} from "./codexSessionSettings";
import { EPIC_HANDSHAKE_MENU_TEXT, type ActionContext, type DispatchAction } from "../statusBar/menuActions";
import { makeBackItem, makeCancelItem, makePauseResumeItem } from "../../shared/ui/menuRows";
import { epicHandshakeLogger } from "../epicHandshakeLogger";
import { isPaused, setPaused } from "../statusBar/statusBarState";

/**
 * Combined "Codex Model Settings" picker - one entry point for all
 * three values the bridge passes on every `turn/start`:
 *   - sandbox  (Full-Access | Read-Only)
 *   - model    (any non-hidden slug the running app-server advertises,
 *              re-asked when the answer is old or on the REFRESH row,
 *              with a retirement notice on models OpenAI is winding down)
 *   - effort   (whatever the SELECTED model advertises, so `max` and
 *              `ultra` appear only on the models that advertise them)
 *
 * Each row shows the current value. `*default*` marks rows matching
 * CODEX's own recommendation: `model/list`'s `isDefault` model, that
 * model's `defaultReasoningEffort`, and a read-only sandbox. Nothing
 * here is a default of WAT321's, and `~/.codex/config.toml` is not
 * read. A leading green check (✔️) marks the active selection inside
 * sub-pickers.
 *
 * Sandbox is a direct toggle (no sub-picker) - one click flips
 * between full-access and read-only. Model and effort open sub-
 * pickers because each has multiple options.
 *
 * Scope differs by row, and the difference is deliberate. Sandbox is a
 * safety posture for a FOLDER, stored in a per-workspace flag file.
 * Model and effort belong to the SESSION, stored on its
 * `BridgeThreadRecord`, so S1 keeps what the user last chose across
 * restarts and S2 starts fresh on Codex's recommendation. See
 * `codexSessionSettings.ts`.
 *
 * Sub-pickers + baseline/label helpers live in sibling files
 * (`codexModelPicker.ts`, `codexEffortPicker.ts`,
 * `codexDefaultsBaseline.ts`).
 */

type DefaultsRow = vscode.QuickPickItem & {
  row: "model" | "effort" | "sandbox" | "back" | "pause" | "resume" | "cancel";
};

/** Headline for the "CODEX MODEL SETTINGS" row in the sessions
 * submenu. Capitalized "Default" suffix when every override matches
 * the baseline - otherwise just "CODEX MODEL SETTINGS" so users can
 * tell at a glance whether anything is overridden. */
export function codexDefaultsHeadline(): string {
  return everythingAtDefault()
    ? "CODEX MODEL SETTINGS: Default"
    : "CODEX MODEL SETTINGS";
}

/** Sub-line for the row. Lowercase dot-separated sandbox / model /
 * effort with the live current values. Lets the user verify what
 * the bridge will send without opening the picker. */
export function codexDefaultsSubline(): string {
  const sandbox = readCodexSandboxOverride(currentWsHash());
  const pin = readSessionPin(currentWorkspacePathOrSentinel());
  // Each segment uses native casing: sandbox words like "Read-Only" /
  // "Full-Access", model display name preserves its capitalization
  // (GPT-5.6 Sol), effort starts capital (Low). Keeps the subline
  // scannable without a wall of lowercase that hides boundaries.
  const sandboxLabel = sandbox === "full-access" ? "Full-Access" : "Read-Only";
  const modelInfo = pin.model === null ? null : getCodexModelInfo(pin.model);
  const modelLabel =
    pin.model === null ? "default" : (modelInfo?.displayName ?? pin.model);
  const modelMark = retirementNote(modelInfo) !== null ? "⚠ " : "";
  const effort = pin.effort ?? baselineEffort();
  const effortLabel = effort === null ? "Default" : capitalizeFirst(effort);
  return `${sandboxLabel} · ${modelMark}${modelLabel} · ${effortLabel}`;
}

export async function showCodexDefaultsPicker(
  dispatch: DispatchAction,
  ctx: ActionContext
): Promise<void> {
  // Ask Codex what it can run before drawing any row. Opening this
  // picker IS the user asking which models exist, so it is the honest
  // place to pay for the answer. Usually free (memory or sidecar). On a
  // first run, or once the last answer is old enough that a model
  // switched on for this account could be missing, it spawns a
  // short-lived app-server, which is why the wait is announced rather
  // than silent. A failure here is not fatal - the rows fall back to
  // the last answer, then to `~/.codex/models_cache.json`.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "WAT321: reading Codex models",
    },
    () => ensureCodexCatalog(epicHandshakeLogger())
  );

  // Looped so each sub-picker (model, effort) returns to the
  // combined picker, letting the user adjust multiple defaults in
  // one session without re-clicking the bridge widget. Loop exits
  // on BACK or QuickPick dismiss. Sandbox is an inline toggle so it
  // never opens a sub-picker - the loop re-renders with the new state.
  const wsHash = currentWsHash();
  const workspacePath = currentWorkspacePathOrSentinel();
  while (true) {
    const { model, effort } = readSessionPin(workspacePath);
    const sandbox = readCodexSandboxOverride(wsHash);

    const paused = isPaused();
    const pauseItem = makePauseResumeItem(paused, EPIC_HANDSHAKE_MENU_TEXT);
    const cancelItem = makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT);

    // Sandbox lives at the top level rather than nested inside
    // Effort because read-only vs full-access is the highest-
    // frequency adjustment for many users (per-session safety
    // toggle) - burying it one menu deep adds friction.
    const sandboxLabel = sandbox === "full-access" ? "FULL-ACCESS" : "READ-ONLY";
    const sandboxNext = sandbox === "full-access" ? "READ-ONLY" : "FULL-ACCESS";
    // *default* tag means "pristine slot" - the user hasn't picked
    // a sandbox value yet. Once they click the row even once, the
    // touched sentinel records the choice and the tag stays off
    // forever (until Reset). Without this, picking read-only
    // explicitly would re-render *default* and read as "you haven't
    // done anything" when the user just made a choice.
    const sandboxDefaultTag =
      sandboxIsDefault(sandbox) && !sandboxHasBeenTouched(wsHash)
        ? " *default*"
        : "";

    const items: DefaultsRow[] = [
      { ...makeBackItem(), row: "back" },
      {
        label: modelRowLabel(model),
        description: modelRowDescription(model),
        iconPath: new vscode.ThemeIcon("symbol-method"),
        row: "model",
      },
      {
        label: effortRowLabel(effort),
        description: "Click to change effort.",
        iconPath: new vscode.ThemeIcon("dashboard"),
        row: "effort",
      },
      {
        label: `SANDBOX PERMISSION: ${sandboxLabel}${sandboxDefaultTag}`,
        description: `Click to switch to ${sandboxNext}.`,
        iconPath: new vscode.ThemeIcon("shield"),
        row: "sandbox",
      },
      {
        ...pauseItem,
        row: pauseItem.action === "resume" ? "resume" : "pause",
      },
      { ...cancelItem, row: "cancel" },
    ];

    const pick = await vscode.window.showQuickPick<DefaultsRow>(items, {
      title: "Codex Model Settings",
      placeHolder: "Pick a setting to change",
    });
    if (!pick) return;
    if (pick.row === "back") {
      // Walk back to the sessions submenu (this picker's parent),
      // not straight to main. Honors the user's expectation that
      // BACK unwinds one level rather than closing the whole stack.
      await dispatch("manage-sessions", ctx);
      return;
    }

    if (pick.row === "model") {
      const result = await pickModel(model);
      // Picking a model resets effort to that model's own default, since
      // effort levels are model-scoped. `writeSessionModel` owns that
      // rule so every caller gets it.
      if (result.kind === "picked" && result.value !== null) {
        writeSessionModel(workspacePath, result.value);
      }
      continue;
    }
    if (pick.row === "effort") {
      // `model` here is the session's effective model, never null unless
      // no catalog has answered at all. The effort picker narrows its rows
      // to that model's advertised levels, so passing an unresolved value
      // would drop the rows to the lowest common quartet and hide `max`
      // and `ultra` from a session running 5.6 Sol.
      const result = await pickEffort(effort, model);
      if (result.kind === "picked") writeSessionEffort(workspacePath, result.value);
      continue;
    }
    if (pick.row === "sandbox") {
      writeCodexSandboxOverride(
        wsHash,
        sandbox === "full-access" ? "read-only" : "full-access"
      );
      continue;
    }
    if (pick.row === "pause") {
      setPaused(true);
      return;
    }
    if (pick.row === "resume") {
      setPaused(false);
      continue;
    }
    if (pick.row === "cancel") {
      // Route cancel through the parent dispatch so the standard
      // cancel handler runs (writes the cancel sentinel, etc). No
      // turn can be in flight here since the entry guard locks
      // during in-flight, but we still go through the canonical
      // flow so toasts and flag writes match every other CANCEL
      // row in the menu vocabulary.
      await dispatch("cancel", ctx);
      return;
    }
  }
}
