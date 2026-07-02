import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the per-workspace `wait-status.<wsHash>.json` sidecar
 * that the unified MCP server's `WAT321_MCP_SERVER/bin/codex.mjs`
 * writes whenever a sync `wat321_ask` enters its blocking poll loop.
 * Surfaces the wait budget so the Claude session-tokens tooltip can
 * render a "Waiting on Codex: Ns" line without the widget having to
 * import from the bridge bin.
 *
 * Read-only: the MCP server owns the write/clear lifecycle. A stale
 * file (the bridge process crashed mid-wait without clearing) is
 * filtered out by the budget-elapsed check inside `readWaitStatus`
 * so the tooltip never sticks on a phantom wait.
 */

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");

export type WaitMode = "sync" | "adaptive";

interface WaitStatusFile {
  envelopeId: string;
  workspaceHash: string;
  target: "codex";
  timeoutSec: number;
  startedAt: number;
  /** Wait mode the MCP server is using for this dispatch. Optional
   * for back-compat with older sidecars that did not write the field
   * (those are treated as sync since that was the only mode then). */
  mode?: WaitMode;
}

export interface WaitStatus {
  target: "codex";
  timeoutSec: number;
  startedAt: number;
  mode: WaitMode;
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
  const mode: WaitMode =
    parsed.mode === "adaptive" || parsed.mode === "sync" ? parsed.mode : "sync";
  // Crash safety: filter out sidecars from a crashed/killed bridge
  // process. Sync mode uses 2x its declared timeout (typical 120s
  // declared -> 4 min stale cutoff). Adaptive declares the hard
  // ceiling (10-30 min) so 2x that would leave a stuck tooltip for
  // up to an hour - cap adaptive cleanup at a flat 15 min instead,
  // which is generous for the adaptive stall threshold (2 min) and
  // covers any legitimate long turn without trailing past a real
  // crash.
  const ageMs = Date.now() - parsed.startedAt;
  const staleCutoffMs =
    mode === "adaptive" ? 15 * 60_000 : parsed.timeoutSec * 1000 * 2;
  if (ageMs > staleCutoffMs) return null;
  return {
    target: "codex",
    timeoutSec: parsed.timeoutSec,
    startedAt: parsed.startedAt,
    mode,
  };
}
