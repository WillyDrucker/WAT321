import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { readAliases, writeAliases } from "../shared/bridge/sessionAliases";
import { SETTING } from "../engine/settingsKeys";

// Inline the bridge dir rather than import from `./index` - the
// re-export of this module from index.ts means top-level imports
// resolve before index.ts has run far enough to declare BRIDGE_DIR,
// so a `from "./index"` import sees `undefined` at module load and
// crashes the path.join below before activation can finish.
const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");

/**
 * Auto-create the resumable S1 session for OpenCode (and later Local
 * LLM) when the user first enables Model Bridge. Mirrors how Codex's
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

const ALIAS_PATH = join(BRIDGE_DIR, "session-aliases.json");
const MB_CONFIG_PATH = join(homedir(), ".wat321", "model-bridge", "config.json");

const RETRY_INTERVAL_MS = 500;
const MAX_WAIT_MS = 8_000;

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

function pickInstance(cfg: MbConfig): MbInstance | null {
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

async function attemptCreate(cfg: MbConfig, instance: MbInstance): Promise<string | null> {
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

/** Wait for opencode serve URL to appear in MB's config (it gets
 * written when the subprocess passes its readiness probe). Returns
 * the resolved config or null if the deadline elapses. */
async function waitForOpencodeServe(): Promise<MbConfig | null> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const cfg = readMbConfig();
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
  const mbEnabled = config.get<boolean>(SETTING.enableOpenCode, false);
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
