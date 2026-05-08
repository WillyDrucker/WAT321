import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_KEEPALIVE_MS,
  MB_DIR,
  MB_HEARTBEAT_PATH,
  MB_LAST_USED_PATH,
} from "./common.mjs";

/**
 * Cross-tier dispatch heartbeat. The OpenCode Routes widget + Epic Handshake widgets
 * read `heartbeat.<wsHash>.json` to render a live "calling" badge while
 * an OpenCode dispatch is in flight. Per-workspace partition keeps a
 * sibling VS Code window from lighting up when this workspace fires.
 *
 * `withMbHeartbeat` wraps a dispatch with start/keepalive/clear so
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

function writeMbHeartbeat(payload) {
  try {
    if (!existsSync(MB_DIR)) mkdirSync(MB_DIR, { recursive: true });
    const tmp = `${MB_HEARTBEAT_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, MB_HEARTBEAT_PATH);
  } catch {
    // best-effort - widget falls back to idle on missing/invalid file
  }
}

function clearMbHeartbeat() {
  try {
    if (existsSync(MB_HEARTBEAT_PATH)) unlinkSync(MB_HEARTBEAT_PATH);
  } catch {
    // best-effort
  }
}

function writeMbLastUsed(meta) {
  try {
    if (!existsSync(MB_DIR)) mkdirSync(MB_DIR, { recursive: true });
    const payload = {
      instanceId: meta.instanceId,
      alias: meta.alias,
      dataRetention: meta.dataRetention,
      model: meta.model || "",
      at: new Date().toISOString(),
    };
    const tmp = `${MB_LAST_USED_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, MB_LAST_USED_PATH);
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
 * sample-pair from spiking when the first SSE chunk lands. Bridge
 * dispatches often complete in 4-6 seconds, so the window threshold
 * matches the 2s poll cadence rather than the 5s used for long-running
 * transcripts - a short dispatch otherwise reports 0/s for its
 * entire duration.
 *
 * `lastObservedTokens` is durable across the idle-gap clear: the
 * unchanged-tokens guard reads this marker, not `samples`. Without
 * it, a stale-token sample arriving after an idle clear would push
 * the stale value as a fresh baseline (samples is empty, `last !==
 * undefined` short-circuits) and the next real sample would average
 * against an artificially-old timestamp.
 *
 * `awaitingBaseline` mirrors the TS tracker: the first sample after
 * a session start, rollback, or idle-gap clear is consumed as a
 * baseline anchor (updates `lastObservedTokens`, does not enter
 * `samples`). Without it, the first computable window measures from
 * "tokens already accumulated when we started watching" to "tokens
 * after first new chunk", which on Codex's first turn caps the rate
 * at 999/s. */
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

  return (atMs, totalTokens) => {
    const last = samples[samples.length - 1];
    if (lastObservedTokens !== null && totalTokens < lastObservedTokens) {
      // Rollback path. Mirrors the TS tracker's clear-lastValue behavior
      // even though pushProgress is monotonic-gated upstream - keeps
      // semantics identical so a future caller cannot surface a stale
      // rate.
      samples.length = 0;
      lastValue = 0;
      lastObservedTokens = totalTokens;
      awaitingBaseline = true;
    } else if (last !== undefined && atMs - last.atMs > TPS_IDLE_GAP_MS) {
      samples.length = 0;
      awaitingBaseline = true;
    }
    if (lastObservedTokens !== null && totalTokens === lastObservedTokens) {
      return lastValue;
    }
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

export async function withMbHeartbeat(meta, runDispatch) {
  const startedAt = new Date().toISOString();
  const requestId = randomUUID();
  let tokens = 0;
  let tokensPerSec = 0;
  const computeTps = makeTpsComputer();

  const writeBeat = () => {
    writeMbHeartbeat({
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
  };
  // ~4 chars/token English approximation so the widget reads in the
  // same magnitude as Claude/Codex (which read real
  // `usage.output_tokens` from transcripts) instead of inflating 4x.
  const updateProgress = (charCount) => {
    if (typeof charCount !== "number" || charCount < 0) return;
    const approxTokens = Math.round(charCount / 4);
    tokens = approxTokens;
    tokensPerSec = Math.round(computeTps(Date.now(), approxTokens));
    writeBeat();
  };
  writeBeat();
  const interval = setInterval(writeBeat, HEARTBEAT_KEEPALIVE_MS);
  try {
    const result = await runDispatch(updateProgress);
    if (result && result.ok !== false) {
      writeMbLastUsed(meta);
    }
    return result;
  } finally {
    clearInterval(interval);
    clearMbHeartbeat();
  }
}
