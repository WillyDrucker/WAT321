import type { AppServerClient } from "./appServerClient";
import { codexRecommendedPin, type CodexSessionPin } from "./codexSessionSettings";
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
 * No `this` - takes everything explicitly so it can be called from
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

  // A session is born on whatever Codex recommends right now, unless the
  // user pre-picked a model before the first prompt. The pin is passed
  // to `thread/start` AND stored on the record: the wire value decides
  // what the rollout header records, and the record is what survives the
  // restart Codex does not survive.
  //
  // `model` is sent only when we have one. Omitting the key lets Codex
  // resolve for itself, which is the honest fallback when no catalog has
  // answered yet. Effort is absent here on purpose: `thread/start`
  // accepts the key and ignores it (probed), so effort rides `turn/start`
  // alone and this would be a lie in the diff.
  const pinned: CodexSessionPin =
    typeof opts.record.model === "string" && opts.record.model.length > 0
      ? { model: opts.record.model, effort: opts.record.effort ?? null }
      : codexRecommendedPin();

  opts.logger.info(
    `[thread] starting S${counter} sandbox=${sandbox} approvalPolicy=${approvalPolicy} model=${pinned.model ?? "(codex default)"} effort=${pinned.effort ?? "(inherit)"}`
  );
  const threadStartParams: ThreadStartParams = {
    cwd: opts.workspacePath,
    approvalPolicy,
    sandbox,
    sessionStartSource: "startup",
    ...(pinned.model !== null ? { model: pinned.model } : {}),
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
    model: pinned.model,
    effort: pinned.effort,
    pinResolved: true,
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
 * threshold-exceeded failures.
 *
 * The pinned model + effort SURVIVE rotation, unlike reset and delete
 * which clear them. Rotation is involuntary: a network blip or a stuck
 * thread triggers it, and quietly moving the user off the model they
 * chose would be a worse surprise than carrying it onto the replacement
 * thread. Reset and delete are the user asking for a clean session, and
 * only those return to Codex's recommendation. */
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
