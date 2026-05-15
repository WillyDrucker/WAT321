import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WAT321_ROOT, workspaceId } from "../paths.mjs";
import {
  HEARTBEAT_KEEPALIVE_MS,
  OPENCODE_ROUTES_DIR,
  OPENCODE_HEARTBEAT_PATH,
  OPENCODE_LAST_USED_PATH,
} from "./common.mjs";

/** Engine-tier heartbeat path that the bridge stage coordinator reads
 * for the 5-stage glyph walker. Sync (MCP-runtime) dispatches now
 * mirror the FF (extension-side) writes here so the bridge widget
 * animates uniformly across adaptive / sync / FF instead of staying
 * blank for sync calls. Per-dispatch filename; the coordinator
 * filters by `workspaceHash` field, so colocating files for many
 * workspaces in one dir is safe. */
const EH_ROOT_DIR = join(WAT321_ROOT, "epic-handshake");
function engineHeartbeatPath(dispatchId) {
  return join(EH_ROOT_DIR, `turn-heartbeat.${dispatchId}.json`);
}

function writeEngineHeartbeat(payload) {
  try {
    if (!existsSync(EH_ROOT_DIR)) mkdirSync(EH_ROOT_DIR, { recursive: true });
    const path = engineHeartbeatPath(payload.dispatchId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, path);
  } catch {
    // best-effort - widget falls back to idle on missing file
  }
}

function deleteEngineHeartbeat(dispatchId) {
  try {
    const path = engineHeartbeatPath(dispatchId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** Drop the per-workspace `returning.<wsHash>.flag` for 3s so the
 * bridge widget's stage 4 alternating frame flips from blank to
 * left-arrow. Mirrors the Codex turnRunner's `writeReturningFlag` -
 * sync MCP dispatches now play the same return ceremony Codex /
 * FF non-Codex play. The unref'd timeout lets the MCP runtime exit
 * without waiting on this cleanup. */
function writeReturningFlag(wsHash) {
  if (typeof wsHash !== "string" || wsHash.length === 0) return;
  try {
    if (!existsSync(EH_ROOT_DIR)) mkdirSync(EH_ROOT_DIR, { recursive: true });
    const path = join(EH_ROOT_DIR, `returning.${wsHash}.flag`);
    writeFileSync(path, new Date().toISOString());
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

/**
 * Cross-tier dispatch heartbeat. The OpenCode Routes widget + Epic Handshake widgets
 * read `heartbeat.<wsHash>.json` to render a live "calling" badge while
 * an OpenCode dispatch is in flight. Per-workspace partition keeps a
 * sibling VS Code window from lighting up when this workspace fires.
 *
 * `withOpenCodeHeartbeat` wraps a dispatch with start/keepalive/clear so
 * the badge stays alive across long calls without flooding disk
 * writes. The 5s keepalive matches the widget's safety-net poll
 * cadence; the widget computes elapsed locally so a stable
 * `startedAt` plus periodic refresh is enough.
 *
 * `last-used.json` is a sidecar persisted on successful dispatch so
 * the widget can keep showing the last-dispatched instance after
 * heartbeat clears. Failed dispatches skip the write - showing
 * "Big Pickle" after a failed call would be misleading.
 */

function writeOpenCodeHeartbeat(payload) {
  try {
    if (!existsSync(OPENCODE_ROUTES_DIR)) mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
    const tmp = `${OPENCODE_HEARTBEAT_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, OPENCODE_HEARTBEAT_PATH);
  } catch {
    // best-effort - widget falls back to idle on missing/invalid file
  }
}

function clearOpenCodeHeartbeat() {
  try {
    if (existsSync(OPENCODE_HEARTBEAT_PATH)) unlinkSync(OPENCODE_HEARTBEAT_PATH);
  } catch {
    // best-effort
  }
}

/** Skip writing last-used.json when meta.instanceId is missing or is
 * a bare target keyword ("local" / "opencode" / "codex"). The widget's
 * `activeInstanceFrom` resolves last-used by id against the catalog;
 * a target-keyword id never matches an entry there and silently flips
 * the widget back to `activeInstanceId` (typically Big Pickle), which
 * the user reads as "I dispatched to Local LLM but the widget jumped
 * back to Big Pickle". Skipping the write preserves whatever real
 * last-used was there before, OR leaves the widget on activeInstanceId
 * if nothing was ever set - either of which is a true outcome. */
const TARGET_KEYWORDS = new Set(["local", "opencode", "codex"]);

function writeOpenCodeLastUsed(meta) {
  if (
    typeof meta?.instanceId !== "string" ||
    meta.instanceId.length === 0 ||
    TARGET_KEYWORDS.has(meta.instanceId)
  ) {
    return;
  }
  try {
    if (!existsSync(OPENCODE_ROUTES_DIR)) mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
    const payload = {
      instanceId: meta.instanceId,
      alias: meta.alias,
      dataRetention: meta.dataRetention,
      model: meta.model || "",
      at: new Date().toISOString(),
    };
    const tmp = `${OPENCODE_LAST_USED_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, OPENCODE_LAST_USED_PATH);
  } catch {
    // best-effort
  }
}

/** Smoothed tps tracker. Mirrors the windowed math in
 * `src/shared/sessionTokens/tpsTracker.ts` so OpenCode and Local
 * dispatches read in the same magnitude as Claude/Codex.
 *
 * Idle gaps reset the window (a tool-wait pause would otherwise smear
 * the rate). Min window age + min token delta block the first
 * sample-pair from spiking when the first SSE chunk lands. Window
 * threshold (2s) matches the 2s poll cadence so a short bridge
 * dispatch (4-6 seconds is common) reports a real rate before
 * completing instead of staying at 0/s.
 *
 * `lastObservedTokens` is durable across the idle-gap clear: the
 * unchanged-tokens guard reads this marker, not `samples`. Without
 * it, a stale-token sample arriving after an idle clear would push
 * the stale value as a fresh baseline (samples is empty, `last !==
 * undefined` short-circuits) and the next real sample would average
 * against an artificially-old timestamp.
 *
 * `awaitingBaseline` mirrors the TS tracker: the first sample after
 * a session start or idle-gap clear is consumed as a baseline anchor
 * (updates `lastObservedTokens`, does not enter `samples`). The
 * rollback branch leaves `awaitingBaseline` cleared because
 * `lastObservedTokens = totalTokens` already pins the post-compact
 * floor; the next sample with new tokens enters the window directly.
 * Without the baseline anchor, the first computable window measures
 * from "tokens already accumulated when we started watching" to
 * "tokens after first new chunk", which on Codex's first turn caps
 * the rate at 999/s. */
function makeTpsComputer() {
  const TPS_MAX = 999;
  const TPS_WINDOW_MS = 60_000;
  const TPS_IDLE_GAP_MS = 10_000;
  const TPS_MIN_WINDOW_AGE_MS = 2_000;
  const TPS_MIN_TOKEN_DELTA = 2;
  const samples = [];
  let lastValue = 0;
  let lastObservedTokens = null;
  let awaitingBaseline = true;
  // Wall-clock millis of the last NEW (different-tokens) sample. Lets
  // the unchanged-tokens path clear `lastValue` after TPS_IDLE_GAP_MS
  // of real-time silence - the bridge's char-progress events stop
  // arriving when a turn ends, so without this the tooltip pins the
  // last in-flight rate forever.
  let lastSampleWallMs = 0;

  return (atMs, totalTokens) => {
    const nowWall = Date.now();
    if (
      lastSampleWallMs > 0 &&
      nowWall - lastSampleWallMs > TPS_IDLE_GAP_MS
    ) {
      samples.length = 0;
      lastValue = 0;
      awaitingBaseline = true;
    }
    const last = samples[samples.length - 1];
    if (lastObservedTokens !== null && totalTokens < lastObservedTokens) {
      // Rollback path. lastObservedTokens=totalTokens is the post-
      // rollback anchor; awaitingBaseline stays cleared so the next
      // sample with new tokens enters the window directly.
      samples.length = 0;
      lastValue = 0;
      lastObservedTokens = totalTokens;
    } else if (last !== undefined && atMs - last.atMs > TPS_IDLE_GAP_MS) {
      samples.length = 0;
      awaitingBaseline = true;
    }
    if (lastObservedTokens !== null && totalTokens === lastObservedTokens) {
      return lastValue;
    }
    lastSampleWallMs = nowWall;
    if (awaitingBaseline) {
      lastObservedTokens = totalTokens;
      awaitingBaseline = false;
      return lastValue;
    }
    samples.push({ atMs, tokens: totalTokens });
    lastObservedTokens = totalTokens;
    const cutoff = atMs - TPS_WINDOW_MS;
    while (samples.length > 1 && samples[0].atMs < cutoff) {
      samples.shift();
    }
    if (samples.length < 2) return lastValue;
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const tokenDelta = newest.tokens - oldest.tokens;
    const timeDeltaMs = newest.atMs - oldest.atMs;
    if (timeDeltaMs < TPS_MIN_WINDOW_AGE_MS) return lastValue;
    if (tokenDelta < TPS_MIN_TOKEN_DELTA) return lastValue;
    lastValue = Math.min(TPS_MAX, (tokenDelta / timeDeltaMs) * 1000);
    return lastValue;
  };
}

export async function withOpenCodeHeartbeat(meta, runDispatch) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestId = randomUUID();
  let tokens = 0;
  let tokensPerSec = 0;
  const computeTps = makeTpsComputer();

  // Engine heartbeat lets the bridge stage coordinator animate the
  // 5-stage glyph walker for SYNC (and adaptive-falls-through-to-sync)
  // non-Codex dispatches. Previously only the FF path wrote engine
  // heartbeats (extension-side OpenCodeDispatcher); sync dispatches
  // here only wrote the OpenCode widget heartbeat, leaving the bridge
  // widget blank. wsHash falls back to `workspaceId()` (which is
  // already a hash of workspacePath; the extension installer injects
  // it as `WAT321_WORKSPACE_ID`). Target defaults to "opencode" when
  // meta.target isn't set so a legacy caller still emits a usable
  // heartbeat - readers filter on workspaceHash first, so the wrong
  // target value here just means the post-dispatch resource tooltip
  // attributes the turn to the wrong backend, not a missed animation.
  const wsHash =
    typeof meta?.workspaceHash === "string" && meta.workspaceHash.length > 0
      ? meta.workspaceHash
      : workspaceId();
  const target = meta?.target === "local" ? "local" : "opencode";
  const waitMode =
    meta?.waitMode === "standard" ||
    meta?.waitMode === "adaptive" ||
    meta?.waitMode === "fire-and-forget"
      ? meta.waitMode
      : undefined;
  let currentStage = "dispatched";

  const writeBeat = () => {
    writeOpenCodeHeartbeat({
      phase: "calling",
      requestId,
      startedAt,
      alias: meta.alias,
      instanceId: meta.instanceId,
      dataRetention: meta.dataRetention,
      model: meta.model || "",
      timeoutMs: meta.timeoutMs,
      tokens,
      tokensPerSec,
      currentPhase: "DISPATCH",
      phaseTrace: [],
    });
    writeEngineHeartbeat({
      dispatchId: requestId,
      target,
      workspacePath: "",
      workspaceHash: wsHash,
      stage: currentStage,
      activeTool: null,
      toolCallCount: 0,
      elapsedMs: Date.now() - startedAtMs,
      lastProgressAt: Date.now(),
      turnStartedAt: startedAtMs,
      waitMode,
    });
  };
  // ~4 chars/token English approximation so the widget reads in the
  // same magnitude as Claude/Codex (which read real
  // `usage.output_tokens` from transcripts) instead of inflating 4x.
  const updateProgress = (charCount) => {
    if (typeof charCount !== "number" || charCount < 0) return;
    const approxTokens = Math.round(charCount / 4);
    tokens = approxTokens;
    tokensPerSec = Math.round(computeTps(Date.now(), approxTokens));
    // First real progress = response is streaming back. Coordinator
    // moves stage 1 (dispatched) -> stage 3 (working) target, walker
    // min-holds carry it through stage 2 naturally.
    if (currentStage === "dispatched") currentStage = "working";
    writeBeat();
  };
  writeBeat();
  const interval = setInterval(writeBeat, HEARTBEAT_KEEPALIVE_MS);
  try {
    const result = await runDispatch(updateProgress);
    if (result && result.ok !== false) {
      writeOpenCodeLastUsed(meta);
      // Final stage push so the coordinator's walker advances to
      // stage 5 (complete) via fast-walk instead of orphan-grace-
      // dropping the latch at the last seen target. Returning flag
      // is what flips stage 4's alternating glyph to the left-arrow
      // "reply imminent" frame.
      currentStage = "complete";
      writeBeat();
      writeReturningFlag(wsHash);
    }
    return result;
  } finally {
    clearInterval(interval);
    clearOpenCodeHeartbeat();
    deleteEngineHeartbeat(requestId);
  }
}
