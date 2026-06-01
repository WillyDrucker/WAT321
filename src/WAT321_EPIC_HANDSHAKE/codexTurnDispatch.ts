import { statSync } from "node:fs";
import type { AppServerClient } from "./appServerClient";
import type { Envelope } from "./envelope";
import { classifyFailure } from "./failureClassifier";
import { isKnownCodexModel, readCodexConfigModel } from "../shared/providers/codex/models";
import { tryRolloutRecovery } from "./rolloutRecovery";
import {
  clearBridgeErrorState,
  findRolloutPath,
  loadBridgeThreadRecord,
  readRolloutModelSlug,
} from "./threadPersistence";
import {
  noteFailure,
  noteSuccess,
  rotateThreadRecord,
  spawnFreshThread,
} from "./threadLifecycle";
import {
  clearInFlightFlag,
  clearProcessingFlag,
  writeInFlightFlag,
  writeReturningFlag,
  writeSuppressCodexToast,
} from "./turnFlags";
import { runTurnOnce } from "./turnRunner";
import type { EpicHandshakeLogger } from "./types";
import { currentWaitMode } from "./waitMode";

/**
 * Per-envelope dispatch into Codex. Drives the full thread lifecycle
 * for one user prompt: auto-recovery, threshold rotation, thread
 * spawn-or-resume with pre-flight model validation, the actual turn
 * run with late-rotation handling, success accounting, and the
 * outer-catch reply-recovery path that absorbs "Codex committed the
 * reply but the marshal step threw" failures.
 *
 * Separated from `codexDispatcher.ts` because the dispatcher class
 * is mostly inbox-watching + lifecycle. This module is the turn
 * orchestration - 240+ LOC of thread / dispatch / recover logic that
 * the class only calls from one site (`processEnvelope`).
 */

/** Consecutive recoverable-shape failures before we give up on the
 * thread and rotate to a fresh one. Keeps a user's S1 alive through
 * transient blips but bails out of genuinely stuck threads. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface DispatchDeps {
  workspacePath: string;
  wsHash: string;
  logger: EpicHandshakeLogger;
  ensureClient: () => Promise<AppServerClient>;
  forceRestart: () => void;
}

/** Recognize a bridge-thread `lastError` whose root cause was an
 * upstream "model does not exist" / "model not available" response.
 * Drives auto-recovery: if past failures on this thread were all
 * model-unknown errors AND the model is now in the cache, clear the
 * failure counter and resume. Substring match so minor wording
 * changes across Codex / OpenAI versions still classify correctly. */
export function isModelUnknownError(
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
  let record = loadBridgeThreadRecord(workspacePath);

  // Auto-recovery: if the stored model slug is now recognized (Codex
  // CLI upgrade added support, or the cache refreshed) and the last
  // failure was a model-unknown error, clear the failure state and
  // preserve the threadId. Runs BEFORE the threshold rotation so a
  // session at or past the threshold can still be rescued.
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
    // Pre-spawn config validation. `thread/start` accepts any slug
    // silently; Codex only validates when `turn/start` calls the
    // upstream API. Without this check, a config.toml with a bogus
    // model births a zombie thread that fails every turn with a
    // cryptic API error. Catch it here before any side effect lands.
    const configDefault = readCodexConfigModel();
    if (configDefault !== null && !isKnownCodexModel(configDefault)) {
      const msg = `Codex's default model "${configDefault}" isn't in the installed Codex's known set. The bridge can't start a session on a slug Codex doesn't recognize. Update Codex's config to a valid slug, or clear the model line so Codex picks its own default.`;
      logger.warn(`[preflight] ${msg}`);
      noteFailure(record, msg);
      throw new Error(msg);
    }
    const spawned = await spawnFreshThread({
      client,
      record,
      workspacePath,
      logger,
    });
    threadId = spawned.threadId;
    record = spawned.record;
  } else {
    // Pre-flight model validation. Every `thread/resume` ships the
    // rollout's stored `session_meta.model` to the API; if that slug
    // is no longer in the user's `~/.codex/models_cache.json` the
    // next turn 404s. Validation is lossy in the cache-unreadable
    // case (returns true) so a missing cache never gates a legit
    // dispatch.
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
      if (cls === "rotate") {
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
      } else {
        noteFailure(record, msg);
        throw err;
      }
    }
  }

  const threadReady = Date.now();

  // Seed for reply-recovery in the outer catch below. Captured once
  // threadId is known so the catch can tell a fresh reply (committed
  // during THIS turn) from stale text already in the rollout when the
  // turn started. seedRolloutSize covers the rare byte-identical-reply
  // case where assistant text matches but the rollout still grew.
  const seedRolloutPath = threadId !== null ? findRolloutPath(threadId) : null;
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
      if (threadId !== null) {
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
  // (per-call args from the MCP caller); fall back to the sticky
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
