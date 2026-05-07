import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { readAliases, writeAliases } from "../shared/bridge/sessionAliases";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
} from "./menuCommon";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Manage Sessions submenu (EH widget) for opencode-serve-backed
 * targets: "opencode" (cloud / Big Pickle) and "local" (local LLM).
 *
 * Both targets share opencode serve's session machinery; the only
 * differences are the alias-map namespace and the instance kind
 * filter. A single parameterized picker handles both, keeping them
 * in lockstep on row order and behavior. Codex's picker stays
 * separate because Codex sessions live in Codex's own rollout files,
 * not in opencode.db.
 *
 * Mirrors the parity table in WDDOCS/WAT321_V141_MB_FEATURE_STRIP.md
 * row-for-row where the underlying provider's capability matches.
 *
 * v1 row set:
 *   - BACK
 *   - Sessions list (S1, S2, ...) with slug + model + last-active
 *   - NEW SESSION
 *   - DELETE SESSION (sub-picker)
 *   - RENAME SESSION (sub-picker)
 *   - CANCEL
 *
 * Pause/Resume/Cancel/Restart/Set-Active rows queued for v1.4.2 -
 * each requires runtime infrastructure (target-scoped pause flag,
 * cancel sentinel for in-flight dispatches, restart of opencode
 * serve, default-resume preference) that doesn't exist yet.
 */

export type SessionTarget = "opencode" | "local";

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const ALIAS_PATH = join(BRIDGE_DIR, "session-aliases.json");
const BRIDGE_CONFIG_PATH = join(BRIDGE_DIR, "config.json");
const MB_CONFIG_PATH = join(homedir(), ".wat321", "model-bridge", "config.json");

/** Read the bridge config's projectName for display labels. The
 * bridge tier writes this on activate + workspace-folder change.
 * Fallback "Workspace" matches what the bridge tier uses when no
 * folder is open. */
function readProjectName(): string {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const raw = readFileSync(BRIDGE_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { projectName?: unknown };
    if (typeof cfg.projectName === "string" && cfg.projectName.trim().length > 0) {
      return cfg.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Standardized session display label. Mirrors the format used in the
 * unified bridge handlers so the picker, the bridge response text,
 * and any future surfaces all read the same way. */
function formatSessionDisplayName(target: SessionTarget, alias: string): string {
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

interface OpenCodeSessionMeta {
  id: string;
  slug?: string;
  title?: string;
  model?: { id?: string; providerID?: string };
  time?: { created?: number; updated?: number };
}

interface MbInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
}

interface MbConfig {
  openCodeServerUrl?: string;
  activeInstanceId?: string;
  instances?: MbInstance[];
}

function readMbConfig(): MbConfig | null {
  if (!existsSync(MB_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8")) as MbConfig;
  } catch {
    return null;
  }
}

function nextAlias(taken: string[]): string {
  let n = 1;
  while (taken.includes(`S${n}`)) n++;
  return `S${n}`;
}

async function fetchSessions(serveUrl: string): Promise<OpenCodeSessionMeta[]> {
  try {
    const res = await fetch(`${serveUrl}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as OpenCodeSessionMeta[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function formatRelative(ms: number | undefined): string {
  if (typeof ms !== "number") return "";
  const ageMs = Date.now() - ms;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

interface PickerRow extends vscode.QuickPickItem {
  rowKind:
    | "back"
    | "model"
    | "session"
    | "new"
    | "delete"
    | "rename"
    | "pause"
    | "resume"
    | "cancel";
  alias?: string;
  instanceId?: string;
}

interface TargetConfig {
  title: string;
  instanceKind: "local" | "remote";
  fallbackInstanceId: string;
  emptyHint: string;
}

const TARGET_CONFIGS: Record<SessionTarget, TargetConfig> = {
  opencode: {
    title: "Manage OpenCode Sessions",
    instanceKind: "remote",
    fallbackInstanceId: "big-pickle",
    emptyHint: "No OpenCode sessions yet. Create one with NEW SESSION.",
  },
  local: {
    title: "Manage Local LLM Sessions",
    instanceKind: "local",
    fallbackInstanceId: "local-llm",
    emptyHint:
      "No local LLM sessions yet. Create one with NEW SESSION (requires Local Endpoint set in WAT321 settings).",
  },
};

function pickInstanceForTarget(
  mb: MbConfig | null,
  target: SessionTarget
): MbInstance | null {
  if (!mb) return null;
  const cfg = TARGET_CONFIGS[target];
  const instances = mb.instances ?? [];
  const candidates = instances.filter((i) => i.kind === cfg.instanceKind);
  if (candidates.length === 0) return null;
  const active = candidates.find((i) => i.id === mb.activeInstanceId);
  if (active) return active;
  const fallback = candidates.find((i) => i.id === cfg.fallbackInstanceId);
  if (fallback) return fallback;
  return candidates[0];
}

async function showSessionsPicker(target: SessionTarget): Promise<void> {
  const cfg = TARGET_CONFIGS[target];
  const aliases = readAliases(ALIAS_PATH);
  const mb = readMbConfig();
  const serveUrl = mb?.openCodeServerUrl ?? null;

  const sessionMetas = serveUrl ? await fetchSessions(serveUrl) : [];
  const metaById = new Map(sessionMetas.map((s) => [s.id, s]));
  const instancesById = new Map((mb?.instances ?? []).map((i) => [i.id, i]));

  const targetAliases = aliases[target];
  const sessionRows: PickerRow[] = Object.entries(targetAliases).map(
    ([alias, entry]) => {
      const meta = metaById.get(entry.sessionId);
      // Prefer the bound catalog alias (e.g. "Big Pickle") when the
      // entry has an instanceId. Falls back to OpenCode's reported
      // model.id for legacy entries that pre-date instanceId tracking.
      const boundInstance = entry.instanceId
        ? instancesById.get(entry.instanceId)
        : null;
      const modelLabel =
        boundInstance?.alias ?? meta?.model?.id ?? "(no model)";
      const ageLabel = formatRelative(meta?.time?.updated);
      const found = meta !== undefined;
      // Standardized label first, OpenCode's auto-slug suppressed -
      // the user shouldn't have to read "eager-knight" to know which
      // session this is. The "(not found)" fallback only fires when
      // the alias points at a session id that opencode serve doesn't
      // know about anymore (recovery from a wiped opencode.db).
      const display = formatSessionDisplayName(target, alias);
      return {
        rowKind: "session",
        alias,
        label: found ? display : `${display} (not found)`,
        description: `${modelLabel}${ageLabel ? `  -  ${ageLabel}` : ""}`,
        iconPath: new vscode.ThemeIcon("symbol-method"),
      };
    }
  );

  // MODEL row: only for opencode target. Local LLM resolves its model
  // server-side (llama.cpp answers with whatever is loaded), so a
  // model picker on the local side has nothing to drive. For opencode,
  // the row sets the active catalog instance via the Model Bridge
  // tier's setActiveInstance command - that's the pref future
  // NEW SESSION calls read when binding a model. Existing sessions
  // keep whatever they were created with (OpenCode does not support
  // mid-conversation model swap).
  const activeInstance = pickInstanceForTarget(mb, target);
  const modelRow: PickerRow | null =
    target === "opencode"
      ? {
          rowKind: "model",
          label: `MODEL: ${activeInstance?.alias ?? "(none)"}`,
          description:
            "Click to switch the active OpenCode model. Applies to the next NEW SESSION.",
          iconPath: new vscode.ThemeIcon("symbol-method"),
        }
      : null;

  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, false);

  const items: PickerRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    ...(modelRow ? [modelRow] : []),
    ...sessionRows,
    {
      rowKind: "new",
      label: "NEW SESSION",
      description: `Create a fresh ${target} session with the active instance.`,
      iconPath: new vscode.ThemeIcon("add"),
    },
    {
      rowKind: "delete",
      label: "DELETE SESSION",
      description:
        "Remove an alias (the underlying opencode session is retained for recovery).",
      iconPath: new vscode.ThemeIcon("trash"),
    },
    {
      rowKind: "rename",
      label: "RENAME SESSION",
      description: "Change a session's alias.",
      iconPath: new vscode.ThemeIcon("edit"),
    },
    {
      ...pauseItem,
      rowKind: pauseItem.action === "resume" ? "resume" : "pause",
    },
    { ...makeCancelItem(false), rowKind: "cancel" },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<PickerRow>(items, {
      title: cfg.title,
      placeHolder:
        sessionRows.length === 0 ? cfg.emptyHint : "Pick a session to view, or an action.",
    })
  );
  if (!pick || pick.rowKind === "back" || pick.rowKind === "cancel") return;

  if (pick.rowKind === "pause") {
    setPaused(true);
    return;
  }
  if (pick.rowKind === "resume") {
    setPaused(false);
    // Re-open the picker so the user lands on RESUME flipping back to
    // PAUSE without an extra widget click. Matches the loop pattern in
    // the codex defaults picker.
    await showSessionsPicker(target);
    return;
  }

  if (pick.rowKind === "model") {
    // Cross-tier dispatch via command - the EH tier doesn't import
    // from the Model Bridge tier directly. The MB tier registers
    // wat321.modelBridge.pickActiveInstance which opens its own
    // sub-picker over the catalog and writes the new active instance
    // to preferences.json. After the user picks, re-open this picker
    // so the new MODEL row label reflects the choice.
    // Pass the target's kind so Local LLM doesn't appear in the
    // OpenCode session manager's MODEL row (and vice versa). Local
    // LLM has its own Manage Local LLM Sessions submenu.
    const kindFilter = target === "local" ? "local" : "remote";
    await vscode.commands.executeCommand(
      "wat321.modelBridge.pickActiveInstance",
      kindFilter
    );
    await showSessionsPicker(target);
    return;
  }

  if (pick.rowKind === "session") {
    void vscode.window.showInformationMessage(
      `${pick.alias}: ${pick.label}. Use wat321_ask({target:'${target}', session:'${pick.alias}', prompt:'...'}) to dispatch.`
    );
    return;
  }

  if (pick.rowKind === "new") {
    if (!serveUrl) {
      void vscode.window.showWarningMessage(
        "opencode serve is not running. Enable Model Bridge in settings, then try again."
      );
      return;
    }
    const instance = pickInstanceForTarget(mb, target);
    if (!instance) {
      void vscode.window.showWarningMessage(
        `No ${cfg.instanceKind} instances configured. Check your Model Bridge settings.`
      );
      return;
    }
    const body: { model?: { id: string; providerID: string } } = {};
    if (instance.model) {
      body.model = { id: instance.model, providerID: instance.harnessProviderID };
    }
    try {
      const res = await fetch(`${serveUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        void vscode.window.showErrorMessage(
          `Session create failed: opencode serve returned ${res.status}.`
        );
        return;
      }
      const data = (await res.json()) as { id?: string; slug?: string };
      if (!data.id) {
        void vscode.window.showErrorMessage(
          "Session create failed: opencode serve did not return an id."
        );
        return;
      }
      const alias = nextAlias(Object.keys(targetAliases));
      targetAliases[alias] = { sessionId: data.id, instanceId: instance.id };
      writeAliases(ALIAS_PATH, aliases);
      void vscode.window.showInformationMessage(
        `Created ${alias} (${instance.alias}, slug ${data.slug ?? "?"}).`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Session create failed: ${msg}`);
    }
    return;
  }

  if (pick.rowKind === "delete") {
    if (sessionRows.length === 0) {
      void vscode.window.showInformationMessage("No sessions to delete.");
      return;
    }
    const target2 = await vscode.window.showQuickPick(
      sessionRows.map((r) => ({ label: r.label, description: r.description, alias: r.alias })),
      { title: "Delete which session?", placeHolder: "Pick an alias to remove" }
    );
    if (!target2?.alias) return;
    const removedId = targetAliases[target2.alias]?.sessionId;
    delete targetAliases[target2.alias];
    writeAliases(ALIAS_PATH, aliases);
    void vscode.window.showInformationMessage(
      `Removed alias ${target2.alias}. Underlying session (${removedId}) retained in opencode.db for recovery.`
    );
    return;
  }

  if (pick.rowKind === "rename") {
    if (sessionRows.length === 0) {
      void vscode.window.showInformationMessage("No sessions to rename.");
      return;
    }
    const target2 = await vscode.window.showQuickPick(
      sessionRows.map((r) => ({ label: r.label, description: r.description, alias: r.alias })),
      { title: "Rename which session?", placeHolder: "Pick an alias to rename" }
    );
    if (!target2?.alias) return;
    const newName = await vscode.window.showInputBox({
      title: `Rename ${target2.alias}`,
      prompt: "New alias (e.g. 'Pickle Test', 'S1', 'Coding Session')",
      value: target2.alias,
    });
    if (!newName || newName === target2.alias) return;
    if (targetAliases[newName]) {
      void vscode.window.showErrorMessage(`Alias '${newName}' is already in use.`);
      return;
    }
    targetAliases[newName] = targetAliases[target2.alias];
    delete targetAliases[target2.alias];
    writeAliases(ALIAS_PATH, aliases);
    void vscode.window.showInformationMessage(
      `Renamed ${target2.alias} -> ${newName}.`
    );
    return;
  }
}

export async function showOpenCodeSessionsPicker(): Promise<void> {
  return showSessionsPicker("opencode");
}

export async function showLocalLLMSessionsPicker(): Promise<void> {
  return showSessionsPicker("local");
}

/** Register the cross-tier commands so the MB widget click can route
 * here without violating the tier-import rule (MB cannot import from
 * EH directly; command dispatch is the engine-blessed crossing). */
export function registerSessionPickerCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.manageOpenCodeSessions",
      async () => showOpenCodeSessionsPicker()
    ),
    vscode.commands.registerCommand(
      "wat321.bridge.manageLocalLlmSessions",
      async () => showLocalLLMSessionsPicker()
    )
  );
}
