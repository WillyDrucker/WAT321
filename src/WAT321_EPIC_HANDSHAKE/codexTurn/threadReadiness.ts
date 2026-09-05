import type { AppServerClient } from "../appServer/appServerClient";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import { classifyFailure } from "./failureClassifier";
import { isKnownCodexModel } from "../../shared/providers/codex/models";
import { readRolloutModelSlug } from "./rolloutModel";
import { findRolloutPath } from "./sessionRecovery";
import {
  noteFailure,
  rotateThreadRecord,
  spawnFreshThread,
} from "./threadLifecycle";
import {
  clearBridgeErrorState,
  loadBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadRecord";

/**
 * Gets the bridge thread into a state a turn can run on: auto-
 * recovery of a thread whose stored model became known again,
 * rotation after repeated failures, then spawn-or-resume with the
 * pre-flight model check. `codexTurnDispatch.ts` runs the turn on
 * the result.
 */

/** Consecutive recoverable-shape failures before we give up on the
 * thread and rotate to a fresh one. Keeps a user's S1 alive through
 * transient blips but bails out of genuinely stuck threads. */
const MAX_CONSECUTIVE_FAILURES = 3;

interface ReadyThread {
  threadId: string;
  record: BridgeThreadRecord;
}

/** Recognize a bridge-thread `lastError` whose root cause was an
 * upstream "model does not exist" / "model not available" response.
 * Drives auto-recovery: if past failures on this thread were all
 * model-unknown errors AND the model is now in the cache, clear the
 * failure counter and resume. Substring match so minor wording
 * changes across Codex / OpenAI versions still classify correctly. */
function isModelUnknownError(
  lastError: string | null | undefined
): boolean {
  if (!lastError) return false;
  const lower = lastError.toLowerCase();
  return (
    lower.includes("does not exist") ||
    lower.includes("does not recognize") ||
    lower.includes("model not available") ||
    lower.includes("model not found") ||
    lower.includes("do not have access to") ||
    lower.includes("is not in your installed codex")
  );
}

export async function ensureReadyThread(args: {
  client: AppServerClient;
  workspacePath: string;
  logger: EpicHandshakeLogger;
}): Promise<ReadyThread> {
  const { client, workspacePath, logger } = args;
  let record = loadBridgeThreadRecord(workspacePath);

  // Auto-recovery: if the stored model slug is now recognized (a Codex
  // upgrade or a server-side rollout added it) and the last failure was
  // a model-unknown error, clear the failure state and preserve the
  // threadId. Runs BEFORE the threshold rotation so a session at or past
  // the threshold can still be rescued.
  if (
    record.threadId !== null &&
    (record.consecutiveFailures ?? 0) > 0 &&
    isModelUnknownError(record.lastError)
  ) {
    const rolloutPath = findRolloutPath(record.threadId);
    const storedSlug = rolloutPath ? readRolloutModelSlug(rolloutPath) : null;
    if (storedSlug !== null && isKnownCodexModel(storedSlug)) {
      logger.info(
        `[auto-recover] session S${record.sessionCounter} stored model "${storedSlug}" is now recognized; clearing ${record.consecutiveFailures} prior failure(s) and resuming`
      );
      record = clearBridgeErrorState(workspacePath);
    }
  }

  // Threshold-based rotation: N consecutive recoverable failures on
  // the same thread, rotate. Protects against a thread stuck in a
  // bad state we can't detect cleanly.
  if (
    record.threadId !== null &&
    (record.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES
  ) {
    logger.error(
      `thread ${record.threadId} hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures; rotating`
    );
    record = rotateThreadRecord(record, workspacePath);
  }

  let threadId = record.threadId;
  if (threadId === null) {
    // No pre-spawn model validation. A fresh thread is born on the slug
    // the running app-server itself marks `isDefault`, so it is valid by
    // construction. `~/.codex/config.toml` has no bearing on the turn and
    // is not consulted.
    const spawned = await spawnFreshThread({
      client,
      record,
      workspacePath,
      logger,
    });
    return { threadId: spawned.threadId, record: spawned.record };
  }

  // Pre-flight model validation. Every `thread/resume` ships the
  // rollout's stored `session_meta.model` to the API - if the running
  // app-server no longer lists that slug the next turn 404s.
  // Validation fails open (returns true) while no catalog has
  // answered, so an unreachable Codex never gates a legit dispatch.
  const rolloutPath = findRolloutPath(threadId);
  const storedSlug = rolloutPath ? readRolloutModelSlug(rolloutPath) : null;
  if (storedSlug !== null && !isKnownCodexModel(storedSlug)) {
    const msg = `Codex session S${record.sessionCounter} stores a model slug "${storedSlug}" that the installed Codex doesn't recognize. The Repair Sessions option in the bridge menu can rewrite the slug; Reset Codex Session rolls to a fresh thread.`;
    logger.warn(`[preflight] ${msg}`);
    noteFailure(record, msg);
    throw new Error(msg);
  }
  try {
    await client.sendRequest("thread/resume", { threadId });
  } catch (err) {
    const cls = classifyFailure(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (cls !== "rotate") {
      noteFailure(record, msg);
      throw err;
    }
    logger.error(`resume failed (${msg}); thread unrecoverable, rotating`);
    record = rotateThreadRecord(record, workspacePath);
    const spawned = await spawnFreshThread({
      client,
      record,
      workspacePath,
      logger,
    });
    threadId = spawned.threadId;
    record = spawned.record;
  }
  return { threadId, record };
}
