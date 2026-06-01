import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  findRolloutPath,
  nextCollisionFreeCounter,
  type BridgeThreadRecord,
} from "./threadPersistence";
import type { EpicHandshakeLogger } from "./types";

/**
 * Mechanics shared by both delete entry points (single-session and
 * bulk). The three steps - rollout-file delete, session_index strip,
 * bridge-thread record null - are best-effort: each catches its own
 * I/O and warns through the logger instead of throwing, so a partial
 * failure at one step still lets the others run. Codex never cleans
 * its own index when rollouts are removed out-of-band, so the bulk
 * path's `orphanSweepPattern` argument lets the index strip also drop
 * entries whose rollout file is gone; without that sweep, deleted-
 * out-of-band orphans would keep `nextCollisionFreeCounter`'s gap-
 * fill from landing back at S1.
 */

/** Walk `~/.codex/sessions/...` and unlink every file whose path
 * contains any of the supplied thread ids. Returns the count of
 * removed files. Errors are best-effort - any single unlink failure
 * is swallowed and reflected only by the count. A walk-wide failure
 * is logged once with the supplied label as prefix. */
export function deleteRolloutFilesByThreadId(
  threadIds: Set<string>,
  logger: EpicHandshakeLogger,
  warnLabel: string
): number {
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  let removed = 0;
  try {
    for (const file of walk(sessionsRoot)) {
      for (const tid of threadIds) {
        if (file.includes(tid)) {
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
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(indexPath)) return 0;
  try {
    const raw = readFileSync(indexPath, "utf8");
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
    if (!writeFileAtomic(indexPath, `${kept.join("\n")}\n`)) {
      logger.warn(`${warnLabel}: atomic write rejected`);
    }
    return stripped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${warnLabel}: ${msg}`);
    return 0;
  }
}

/** Null the bridge-thread record at `recordPath`: threadId=null,
 * counter bumped to the gap-filled next, failure fields reset. When
 * `knownRecord` is non-null the caller already parsed the record;
 * pass null to defensively re-read it (used by the bulk path which
 * doesn't load the record at the start). Returns the projected next
 * counter, or null if the record can't be read / written. */
export function clearBridgeThreadRecord(
  workspacePath: string,
  recordPath: string,
  knownRecord: BridgeThreadRecord | null,
  logger: EpicHandshakeLogger,
  warnLabel: string
): number | null {
  let record: BridgeThreadRecord;
  if (knownRecord !== null) {
    record = knownRecord;
  } else {
    if (!existsSync(recordPath)) return null;
    try {
      record = JSON.parse(readFileSync(recordPath, "utf8")) as BridgeThreadRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${warnLabel}: ${msg}`);
      return null;
    }
  }
  const projectedNext = nextCollisionFreeCounter(
    workspacePath,
    record.sessionCounter
  );
  const next: BridgeThreadRecord = {
    ...record,
    threadId: null,
    sessionCounter: projectedNext,
    lastResetAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
  };
  if (!writeFileAtomic(recordPath, JSON.stringify(next, null, 2))) {
    logger.warn(`${warnLabel}: atomic write rejected`);
    return null;
  }
  return projectedNext;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
