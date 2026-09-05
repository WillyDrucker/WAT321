import { statSync } from "node:fs";
import type { AppServerClient } from "../appServer/appServerClient";
import type { Envelope } from "./envelope";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import { classifyFailure } from "./failureClassifier";
import { tryRolloutRecovery } from "./rolloutRecovery";
import { findRolloutPath } from "./sessionRecovery";
import {
  noteFailure,
  noteSuccess,
  rotateThreadRecord,
  spawnFreshThread,
} from "./threadLifecycle";
import { ensureReadyThread } from "./threadReadiness";
import {
  clearInFlightFlag,
  clearProcessingFlag,
  writeInFlightFlag,
  writeReturningFlag,
  writeSuppressCodexToast,
} from "./turnFlags";
import { runTurnOnce } from "./turnRunner";
import { currentWaitMode } from "./waitMode";

/**
 * Per-envelope dispatch into Codex. `threadReadiness.ts` gets the
 * thread into a resumable state first. This module then runs the
 * turn with compact and late-rotation retries, does the success
 * accounting, and absorbs "Codex committed the reply but the marshal
 * step threw" failures by recovering the reply from the rollout.
 *
 * Separated from `codexDispatcher.ts` because the dispatcher class
 * is mostly inbox-watching + lifecycle. This module is the turn
 * orchestration the class calls from one site (`processEnvelope`).
 */

interface DispatchDeps {
  workspacePath: string;
  wsHash: string;
  logger: EpicHandshakeLogger;
  ensureClient: () => Promise<AppServerClient>;
  forceRestart: () => void;
}

/** Drive one envelope all the way through Codex and return the
 * assistant reply text. Throws when the turn fails AND no late
 * reply was recovered from the rollout. */
export async function dispatchTurn(
  deps: DispatchDeps,
  env: Envelope
): Promise<string> {
  const { workspacePath, logger, ensureClient, forceRestart } = deps;
  const dispatchStart = Date.now();
  const client = await ensureClient();
  const clientReady = Date.now();
  let { threadId, record } = await ensureReadyThread({
    client,
    workspacePath,
    logger,
  });
  const threadReady = Date.now();

  // Seed for reply-recovery in the outer catch below. Captured once
  // threadId is known so the catch can tell a fresh reply (committed
  // during THIS turn) from stale text already in the rollout when the
  // turn started. seedRolloutSize covers the rare byte-identical-reply
  // case where assistant text matches but the rollout still grew.
  const seedRolloutPath = findRolloutPath(threadId);
  const seedAssistantText = seedRolloutPath
    ? (tryRolloutRecovery(seedRolloutPath) ?? "")
    : "";
  const seedRolloutSize = sizeOrZero(seedRolloutPath);

  try {
    writeInFlightFlag(workspacePath);
    let result: string;
    try {
      result = await runTurnWithCompactRetry(deps, client, threadId, env);
    } catch (err) {
      // Late rotation: thread/resume can succeed (Codex's app-server
      // has the thread cached), but turn/start then fails with "no
      // rollout found for thread id ..." when the rollout file on
      // disk is gone (manual delete, sibling Codex VS Code instance).
      // Treat like a resume-time rotate: rotate, spawn fresh, retry
      // once. Without this the user sees a raw "Codex bridge error"
      // reply for every prompt until they pick Reset from the menu.
      const cls = classifyFailure(err);
      if (cls !== "rotate") throw err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`runTurn rotate (${msg}); rotating + spawning fresh thread for retry`);
      record = rotateThreadRecord(record, workspacePath);
      const spawned = await spawnFreshThread({
        client,
        record,
        workspacePath,
        logger,
      });
      threadId = spawned.threadId;
      record = spawned.record;
      result = await runTurnWithCompactRetry(deps, client, threadId, env);
    }
    const turnEnd = Date.now();
    noteSuccess(record);
    logger.info(
      `[timing] turn ok client_setup=${clientReady - dispatchStart}ms thread_setup=${threadReady - clientReady}ms turn=${turnEnd - threadReady}ms total=${turnEnd - dispatchStart}ms`
    );
    clearProcessingFlag(workspacePath);
    clearInFlightFlag(workspacePath);
    writeReturningFlag(workspacePath);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // User cancellations are intentional stops, not failures. Don't
    // bump the consecutive-failure counter or stash lastError. Still
    // clear flags and propagate so the reply path writes "cancelled
    // by user" back to Claude cleanly.
    if (msg !== "cancelled by user") {
      // Reply-marshal failures can fire AFTER Codex committed the
      // reply to the rollout. Try a recovery pass with the seed
      // comparison before declaring failure. Freshness gated so stale
      // prior-turn text never gets delivered as ours.
      const recoveryRollout = findRolloutPath(threadId);
      const recovered = tryRolloutRecovery(recoveryRollout);
      const grew =
        recoveryRollout !== null &&
        sizeOrZero(recoveryRollout) > seedRolloutSize;
      if (recovered !== null && (recovered !== seedAssistantText || grew)) {
        logger.info(
          `[recover] dispatch catch absorbed throw (chain ${env.chainId}); rollout has fresh reply len=${recovered.length}, delivering instead of blocker`
        );
        noteSuccess(record);
        writeSuppressCodexToast(workspacePath);
        clearProcessingFlag(workspacePath);
        clearInFlightFlag(workspacePath);
        writeReturningFlag(workspacePath);
        return recovered;
      }
      noteFailure(record, msg);
    } else {
      // Cancel is best-effort: turn/interrupt may not have delivered
      // if the codex child was wedged. Force-restart so the next
      // dispatch starts on a fresh process. Cheap, idempotent.
      forceRestart();
    }
    clearProcessingFlag(workspacePath);
    clearInFlightFlag(workspacePath);
    throw err;
  }
}

/** Dispatch a turn with compact-on-context-window-exceeded retry.
 * Same threadId, same S<N> name, same user-visible session -
 * compaction is a repair, not a reset. */
async function runTurnWithCompactRetry(
  deps: DispatchDeps,
  client: AppServerClient,
  threadId: string,
  env: Envelope
): Promise<string> {
  const { workspacePath, wsHash, logger } = deps;
  // Wait mode resolution: prefer the envelope's `wait_mode` field
  // (per-call args from the MCP caller) - fall back to the sticky
  // flag for back-compat with older MCP servers. Wait mode is locked
  // during in-flight turns (menu guard) so the snapshot holds for
  // the full turn even if the user flips the toggle.
  const waitMode = env.waitMode ?? currentWaitMode(workspacePath);
  const opts = {
    client,
    threadId,
    env,
    workspacePath,
    wsHash,
    logger,
    waitMode,
  };
  try {
    return await runTurnOnce(opts);
  } catch (err) {
    if (classifyFailure(err) !== "compact") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(`turn hit context limit (${msg}); running thread/compact/start`);
    try {
      await client.sendRequest("thread/compact/start", { threadId });
    } catch (cerr) {
      const cmsg = cerr instanceof Error ? cerr.message : String(cerr);
      logger.error(`compact failed: ${cmsg}`);
      throw err; // original error is more informative
    }
    logger.info(`compact complete; retrying turn on same thread`);
    return await runTurnOnce(opts);
  }
}

function sizeOrZero(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
