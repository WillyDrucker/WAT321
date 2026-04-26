import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  getCodexModelInfo,
  listSelectableCodexModels,
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
import { makeBackItem, withMenuLifecycle } from "./menuCommon";

/**
 * Combined "Codex Defaults" picker - one entry point for all three
 * per-turn overrides the bridge passes on every `turn/start`:
 *   - sandbox  (Full-Access | Read-Only)
 *   - model    (any visibility=list slug from `models_cache.json`)
 *   - effort   (low | medium | high | xhigh)
 *
 * Each row shows BOTH the user-persisted default (from settings) AND
 * the CURRENT live value (from the runtime override flag). Clicking a
 * row drills into a sub-picker; the sub-picker writes the runtime
 * override flag and `turnRunner` picks it up on the next `turn/start`.
 *
 * No thread reset, no app-server respawn, no Claude impact - the
 * `turn/start` per-turn parameters are authoritative (verified
 * end-to-end via probe). Settings drive the on-activate default;
 * menu picks override until the next reload.
 *
 * Silent-fail surfaces: the model row degrades gracefully when the
 * cache is unreadable (warning toast, no picker), or when a setting
 * references a slug that's not in the cache (label shows
 * "(no longer available)"; the next turn falls back to no override).
 */

/** Sub-picker outcomes. `cancelled` = user pressed BACK or dismissed
 * (caller writes nothing); `picked` = user selected a row (caller
 * writes `value` to the override flag, where `null` means "clear the
 * override and use the model's own default"). */
type PickResult<TValue> =
  | { kind: "cancelled" }
  | { kind: "picked"; value: TValue };

/** Row kinds for sub-pickers. `back` returns to parent menu;
 * `default` clears the override; `value` carries the picked payload.
 * Optional payload fields rather than a true discriminated union -
 * TypeScript's contextual typing on object literals does not narrow
 * cleanly when intersection types meet QuickPickItem, so the
 * non-discriminated shape with `kind` as the test is the pragmatic
 * choice. The kind values stay distinct so the runtime branching is
 * still type-safe via switches, just without payload narrowing. */
type RowKind = "back" | "default" | "value";
interface SandboxRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  state?: CodexSandboxState;
}
interface ModelRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  slug?: string;
}
interface EffortRow extends vscode.QuickPickItem {
  rowKind: RowKind;
  effort?: CodexEffortLevel;
}

/** Row kinds for the combined Codex Defaults picker. */
type DefaultsRow = vscode.QuickPickItem & {
  row: "sandbox" | "model" | "effort" | "back";
};

/** Read the current model + effort and return a one-line summary for
 * the row label in `showSessionsSubmenu`. Reads runtime override
 * (flag file) first; falls back to "default" labeling when no
 * override is set. */
export function currentModelEffortLabel(): string {
  const slug = readCodexModelOverride();
  const effort = readCodexEffortOverride();
  if (slug === null && effort === null) return "default";
  const info = slug !== null ? getCodexModelInfo(slug) : null;
  const modelLabel =
    slug === null ? "default" : info?.displayName ?? `${slug} (unknown)`;
  const effortLabel = effort ?? "default";
  return `${modelLabel} (${effortLabel})`;
}

export async function showCodexDefaultsPicker(): Promise<void> {
  // Looped so each sub-picker returns to the combined picker, letting
  // the user adjust multiple defaults in one session without re-clicking
  // the bridge widget. Loop exits on BACK or QuickPick dismiss.
  while (true) {
    const sandbox = readCodexSandboxOverride();
    const model = readCodexModelOverride();
    const effort = readCodexEffortOverride();

    const sandboxDefault = readSandboxDefaultSetting();
    const modelDefault = readModelDefaultSetting();
    const effortDefault = readEffortDefaultSetting();

    const items: DefaultsRow[] = [
      { ...makeBackItem(), row: "back" },
      {
        label: `SANDBOX: ${sandbox === "full-access" ? "FULL-ACCESS" : "READ-ONLY"} (CURRENT)`,
        description: `default: ${sandboxDefault === "full-access" ? "Full-Access" : "Read-Only"}`,
        detail:
          "Click to switch. Per-turn override - takes effect on the next prompt without a thread reset.",
        iconPath: new vscode.ThemeIcon("shield"),
        row: "sandbox",
      },
      {
        label: modelRowLabel(model),
        description: `default: ${modelDefaultLabel(modelDefault)}`,
        detail:
          "Click to change. Applied per-turn; the active session resumes with the new model on the next prompt.",
        iconPath: new vscode.ThemeIcon("symbol-method"),
        row: "model",
      },
      {
        label: effortRowLabel(effort),
        description: `default: ${effortDefaultLabel(effortDefault)}`,
        detail:
          "Click to change. Applied per-turn; the active session resumes with the new effort on the next prompt.",
        iconPath: new vscode.ThemeIcon("dashboard"),
        row: "effort",
      },
    ];

    const pick = await withMenuLifecycle(() =>
      vscode.window.showQuickPick<DefaultsRow>(items, {
        title: "Codex Defaults",
        placeHolder: "Pick a default to change",
      })
    );
    if (!pick || pick.row === "back") return;

    if (pick.row === "sandbox") {
      const result = await pickSandbox(sandbox);
      if (result.kind === "picked") writeCodexSandboxOverride(result.value);
    } else if (pick.row === "model") {
      const result = await pickModel(model);
      if (result.kind === "picked") writeCodexModelOverride(result.value);
    } else if (pick.row === "effort") {
      const result = await pickEffort(effort, model);
      if (result.kind === "picked") writeCodexEffortOverride(result.value);
    }
  }
}

// -----------------------------------------------------------------
// Sandbox sub-picker
// -----------------------------------------------------------------

async function pickSandbox(
  current: CodexSandboxState
): Promise<PickResult<CodexSandboxState>> {
  const items: SandboxRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    {
      label: current === "full-access" ? "FULL-ACCESS (CURRENT)" : "FULL-ACCESS",
      description: "Codex can run shell + write files.",
      detail:
        "Recommended on dev machines you own. Faster on research turns; tool calls do not get blocked at the sandbox layer.",
      iconPath: new vscode.ThemeIcon("shield"),
      rowKind: "value",
      state: "full-access",
    },
    {
      label: current === "read-only" ? "READ-ONLY (CURRENT)" : "READ-ONLY",
      description: "Codex can read files; shell + writes are blocked.",
      detail:
        "Conservative default. Codex chains web searches when shell tools are blocked, so research turns can be slower.",
      iconPath: new vscode.ThemeIcon("shield"),
      rowKind: "value",
      state: "read-only",
    },
  ];
  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<SandboxRow>(items, {
      title: "Codex sandbox",
      placeHolder: "Pick a sandbox state",
    })
  );
  if (!pick || pick.rowKind === "back" || pick.state === undefined) {
    return { kind: "cancelled" };
  }
  return { kind: "picked", value: pick.state };
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
      "Epic Handshake: no models available in `~/.codex/models_cache.json`. Run any Codex command to refresh the cache, then try again."
    );
    return { kind: "cancelled" };
  }

  const items: ModelRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    {
      label: current === null ? "DEFAULT (use Codex's own default) (CURRENT)" : "DEFAULT (use Codex's own default)",
      description: "No override. Codex picks the model from ~/.codex/config.toml.",
      iconPath: new vscode.ThemeIcon("circle-slash"),
      rowKind: "default",
    },
    ...models.map((m): ModelRow => ({
      rowKind: "value",
      slug: m.slug,
      label: m.slug === current ? `${m.displayName} (CURRENT)` : m.displayName,
      description: m.slug,
      detail: m.description,
      iconPath: new vscode.ThemeIcon("symbol-method"),
    })),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<ModelRow>(items, {
      title: "Codex model",
      placeHolder: "Pick a model (or DEFAULT to clear the override)",
    })
  );
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "default") return { kind: "picked", value: null };
  if (pick.slug === undefined) return { kind: "cancelled" };
  return { kind: "picked", value: pick.slug };
}

// -----------------------------------------------------------------
// Effort sub-picker
// -----------------------------------------------------------------

async function pickEffort(
  current: CodexEffortLevel | null,
  modelSlug: string | null
): Promise<PickResult<CodexEffortLevel | null>> {
  // If a model override is set, list only that model's supported
  // efforts. Otherwise list the standard four.
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

  const items: EffortRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    {
      label: current === null ? "DEFAULT (use the model's own default) (CURRENT)" : "DEFAULT (use the model's own default)",
      description: "No override. Codex picks the model's default effort.",
      iconPath: new vscode.ThemeIcon("circle-slash"),
      rowKind: "default",
    },
    ...supported.map((e): EffortRow => ({
      rowKind: "value",
      effort: e.effort,
      label: e.effort === current ? `${e.effort} (CURRENT)` : e.effort,
      description: e.description,
      iconPath: new vscode.ThemeIcon("dashboard"),
    })),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<EffortRow>(items, {
      title: modelInfo !== null ? `Effort for ${modelInfo.displayName}` : "Codex effort",
      placeHolder: "Pick an effort level (or DEFAULT to clear the override)",
    })
  );
  if (!pick || pick.rowKind === "back") return { kind: "cancelled" };
  if (pick.rowKind === "default") return { kind: "picked", value: null };
  if (pick.effort === undefined) return { kind: "cancelled" };
  return { kind: "picked", value: pick.effort };
}

// -----------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------

function modelRowLabel(model: string | null): string {
  if (model === null) return "MODEL: default (CURRENT)";
  const info = getCodexModelInfo(model);
  if (info === null) {
    return `MODEL: ${model} (no longer available) (CURRENT)`;
  }
  return `MODEL: ${info.displayName} (CURRENT)`;
}

function effortRowLabel(effort: CodexEffortLevel | null): string {
  if (effort === null) return "EFFORT: default (CURRENT)";
  return `EFFORT: ${effort} (CURRENT)`;
}

function modelDefaultLabel(slug: string | null): string {
  if (slug === null) return "use Codex's default";
  const info = getCodexModelInfo(slug);
  return info?.displayName ?? slug;
}

function effortDefaultLabel(effort: CodexEffortLevel | null): string {
  return effort ?? "model's default";
}

// -----------------------------------------------------------------
// Settings readers
// -----------------------------------------------------------------

function readSandboxDefaultSetting(): CodexSandboxState {
  const raw = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.epicHandshakeCodexSandboxDefault, "Read-Only");
  return raw === "Full-Access" ? "full-access" : "read-only";
}

function readModelDefaultSetting(): string | null {
  const raw = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.epicHandshakeCodexModelDefault, "")
    .trim();
  return raw.length > 0 ? raw : null;
}

function readEffortDefaultSetting(): CodexEffortLevel | null {
  const raw = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.epicHandshakeCodexEffortDefault, "")
    .trim();
  if (["low", "medium", "high", "xhigh"].includes(raw)) {
    return raw as CodexEffortLevel;
  }
  return null;
}
