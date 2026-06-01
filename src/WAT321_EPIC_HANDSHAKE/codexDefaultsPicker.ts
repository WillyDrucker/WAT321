import * as vscode from "vscode";
import {
  capitalizeFirst,
  configModelLabel,
  currentWsHash,
  effortRowLabel,
  everythingAtDefault,
  baselineEffort,
  modelRowLabel,
  sandboxIsDefault,
} from "./codexDefaultsBaseline";
import { pickEffort, pickModel } from "./codexDefaultsSubPickers";
import { getCodexModelInfo } from "../shared/providers/codex/models";
import {
  readCodexEffortOverride,
  readCodexModelOverride,
  readCodexSandboxOverride,
  sandboxHasBeenTouched,
  writeCodexEffortOverride,
  writeCodexModelOverride,
  writeCodexSandboxOverride,
} from "./codexRuntimeOverrides";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type ActionContext,
  type DispatchAction,
} from "./menuCommon";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Combined "Codex Model Settings" picker - one entry point for all
 * three per-turn overrides the bridge passes on every `turn/start`:
 *   - sandbox  (Full-Access | Read-Only)
 *   - model    (any visibility=list slug from `models_cache.json`)
 *   - effort   (low | medium | high | xhigh)
 *
 * Each row shows the current value. `*default*` marks rows that
 * match the platform baseline (sandbox=read-only, model=codex-config-
 * default, effort=model's own default-effort). A leading green check
 * (✔️) marks the active selection inside sub-pickers.
 *
 * Sandbox is a direct toggle (no sub-picker) - one click flips
 * between full-access and read-only. Model and effort open sub-
 * pickers because each has multiple options.
 *
 * No persistent settings: overrides live only in flag files under
 * `~/.wat321/epic-handshake/`. Reset WAT321 wipes them, so "default"
 * is the safe fallback after a reset. The codex config.toml supplies
 * the model baseline; a user who only wants to follow their codex
 * config never has to touch this picker - the absence of an override
 * means codex uses its own config.
 *
 * Sub-pickers + baseline/label helpers live in sibling files
 * (`codexDefaultsSubPickers.ts`, `codexDefaultsBaseline.ts`).
 */

type DefaultsRow = vscode.QuickPickItem & {
  row: "model" | "effort" | "sandbox" | "back" | "pause" | "resume" | "cancel";
};

/** Headline for the "CODEX MODEL SETTINGS" row in the sessions
 * submenu. Capitalized "Default" suffix when every override matches
 * the baseline; otherwise just "CODEX MODEL SETTINGS" so users can
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
  const wsHash = currentWsHash();
  const sandbox = readCodexSandboxOverride(wsHash);
  const model = readCodexModelOverride(wsHash);
  const effort = readCodexEffortOverride(wsHash);
  // Each segment uses native casing: sandbox words like "Read-Only" /
  // "Full-Access", model display name preserves its capitalization
  // (GPT-5.5), effort starts capital (Medium). Keeps the subline
  // scannable without a wall of lowercase that hides boundaries.
  const sandboxLabel = sandbox === "full-access" ? "Full-Access" : "Read-Only";
  const modelLabel =
    model === null
      ? configModelLabel()
      : (getCodexModelInfo(model)?.displayName ?? model);
  const effortLabel = capitalizeFirst(effort ?? baselineEffort() ?? "Medium");
  return `${sandboxLabel} · ${modelLabel} · ${effortLabel}`;
}

export async function showCodexDefaultsPicker(
  dispatch: DispatchAction,
  ctx: ActionContext
): Promise<void> {
  // Looped so each sub-picker (model, effort) returns to the
  // combined picker, letting the user adjust multiple defaults in
  // one session without re-clicking the bridge widget. Loop exits
  // on BACK or QuickPick dismiss. Sandbox is an inline toggle so it
  // never opens a sub-picker - the loop re-renders with the new state.
  const wsHash = currentWsHash();
  while (true) {
    const model = readCodexModelOverride(wsHash);
    const effort = readCodexEffortOverride(wsHash);
    const sandbox = readCodexSandboxOverride(wsHash);

    const paused = isPaused();
    const pauseItem = makePauseResumeItem(paused, false);
    const cancelItem = makeCancelItem(false);

    // Sandbox lives at the top level rather than nested inside
    // Effort because read-only vs full-access is the highest-
    // frequency adjustment for many users (per-session safety
    // toggle); burying it one menu deep adds friction.
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
        description: "Click to change model.",
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

    const pick = await withMenuLifecycle(() =>
      vscode.window.showQuickPick<DefaultsRow>(items, {
        title: "Codex Model Settings",
        placeHolder: "Pick a setting to change",
      })
    );
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
      if (result.kind === "picked") writeCodexModelOverride(wsHash, result.value);
      continue;
    }
    if (pick.row === "effort") {
      const result = await pickEffort(effort, model);
      if (result.kind === "picked") writeCodexEffortOverride(wsHash, result.value);
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
