import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  findRoutesInstance,
  readOpenCodeRoutesConfigSnapshot,
  type OpenCodeRoutesConfigSnapshot,
  type OpenCodeRoutesInstance,
} from "../shared/bridge/openCodeRoutesConfigSnapshot";
import { readAliases, SESSION_ALIASES_PATH, writeAliases } from "../shared/bridge/sessionAliases";

/**
 * Auto-create the resumable S1 session for OpenCode when the user
 * first enables OpenCode Routes. Mirrors how Codex's S1 thread exists
 * immediately on Epic Handshake enable - the user shouldn't have to
 * manually run `wat321_session({action:"create"})` before their first
 * dispatch.
 *
 * Idempotent: skips when an opencode S1 alias is already present in
 * the alias map. Best-effort: if opencode serve hasn't finished
 * spawning yet, retries with a short backoff window. Failure is
 * silent - the user can still create sessions manually.
 *
 * Triggered from:
 *   - Bridge tier activate (covers fresh installs + reload)
 *   - `enableOpenCode` settings change (covers user opting in
 *     for the first time after install)
 */

const RETRY_INTERVAL_MS = 500;
const MAX_WAIT_MS = 8_000;
/** The remote instance S1 binds to when the active instance is not a
 * remote. Same fallback the Epic Handshake session pickers use. */
const FALLBACK_REMOTE_INSTANCE_ID = "big-pickle";

async function attemptCreate(cfg: OpenCodeRoutesConfigSnapshot, instance: OpenCodeRoutesInstance): Promise<string | null> {
  const url = cfg.openCodeServerUrl;
  if (!url) return null;
  try {
    const res = await fetch(`${url}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: {
          id: instance.model,
          providerID: instance.harnessProviderID,
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return typeof data?.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

/** Wait for opencode serve URL to appear in OpenCode Routes config (it gets
 * written when the subprocess passes its readiness probe). Returns
 * the resolved config or null if the deadline elapses. */
async function waitForOpencodeServe(): Promise<OpenCodeRoutesConfigSnapshot | null> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const cfg = readOpenCodeRoutesConfigSnapshot();
    if (cfg?.openCodeServerUrl && cfg.openCodeServerUrl.length > 0) {
      return cfg;
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  return null;
}

/** Run the auto-create flow. Idempotent. Best-effort. */
async function ensureOpenCodeS1(): Promise<void> {
  const config = vscode.workspace.getConfiguration("wat321");
  const openCodeEnabled = config.get<boolean>(SETTING.enableOpenCode, false);
  if (!openCodeEnabled) return;

  const aliases = readAliases(SESSION_ALIASES_PATH);
  if (Object.keys(aliases.opencode).length > 0) {
    // S1 (or later) already exists - nothing to do.
    return;
  }

  const cfg = await waitForOpencodeServe();
  if (cfg === null) return;

  const instance = findRoutesInstance(cfg, null, "remote", FALLBACK_REMOTE_INSTANCE_ID);
  if (instance === null) return;

  const sessionId = await attemptCreate(cfg, instance);
  if (sessionId === null) return;

  aliases.opencode["S1"] = { sessionId, instanceId: instance.id };
  // Mark as active so the EH menu's CURRENT row reflects this session
  // and bridge dispatches that omit `session` resolve to it.
  aliases.activeAliases.opencode = "S1";
  writeAliases(SESSION_ALIASES_PATH, aliases);
}

/** Wire activate-time auto-create + the settings-change watcher.
 * Returns a Disposable so extension.ts can register it. */
export function registerAutoCreateOpenCodeS1(
  context: vscode.ExtensionContext
): vscode.Disposable {
  // Run once on activate. Fire-and-forget - the inner wait handles
  // opencode serve startup latency.
  void ensureOpenCodeS1();

  const subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`)) {
      void ensureOpenCodeS1();
    }
  });
  context.subscriptions.push(subscription);
  return subscription;
}
