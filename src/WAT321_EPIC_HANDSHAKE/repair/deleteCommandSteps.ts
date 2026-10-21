import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { CODEX_SESSION_INDEX_PATH } from "../../shared/providers/codex/codexHome";
import { findRolloutPath, walkRolloutFiles } from "../codexTurn/sessionRecovery";
import { nextCollisionFreeCounter } from "../codexTurn/threadNaming";
import {
  loadBridgeThreadRecordIfExists,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "../codexTurn/threadRecord";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * Mechanics shared by both delete entry points (single-session and
 * bulk). The three steps - rollout-file delete, session_index strip,
 * bridge-thread record null - are best-effort: each catches its own
 * I/O and warns through the logger instead of throwing, so a partial
 * failure at one step still lets the others run. Codex never cleans
 * its own index when rollouts are removed out-of-band, so the bulk
 * path's `orphanSweepPattern` argument lets the index strip also drop
 * entries whose rollout file is gone - without that sweep, deleted-
 * out-of-band orphans would keep `nextCollisionFreeCounter`'s gap-
 * fill from landing back at S1.
 */

/** Unlink every rollout whose file name contains any of the supplied
 * thread ids. Returns the count of removed files. Errors are
 * best-effort - any single unlink failure is swallowed and reflected
 * only by the count. A walk-wide failure is logged once with the
 * supplied label as prefix. */
export function deleteRolloutFilesByThreadId(
  threadIds: Set<string>,
  logger: EpicHandshakeLogger,
  warnLabel: string
): number {
  let removed = 0;
  try {
    for (const file of walkRolloutFiles()) {
      const name = basename(file);
      for (const tid of threadIds) {
        if (name.includes(tid)) {
          try {
            unlinkSync(file);
            removed++;
          } catch {
            // best-effort per file
          }
          break;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${warnLabel}: ${msg}`);
  }
  return removed;
}

/** Strip session_index.jsonl entries whose id is in `threadIds`. When
 * `orphanSweepPattern` is non-null, also drop entries whose thread_name
 * matches the pattern AND whose rollout file is gone - this is the
 * load-bearing orphan sweep used by Delete-All. Without it, deleted-
 * out-of-band orphans accumulate in the index and pollute the gap-fill
 * counter. Returns the count of stripped lines (best-effort - I/O
 * failures log with the warnLabel and return 0). */
export function stripSessionIndexEntries(
  threadIds: Set<string>,
  orphanSweepPattern: RegExp | null,
  logger: EpicHandshakeLogger,
  warnLabel: string
): number {
  if (!existsSync(CODEX_SESSION_INDEX_PATH)) return 0;
  try {
    const raw = readFileSync(CODEX_SESSION_INDEX_PATH, "utf8");
    const lines = raw.split("\n");
    const kept = lines.filter((line) => {
      if (!line.trim()) return false;
      try {
        const obj = JSON.parse(line) as { id?: string; thread_name?: string };
        if (obj.id !== undefined && threadIds.has(obj.id)) return false;
        if (orphanSweepPattern !== null && obj.id !== undefined) {
          const name = obj.thread_name ?? "";
          if (orphanSweepPattern.test(name) && findRolloutPath(obj.id) === null) {
            return false;
          }
        }
        return true;
      } catch {
        return true;
      }
    });
    const stripped = lines.filter((l) => l.trim()).length - kept.length;
    if (!writeFileAtomic(CODEX_SESSION_INDEX_PATH, `${kept.join("\n")}\n`)) {
      logger.warn(`${warnLabel}: atomic write rejected`);
    }
    return stripped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${warnLabel}: ${msg}`);
    return 0;
  }
}

/** Null the workspace's bridge-thread record: threadId=null, counter
 * bumped to the gap-filled next, failure fields reset, pinned model +
 * effort forgotten. Pass the record when the caller already loaded it,
 * or null to load it here (the bulk path). Returns the projected next
 * counter, or null when no record exists or the write fails.
 *
 * Clearing the pin is what makes "delete the session" the way back to
 * Codex's current recommendation. Keep this in step with
 * `resetBridgeThread`, which does the same for the Reset path. */
export function clearBridgeThreadRecord(
  workspacePath: string,
  knownRecord: BridgeThreadRecord | null,
  logger: EpicHandshakeLogger,
  warnLabel: string
): number | null {
  const record = knownRecord ?? loadBridgeThreadRecordIfExists(workspacePath);
  if (record === null) return null;
  const projectedNext = nextCollisionFreeCounter(workspacePath);
  const next: BridgeThreadRecord = {
    ...record,
    threadId: null,
    sessionCounter: projectedNext,
    lastResetAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    model: null,
    effort: null,
    serviceTier: null,
    pinResolved: true,
  };
  if (!saveBridgeThreadRecord(next)) {
    logger.warn(`${warnLabel}: atomic write rejected`);
    return null;
  }
  return projectedNext;
}
