import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the per-workspace `wait-status.<wsHash>.json` sidecar that
 * `bin/channel.mjs` writes whenever a sync `reply` enters its blocking
 * wait loop. Surfaces the wait budget so the Claude session-tokens
 * tooltip can render a "Waiting on Codex: Ns" line without the widget
 * having to import from the bridge bin.
 *
 * Read-only: the bin owns the write/clear lifecycle. A stale file
 * (channel.mjs crashed mid-wait without clearing) is filtered out by
 * the budget-elapsed check inside `readWaitStatus` so the tooltip
 * never sticks on a phantom wait.
 */

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");

interface WaitStatusFile {
  envelopeId: string;
  workspaceHash: string;
  target: "codex";
  timeoutSec: number;
  startedAt: number;
}

export interface WaitStatus {
  target: "codex";
  timeoutSec: number;
  startedAt: number;
}

/** Parse the sidecar for the given workspace hash. Returns `null` when
 * absent, malformed, or older than the wait budget itself (a crash
 * sentinel). The budget-elapsed safety net runs at twice the declared
 * timeout so a legitimate near-deadline read still surfaces the wait
 * line, while a multi-day-old artifact does not. */
export function readWaitStatus(wsHash: string | null): WaitStatus | null {
  if (!wsHash) return null;
  const path = join(EH_DIR, `wait-status.${wsHash}.json`);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: Partial<WaitStatusFile>;
  try {
    parsed = JSON.parse(raw) as Partial<WaitStatusFile>;
  } catch {
    return null;
  }
  if (parsed.workspaceHash !== wsHash) return null;
  if (parsed.target !== "codex") return null;
  if (typeof parsed.timeoutSec !== "number" || parsed.timeoutSec <= 0) return null;
  if (typeof parsed.startedAt !== "number") return null;
  // Crash safety: if the sidecar has outlived twice its declared
  // timeout, channel.mjs almost certainly died mid-wait. Treat as
  // cleared so the tooltip does not stick.
  const ageMs = Date.now() - parsed.startedAt;
  if (ageMs > parsed.timeoutSec * 1000 * 2) return null;
  return {
    target: "codex",
    timeoutSec: parsed.timeoutSec,
    startedAt: parsed.startedAt,
  };
}
