import * as vscode from "vscode";
import {
  getCodexModelInfo,
  listSelectableCodexModels,
  readCodexConfigModel,
} from "../shared/codexModels";
import {
  readCodexEffortOverride,
  readCodexModelOverride,
  readCodexSandboxOverride,
  writeCodexEffortOverride,
  writeCodexModelOverride,
  writeCodexSandboxOverride,
  type CodexEffortLevel,
  type CodexSandboxState,
} from "./codexRuntimeOverrides";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type ActionContext,
  type DispatchAction,
} from "./menuCommon";
import { currentWorkspacePath, isPaused, setPaused } from "./statusBarState";
import { workspaceHash } from "./workspaceHash";

/** Resolve the current workspace's hash for flag-file partitioning. The
 * three Codex override flags are workspace-scoped so two VS Code windows
 * on different projects don't share sandbox/model/effort settings. When
 * no workspace is open we fall back to a sentinel hash that still
 * partitions the flag away from any real workspace. */
function currentWsHash(): string {
  const ws = currentWorkspacePath();
  return workspaceHash(ws ?? "no-workspace");
}

/**
 * Combined "Codex Session Settings" picker - one entry point for all
 * three per-turn overrides the bridge passes on every `turn/start`:
 *   - sandbox  (Full-Access | Read-Only)
 *   - model    (any visibility=list slug from `models_cache.json`)
 *   - effort   (low | medium | high | xhigh)
 *
 * Each row shows the current value. `*default*` marks rows that match
 * the platform baseline (sandbox=read-only, model=codex-config-default,
 * effort=model's own default-effort). `(CURRENT)` marks the active
 * selection inside sub-pickers.
 *
 * Sandbox is a direct toggle (no sub-picker) - one click flips between
 * full-access and read-only. Model and effort open sub-pickers because
 * each has multiple options.
 *
 * No persistent settings: overrides live only in flag files under
 * `~/.wat321/epic-handshake/`. Reset WAT321 wipes them, so "default"
 * is the safe fallback after a reset. The codex config.toml supplies
 * the model baseline, which means a user who only wants to follow
 * their codex config never has to touch this picker - the absence of
 * an override means codex uses its own config.
 */

type PickResult<TValue> =
  | { kind: "cancelled" }
  | { kind: "picked"; value: TValue };

type RowKind = "back" | "value" | "pause" | "resume" | "cancel";
interface ModelRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  slug?: string;
}
interface EffortRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  effort?: CodexEffortLevel;
}

type DefaultsRow = vscode.QuickPickItem & {
  row: "sandbox" | "model" | "effort" | "back" | "pause" | "resume" | "cancel";
};

/** Headline for the "CODEX SESSION SETTINGS" row in the sessions
 * submenu. Capitalized "Default" suffix when every override matches
 * the baseline; otherwise just "CODEX SESSION SETTINGS" so users can
 * tell at a glance whether anything is overridden. */
export function codexDefaultsHeadline(): string {
  return everythingAtDefault()
    ? "CODEX SESSION SETTINGS: Default"
    : "CODEX SESSION SETTINGS";
}

/** Sub-line for the "CODEX SESSION SETTINGS" row in the sessions
 * submenu. Lowercase "sandbox · model · effort" with the live current
 * values. Lets the user verify what the bridge will send without
 * opening the picker. */
export function codexDefaultsSubline(): string {
  const wsHash = currentWsHash();
  const sandbox = readCodexSandboxOverride(wsHash);
  const model = readCodexModelOverride(wsHash);
  const effort = readCodexEffortOverride(wsHash);
  // Each segment uses its native casing: sandbox words like
  // "Read-Only" / "Full-Access", model display name preserves its
  // own capitalization (GPT-5.5), effort starts capital (Medium).
  // Keeps the dot-separated subline scannable without a wall of
  // lowercase that hides where one value ends and the next begins.
  const sandboxLabel = sandbox === "full-access" ? "Full-Access" : "Read-Only";
  const modelLabel =
    model === null
      ? configModelLabel()
      : (getCodexModelInfo(model)?.displayName ?? model);
  const effortLabel = capitalizeFirst(effort ?? baselineEffort() ?? "Medium");
  return `${sandboxLabel} · ${modelLabel} · ${effortLabel}`;
}

function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function showCodexDefaultsPicker(
  dispatch: DispatchAction,
  ctx: ActionContext
): Promise<void> {
  // Looped so each sub-picker (model, effort) returns to the combined
  // picker, letting the user adjust multiple defaults in one session
  // without re-clicking the bridge widget. Loop exits on BACK or
  // QuickPick dismiss. Sandbox is an inline toggle so it never opens
  // a sub-picker - the loop just re-renders with the new state.
  const wsHash = currentWsHash();
  while (true) {
    const sandbox = readCodexSandboxOverride(wsHash);
    const model = readCodexModelOverride(wsHash);
    const effort = readCodexEffortOverride(wsHash);

    const sandboxLabel = sandbox === "full-access" ? "FULL-ACCESS" : "READ-ONLY";
    const sandboxNext = sandbox === "full-access" ? "READ-ONLY" : "FULL-ACCESS";

    const paused = isPaused();
    const pauseItem = makePauseResumeItem(paused, false);
    const cancelItem = makeCancelItem(false);

    const items: DefaultsRow[] = [
      { ...makeBackItem(), row: "back" },
      {
        label: `SANDBOX PERMISSION: ${sandboxLabel}${sandboxIsDefault(sandbox) ? " *default*" : ""}`,
        description: `Click to switch to ${sandboxNext}.`,
        iconPath: new vscode.ThemeIcon("shield"),
        row: "sandbox",
      },
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
      { ...pauseItem, row: pauseItem.action === "resume" ? "resume" : "pause" },
      { ...cancelItem, row: "cancel" },
    ];

    const pick = await withMenuLifecycle(() =>
      vscode.window.showQuickPick<DefaultsRow>(items, {
        title: "Codex Session Settings",
        placeHolder: "Pick a setting to change",
      })
    );
    if (!pick) return;
    if (pick.row === "back") {
      // Walk back to the sessions submenu (this picker's parent), not
      // straight to main. Honors the user's expectation that BACK
      // unwinds one menu level rather than closing the whole stack.
      await dispatch("manage-sessions", ctx);
      return;
    }

    if (pick.row === "sandbox") {
      // Direct toggle - no sub-picker needed. Loop re-renders with
      // the new state on the next iteration.
      writeCodexSandboxOverride(wsHash, sandbox === "full-access" ? "read-only" : "full-access");
      continue;
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
      // cancel handler runs (writes the cancel sentinel, etc).
      // No turn can be in flight while this picker is open since
      // the entry guard locks during in-flight, but we still go
      // through the canonical flow so toasts and flag writes match
      // every other CANCEL row in the menu vocabulary.
      await dispatch("cancel", ctx);
      return;
    }
  }
}

// -----------------------------------------------------------------
// Model sub-picker
// -----------------------------------------------------------------

async function pickModel(
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
      const isCurrent = m.slug === current || (current === null && m.slug === baseline);
      // Tag order: *default* first when applicable, then (CURRENT).
      // Both flank the model name so they stay visible even when the
      // description is truncated by a narrow QuickPick column.
      const tags: string[] = [];
      if (isDefault) tags.push("*default*");
      if (isCurrent) tags.push("(CURRENT)");
      const tagPrefix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
      // Description trimmed to the first sentence so the row label
      // does not get truncated mid-word in narrow QuickPick layouts.
      const shortDescription = shortenForRow(m.description);
      const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
      return {
        rowKind: "value",
        slug: m.slug,
        label: `${m.displayName.toUpperCase()}${tagPrefix}${descSuffix}`,
        iconPath: new vscode.ThemeIcon("symbol-method"),
      };
    }),
    { ...pauseItem, rowKind: pauseItem.action === "resume" ? "resume" : "pause" },
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
    const { setPaused } = await import("./statusBarState");
    setPaused(true);
    return { kind: "cancelled" };
  }
  if (pick.rowKind === "resume") {
    const { setPaused } = await import("./statusBarState");
    setPaused(false);
    return { kind: "cancelled" };
  }
  return { kind: "cancelled" };
}

// -----------------------------------------------------------------
// Effort sub-picker
// -----------------------------------------------------------------

async function pickEffort(
  current: CodexEffortLevel | null,
  modelSlug: string | null
): Promise<PickResult<CodexEffortLevel | null>> {
  // If a model override is set, list only that model's supported
  // efforts. Otherwise fall back to the standard four (low to xhigh).
  const modelInfo = modelSlug !== null ? getCodexModelInfo(modelSlug) : null;
  const supported: { effort: CodexEffortLevel; description: string }[] =
    modelInfo !== null && modelInfo.supportedEfforts.length > 0
      ? modelInfo.supportedEfforts
          .filter((e): e is { effort: CodexEffortLevel; description: string } =>
            ["low", "medium", "high", "xhigh"].includes(e.effort)
          )
          .map((e) => ({ effort: e.effort, description: e.description }))
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

  const items: EffortRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    ...supported.map((e): EffortRow => {
      const isDefault = e.effort === baseline;
      const isCurrent = e.effort === current || (current === null && e.effort === baseline);
      // Tag order: *default* first when applicable, then (CURRENT),
      // both before the description so they stay visible if the
      // description gets truncated.
      const tags: string[] = [];
      if (isDefault) tags.push("*default*");
      if (isCurrent) tags.push("(CURRENT)");
      const tagPrefix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
      const shortDescription = shortenForRow(e.description);
      const descSuffix = shortDescription ? ` - ${shortDescription}` : "";
      return {
        rowKind: "value",
        effort: e.effort,
        label: `${e.effort.toUpperCase()}${tagPrefix}${descSuffix}`,
        iconPath: new vscode.ThemeIcon("dashboard"),
      };
    }),
    { ...pauseItem, rowKind: pauseItem.action === "resume" ? "resume" : "pause" },
    { ...cancelItem, rowKind: "cancel" },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<EffortRow>(items, {
      title: modelInfo !== null ? `Effort for ${modelInfo.displayName}` : "Codex effort",
      placeHolder: "Pick an effort level",
    })
  );
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "value" && pick.effort !== undefined) {
    return { kind: "picked", value: pick.effort };
  }
  if (pick.rowKind === "pause") {
    const { setPaused } = await import("./statusBarState");
    setPaused(true);
    return { kind: "cancelled" };
  }
  if (pick.rowKind === "resume") {
    const { setPaused } = await import("./statusBarState");
    setPaused(false);
    return { kind: "cancelled" };
  }
  return { kind: "cancelled" };
}

// -----------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------

function modelRowLabel(model: string | null): string {
  const baseline = baselineModel();
  const effective = model ?? baseline;
  if (effective === null) {
    return "MODEL: (codex config has no model set)";
  }
  const info = getCodexModelInfo(effective);
  const label = (info?.displayName ?? effective).toUpperCase();
  const isDefault = effective === baseline;
  return `MODEL: ${label}${isDefault ? " *default*" : ""}`;
}

function effortRowLabel(effort: CodexEffortLevel | null): string {
  const baseline = baselineEffort();
  const effective = effort ?? baseline;
  if (effective === null) {
    return "EFFORT: (no default available)";
  }
  const isDefault = effective === baseline;
  return `EFFORT: ${effective.toUpperCase()}${isDefault ? " *default*" : ""}`;
}

function configModelLabel(): string {
  const cfg = readCodexConfigModel();
  if (cfg === null) return "default";
  const info = getCodexModelInfo(cfg);
  return info?.displayName ?? cfg;
}

/** Trim a row description so it survives narrow QuickPick columns
 * without truncation. Splits on the first sentence boundary, falling
 * back to a hard 60-char ceiling. The full description is still
 * available in the model cache for callers that want it. */
function shortenForRow(description: string): string {
  if (!description) return "";
  const trimmed = description.trim();
  const firstSentence = trimmed.split(/\.\s/)[0]?.replace(/\.$/, "") ?? trimmed;
  const candidate = firstSentence.length > 0 ? firstSentence : trimmed;
  return candidate.length <= 60 ? candidate : `${candidate.slice(0, 57)}...`;
}

// -----------------------------------------------------------------
// Baseline ("*default*") definitions
// -----------------------------------------------------------------

function sandboxIsDefault(state: CodexSandboxState): boolean {
  return state === "read-only";
}

/** The "default" model is whatever Codex's own config.toml declares.
 * If config has no model line, the picker has no `*default*` to mark.
 * Picking the same slug as the baseline is functionally identical to
 * having no override at all. */
function baselineModel(): string | null {
  return readCodexConfigModel();
}

/** The "default" effort is the model's own default effort from the
 * cache. Falls back to `"medium"` when no model context applies. */
function baselineEffort(): CodexEffortLevel | null {
  const model = readCodexModelOverride(currentWsHash()) ?? baselineModel();
  if (model === null) return "medium";
  const info = getCodexModelInfo(model);
  const cand = info?.defaultEffort;
  if (cand === "low" || cand === "medium" || cand === "high" || cand === "xhigh") {
    return cand;
  }
  return "medium";
}

function everythingAtDefault(): boolean {
  const wsHash = currentWsHash();
  const sandbox = readCodexSandboxOverride(wsHash);
  const modelOverride = readCodexModelOverride(wsHash);
  const effortOverride = readCodexEffortOverride(wsHash);
  if (!sandboxIsDefault(sandbox)) return false;
  // No override means "use the baseline" - that counts as default.
  if (modelOverride !== null && modelOverride !== baselineModel()) return false;
  if (effortOverride !== null && effortOverride !== baselineEffort()) return false;
  return true;
}
