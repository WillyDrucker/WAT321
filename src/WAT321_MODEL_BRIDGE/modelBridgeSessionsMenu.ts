import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SESSIONS_DIR } from "./constants";
import { makeBackItem, makeSeparator } from "./menuCommon";

/**
 * "Manage Sessions" submenu for the Model Bridge widget. Lists every
 * legacy-harness rollout directory under
 * `~/.wat321/model-bridge/sessions/`, summarizing turns + compacts +
 * last-turn timestamp per thread, with row-level erase or bulk
 * "Erase all".
 *
 * The unified bridge no longer writes here - this surface only
 * cleans up rollouts left by earlier installs and any still-resident
 * legacy harness traffic.
 */

interface ThreadSummary {
  id: string;
  alias: string;
  turns: number;
  compacts: number;
  lastTs: string;
  modifiedMs: number;
}

function listThreadSummaries(): ThreadSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: ThreadSummary[] = [];
  for (const name of names) {
    const dir = join(SESSIONS_DIR, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const rolloutPath = join(dir, "rollout.jsonl");
    if (!existsSync(rolloutPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(rolloutPath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    let alias = "?";
    let turns = 0;
    let compacts = 0;
    let lastTs = "";
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.type === "session_meta") alias = e.alias ?? alias;
        if (e?.type === "turn") {
          turns++;
          lastTs = e.ts ?? lastTs;
        }
        if (e?.type === "compact") compacts++;
      } catch {
        // skip torn line
      }
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(rolloutPath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    out.push({ id: name, alias, turns, compacts, lastTs, modifiedMs: mtimeMs });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out;
}

async function manageThreadsMenu(): Promise<void> {
  const threads = listThreadSummaries();
  if (threads.length === 0) {
    void vscode.window.showInformationMessage(
      "Model Bridge: no active threads. The legacy harness rollout dir is empty."
    );
    return;
  }

  const eraseAllItem: vscode.QuickPickItem = {
    label: "$(trash) Erase all threads",
    description: `${threads.length} thread${threads.length === 1 ? "" : "s"}`,
    detail: "Removes every rollout in ~/.wat321/model-bridge/sessions/",
  };
  const items: vscode.QuickPickItem[] = [
    makeBackItem(),
    makeSeparator(),
    eraseAllItem,
    makeSeparator(),
    ...threads.map((t) => ({
      label: t.id,
      description: `${t.alias} · ${t.turns} turn${t.turns === 1 ? "" : "s"}${
        t.compacts > 0 ? ` · ${t.compacts} compact${t.compacts === 1 ? "" : "s"}` : ""
      }`,
      detail: t.lastTs ? `Last turn ${t.lastTs}` : "No turns yet",
    })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Manage OpenCode Sessions",
    placeHolder: "Pick a thread to erase, or 'Erase all'",
  });
  if (!pick || pick.label === "🔵 BACK") return;

  if (pick === eraseAllItem) {
    const confirm = await vscode.window.showWarningMessage(
      `Erase all ${threads.length} Model Bridge thread${threads.length === 1 ? "" : "s"}? This cannot be undone.`,
      { modal: true },
      "Erase All"
    );
    if (confirm !== "Erase All") return;
    let removed = 0;
    for (const t of threads) {
      try {
        rmSync(join(SESSIONS_DIR, t.id), { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort
      }
    }
    void vscode.window.showInformationMessage(
      `Model Bridge: erased ${removed} of ${threads.length} thread${threads.length === 1 ? "" : "s"}.`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Erase thread '${pick.label}'? This removes its rollout permanently.`,
    { modal: true },
    "Erase"
  );
  if (confirm !== "Erase") return;
  try {
    rmSync(join(SESSIONS_DIR, pick.label), { recursive: true, force: true });
    void vscode.window.showInformationMessage(`Model Bridge: thread '${pick.label}' erased.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Model Bridge: erase failed - ${msg}`);
  }
}

/** Public entry point for the Manage OpenCode Sessions submenu.
 * Invoked directly by the Epic Handshake click menu's "Manage
 * OpenCode Sessions" row so users can reach bridge session
 * management from either widget. */
export async function showModelBridgeSessions(): Promise<void> {
  await manageThreadsMenu();
}

export { manageThreadsMenu };
