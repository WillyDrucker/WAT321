import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readAliases, writeAliases } from "../shared/bridge/sessionAliases";
import { SETTING } from "../engine/settingsKeys";
import { bridgeStateDir, openCodeRoutesStateDir } from "../shared/wat321Paths";

// Resolve paths via `wat321Paths` rather than `./index` - this module
// is re-exported from index.ts, so a `from "./index"` import returns
// undefined at module load before index has finished evaluating.

/**
 * Auto-create the resumable S1 session for OpenCode (and later Local
 * LLM) when the user first enables OpenCode Routes. Mirrors how Codex's
 * S1 thread exists immediately on Epic Handshake enable - the user
 * shouldn't have to manually run `wat321_session({action:"create"})`
 * before their first dispatch.
 *
 * Idempotent: skips when an opencode S1 alias is already present in
 * the alias map. Best-effort: if opencode serve hasn't finished
 * spawning yet, retries with a short backoff window. Failure is
 * logged silently - the user can still create sessions manually.
 *
 * Triggered from:
 *   - Bridge tier activate (covers fresh installs + reload)
 *   - `enableOpenCode` settings change (covers user opting in
 *     for the first time after install)
 */

const ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");
const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");

const RETRY_INTERVAL_MS = 500;
const MAX_WAIT_MS = 8_000;

interface OpenCodeRoutesInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
}

interface OpenCodeRoutesConfigSnapshot {
  openCodeServerUrl?: string;
  activeInstanceId?: string;
  instances?: OpenCodeRoutesInstance[];
}

function readOpenCodeRoutesConfigSnapshot(): OpenCodeRoutesConfigSnapshot | null {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")) as OpenCodeRoutesConfigSnapshot;
  } catch {
    return null;
  }
}

function pickInstance(cfg: OpenCodeRoutesConfigSnapshot): OpenCodeRoutesInstance | null {
  const instances = Array.isArray(cfg.instances) ? cfg.instances : [];
  // Prefer the user's active instance when it's a remote (the auto-S1
  // exists for OpenCode targets specifically; local instances get a
  // separate auto-S1 when the local-llm target lands).
  const active = instances.find((i) => i.id === cfg.activeInstanceId);
  if (active && active.kind === "remote") return active;
  // Fall back to Big Pickle if it's in the catalog.
  const bigPickle = instances.find((i) => i.id === "big-pickle");
  if (bigPickle) return bigPickle;
  // Last resort: first remote instance.
  return instances.find((i) => i.kind === "remote") ?? null;
}

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
export async function ensureOpenCodeS1(): Promise<void> {
  const config = vscode.workspace.getConfiguration("wat321");
  const mbEnabled = config.get<boolean>(SETTING.enableOpenCode, true);
  if (!mbEnabled) return;

  const aliases = readAliases(ALIAS_PATH);
  if (Object.keys(aliases.opencode).length > 0) {
    // S1 (or later) already exists - nothing to do.
    return;
  }

  const cfg = await waitForOpencodeServe();
  if (cfg === null) return;

  const instance = pickInstance(cfg);
  if (instance === null) return;

  const sessionId = await attemptCreate(cfg, instance);
  if (sessionId === null) return;

  aliases.opencode["S1"] = { sessionId, instanceId: instance.id };
  // Mark as active so the EH menu's CURRENT row reflects this session
  // and bridge dispatches that omit `session` resolve to it.
  aliases.activeAliases.opencode = "S1";
  writeAliases(ALIAS_PATH, aliases);
}

/** Wire activate-time auto-create + the settings-change watcher.
 * Returns a Disposable so extension.ts can register it. */
export function registerAutoCreateOpenCodeS1(
  context: vscode.ExtensionContext
): vscode.Disposable {
  // Run once on activate. Fire-and-forget; the inner wait handles
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
