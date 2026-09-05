import { isKnownCodexModel } from "../../shared/providers/codex/models";
import { writeSessionModel } from "../codexSettings/codexSessionSettings";
import { readRolloutModelSlug, rewriteRolloutModelSlug } from "../codexTurn/rolloutModel";
import { findRolloutPath, type RecoverableSession } from "../codexTurn/sessionRecovery";
import { bridgeThreadDisplayName } from "../codexTurn/threadNaming";
import { loadBridgeThreadRecord } from "../codexTurn/threadRecord";

/**
 * The disk side of Repair Sessions: which bridge sessions exist, what
 * model slug each rollout stores, which of those the running Codex no
 * longer lists, and the rewrite that repairs one. Validity comes from
 * the live `model/list` catalog, never from `~/.codex/models_cache.json`,
 * which any codex on the machine may have overwritten. The pickers in
 * `repairSessionsPicker.ts` and `forceRepairFlow.ts` own every toast.
 */

/** Every bridge session the scan considered, whether or not its
 * stored slug tripped the catalog check. The force-repair path shows
 * the user exactly what is on disk when auto-detect seems wrong. */
interface BridgeSessionScan {
  session: RecoverableSession;
  rolloutPath: string;
  storedSlug: string | null;
}

export interface RepairCandidate {
  session: RecoverableSession;
  rolloutPath: string;
  badSlug: string;
}

interface RepairEntry {
  session: RecoverableSession;
  rolloutPath: string;
  /** What the rollout stored before the rewrite, for the failure toast. */
  fromSlug: string | null;
  target: string;
}

export interface RepairOutcome {
  repaired: number;
  failed: Array<{ counter: number; slug: string | null }>;
}

/** Two scan sources, deduplicated by threadId:
 *   1. `sessions` - everything `listRecoverableSessions` found by
 *      walking `~/.codex/session_index.jsonl`. Misses sessions that
 *      errored at first turn before Codex wrote their index entry.
 *   2. Current `bridge-thread.<wshash>.json` record - captures the
 *      threadId of the session our dispatcher just created, even if
 *      Codex hasn't yet surfaced it in the index.
 * Sessions whose rollout cannot be found are skipped - delete / reset
 * is the right response for those, not repair. */
export function scanBridgeSessions(
  workspacePath: string | null,
  sessions: RecoverableSession[]
): BridgeSessionScan[] {
  const out: BridgeSessionScan[] = [];
  const seen = new Set<string>();
  const consider = (session: RecoverableSession): void => {
    if (seen.has(session.threadId)) return;
    seen.add(session.threadId);
    const rolloutPath = findRolloutPath(session.threadId);
    if (rolloutPath === null) return;
    out.push({ session, rolloutPath, storedSlug: readRolloutModelSlug(rolloutPath) });
  };
  for (const session of sessions) consider(session);
  if (workspacePath !== null) {
    const rec = loadBridgeThreadRecord(workspacePath);
    if (rec.threadId !== null) {
      consider({
        threadId: rec.threadId,
        sessionCounter: rec.sessionCounter,
        displayName: bridgeThreadDisplayName(workspacePath, rec.sessionCounter),
        createdAt: null,
      });
    }
  }
  return out;
}

/** The subset of bridge sessions whose stored `session_meta.model` the
 * running app-server does not list. These are guaranteed to 404 on
 * the next `thread/resume`, so the Repair action surfaces them as the
 * candidate set. A rollout whose header carries no slug is skipped. */
export function findRepairableSessions(
  workspacePath: string | null,
  sessions: RecoverableSession[]
): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  for (const scanned of scanBridgeSessions(workspacePath, sessions)) {
    const slug = scanned.storedSlug;
    if (slug === null || isKnownCodexModel(slug)) continue;
    out.push({ session: scanned.session, rolloutPath: scanned.rolloutPath, badSlug: slug });
  }
  return out;
}

/** Repoint the workspace's session pin at a repaired slug.
 *
 * Rewriting the rollout alone is not enough. `thread/resume` reads the
 * rollout, but every `turn/start` re-sends `readSessionPin().model`, so a
 * session left pinned to the bad slug would 404 on its very next turn
 * while the repair reported success. Only the CURRENTLY active thread
 * has a pin - older sessions in the scan are rollouts on disk with no
 * record pointing at them. */
function repinIfCurrentSession(
  workspacePath: string | null,
  threadId: string,
  target: string
): void {
  if (workspacePath === null) return;
  if (loadBridgeThreadRecord(workspacePath).threadId !== threadId) return;
  writeSessionModel(workspacePath, target);
}

/** Rewrite each entry's rollout header to its target and repin the
 * live session so the next turn does not undo the fix. Atomic
 * tmp+rename per rollout. Windows may refuse the rename while Codex
 * still has the file open, and those entries land in `failed`. */
export function applyRepairs(
  entries: RepairEntry[],
  workspacePath: string | null
): RepairOutcome {
  let repaired = 0;
  const failed: RepairOutcome["failed"] = [];
  for (const entry of entries) {
    if (rewriteRolloutModelSlug(entry.rolloutPath, entry.target)) {
      repaired++;
      repinIfCurrentSession(workspacePath, entry.session.threadId, entry.target);
    } else {
      failed.push({ counter: entry.session.sessionCounter, slug: entry.fromSlug });
    }
  }
  return { repaired, failed };
}
