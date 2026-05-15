import type { AppServerClient } from "./appServerClient";
import type { ThreadStartParams } from "./protocol";
import {
  bridgeThreadDisplayName,
  nextCollisionFreeCounter,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadPersistence";
import type { EpicHandshakeLogger } from "./types";

/**
 * Bridge-flow mutations of a `BridgeThreadRecord`. Distinct from
 * `threadRecord.ts` which owns user-driven IO (load, save, reset,
 * clear-error). The functions here run during a turn and reflect
 * dispatcher state machine outcomes:
 *   - `spawnFreshThread` creates a new Codex thread and persists its id.
 *   - `rotateThreadRecord` nulls the threadId after a definitive
 *     unrecoverable failure or threshold breach.
 *   - `noteSuccess` / `noteFailure` track the consecutive-failure
 *     counter that drives threshold-based rotation.
 *
 * No `this`; takes everything explicitly so it can be called from
 * the dispatcher class without inheritance entanglement.
 */

interface ThreadStartResult {
  thread: { id: string; path: string | null; ephemeral: boolean };
}

/** Create a fresh Codex thread with collision-free S<N> name and
 * persist its id. Returns both the new threadId and the updated
 * record so the caller's local view stays consistent. */
export async function spawnFreshThread(opts: {
  client: AppServerClient;
  record: BridgeThreadRecord;
  workspacePath: string;
  logger: EpicHandshakeLogger;
}): Promise<{ threadId: string; record: BridgeThreadRecord }> {
  const counter = nextCollisionFreeCounter(
    opts.workspacePath,
    opts.record.sessionCounter
  );
  // Always create the thread at the maximum ceiling. Per-turn
  // overrides on `turn/start` are authoritative for actual policy -
  // each turn passes the live sandbox/model/effort values from the
  // override flag files. Creating the thread permissive means the
  // user can dial down for one turn and back up for the next without
  // ever needing a thread reset (verified end-to-end via probe). The
  // user's actual sandbox preference is enforced per-turn.
  // Approval policy stays pinned to `never` regardless - the bridge
  // has no UI to relay Codex's approval prompts back to Claude
  // mid-turn, so any other value would stall.
  const sandbox = "danger-full-access";
  const approvalPolicy = "never";
  opts.logger.info(
    `[thread] starting S${counter} sandbox=${sandbox} approvalPolicy=${approvalPolicy}`
  );
  const threadStartParams: ThreadStartParams = {
    cwd: opts.workspacePath,
    approvalPolicy,
    sandbox,
    sessionStartSource: "startup",
  };
  const started = (await opts.client.sendRequest(
    "thread/start",
    threadStartParams
  )) as ThreadStartResult;
  const threadId = started.thread.id;
  const updated: BridgeThreadRecord = {
    ...opts.record,
    threadId,
    sessionCounter: counter,
    consecutiveFailures: 0,
    lastError: null,
  };
  saveBridgeThreadRecord(updated);
  try {
    await opts.client.sendRequest("thread/name/set", {
      threadId,
      name: bridgeThreadDisplayName(opts.workspacePath, counter),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger.warn(`thread/name/set failed: ${msg}`);
  }
  return { threadId, record: updated };
}

/** Null out threadId so the next call creates a fresh thread. Counter
 * mirrors what `spawnFreshThread` will actually pick on the next
 * dispatch (gap-fill, lowest unused S<n> in this workspace's pattern)
 * so the menu label + tooltip read the same value the spawn will
 * use. Without this, a rotation after threshold failures would bump
 * the stored counter past freed slots and the menu would surface a
 * stale "next" number. Called on definitive "thread not found" or
 * threshold-exceeded failures. */
export function rotateThreadRecord(
  record: BridgeThreadRecord,
  workspacePath: string
): BridgeThreadRecord {
  const next: BridgeThreadRecord = {
    ...record,
    threadId: null,
    sessionCounter: nextCollisionFreeCounter(workspacePath, record.sessionCounter),
    lastResetAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: null,
  };
  saveBridgeThreadRecord(next);
  return next;
}

/** Mark success: clear failure counter, stamp lastSuccessAt. */
export function noteSuccess(record: BridgeThreadRecord): void {
  saveBridgeThreadRecord({
    ...record,
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: new Date().toISOString(),
  });
}

/** Mark failure: bump consecutive counter, stash lastError. The
 * threshold check at the top of dispatchToCodex uses this. */
export function noteFailure(record: BridgeThreadRecord, message: string): void {
  saveBridgeThreadRecord({
    ...record,
    consecutiveFailures: (record.consecutiveFailures ?? 0) + 1,
    lastError: message.slice(0, 500),
  });
}
