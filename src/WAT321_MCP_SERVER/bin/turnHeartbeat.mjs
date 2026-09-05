import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicWrite.mjs";
import { returningFlagPath, turnHeartbeatPath } from "./epicHandshakePaths.mjs";
import { EPIC_HANDSHAKE_DIR, ensureDir } from "./wat321Paths.mjs";

/**
 * The per-turn heartbeat sidecar `turn-heartbeat.<dispatchId>.json`
 * under the Epic Handshake root. The extension's Codex dispatcher and
 * this runtime's OpenCode heartbeat both write it, the bridge stage
 * coordinator animates the 5-stage walker from it, and Codex adaptive
 * waits read `lastProgressAt` to decide whether the turn is alive.
 * MJS counterpart to `src/engine/heartbeat/`. Every call is best-
 * effort: a missing or torn file reads as "no heartbeat".
 */

export function writeTurnHeartbeat(payload) {
  try {
    writeFileAtomic(
      turnHeartbeatPath(payload.dispatchId),
      JSON.stringify(payload, null, 2)
    );
  } catch {
    // best-effort, the widget falls back to idle on a missing file
  }
}

export function deleteTurnHeartbeat(dispatchId) {
  try {
    const path = turnHeartbeatPath(dispatchId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function readTurnHeartbeat(dispatchId) {
  try {
    const path = turnHeartbeatPath(dispatchId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every readable heartbeat whose `workspaceHash` matches. Files for
 * other workspaces share the directory and are skipped. */
export function listTurnHeartbeats(wsHash) {
  const beats = [];
  try {
    const files = readdirSync(EPIC_HANDSHAKE_DIR).filter(
      (f) => f.startsWith("turn-heartbeat.") && f.endsWith(".json")
    );
    for (const file of files) {
      let beat;
      try {
        beat = JSON.parse(readFileSync(join(EPIC_HANDSHAKE_DIR, file), "utf8"));
      } catch {
        continue;
      }
      if (beat?.workspaceHash === wsHash) beats.push(beat);
    }
  } catch {
    // best-effort
  }
  return beats;
}

/** Drop the per-workspace `returning.<wsHash>.flag` for 3s so the
 * bridge widget's stage 4 alternating frame flips from blank to
 * left-arrow. Mirrors the Codex turnRunner's `writeReturningFlag` so
 * sync MCP dispatches play the same return ceremony Codex and FF
 * non-Codex play. The unref'd timeout lets the MCP runtime exit
 * without waiting on this cleanup. */
export function writeReturningFlag(wsHash) {
  if (typeof wsHash !== "string" || wsHash.length === 0) return;
  try {
    ensureDir(EPIC_HANDSHAKE_DIR);
    const path = returningFlagPath(wsHash);
    writeFileAtomic(path, new Date().toISOString());
    const t = setTimeout(() => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }, 3_000);
    t.unref?.();
  } catch {
    // best-effort
  }
}
