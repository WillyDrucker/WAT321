import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicWrite.mjs";
import { OPENCODE_LAST_USED_PATH } from "../routesConfig.mjs";
import {
  deleteTurnHeartbeat,
  writeReturningFlag,
  writeTurnHeartbeat,
} from "../turnHeartbeat.mjs";
import { openCodeRoutesStateDir, workspaceId } from "../wat321Paths.mjs";
import { makeTpsComputer } from "./tpsComputer.mjs";

/**
 * Dispatch heartbeat for the opencode and local targets. Two files:
 *
 *   - The OpenCode Routes heartbeat (`heartbeat.json` in the Routes
 *     state dir) that the Routes widget renders as a live "calling"
 *     badge with token progress. Per-client state dir already
 *     partitions per workspace, so no hash suffix is needed.
 *   - The engine turn heartbeat (`turnHeartbeat.mjs`) that the bridge
 *     stage coordinator animates the 5-stage walker from, so sync
 *     dispatches play the same ceremony Codex and FF dispatches play.
 *
 * `withOpenCodeHeartbeat` wraps a dispatch with start/keepalive/clear.
 * The 5s keepalive matches the widget's safety-net poll cadence, and
 * the widget computes elapsed locally so a stable `startedAt` plus
 * periodic refresh is enough. `last-used.json` is persisted on
 * successful dispatch so the widget keeps showing the last-dispatched
 * instance after the heartbeat clears. Failed dispatches skip the
 * write, since showing "Big Pickle" after a failed call would mislead.
 */

const OPENCODE_HEARTBEAT_PATH = join(openCodeRoutesStateDir(), "heartbeat.json");
const HEARTBEAT_KEEPALIVE_MS = 5_000;

function writeOpenCodeHeartbeat(payload) {
  try {
    writeFileAtomic(OPENCODE_HEARTBEAT_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // best-effort, the widget falls back to idle on a missing file
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
 * a bare target keyword. The widget's `activeInstanceFrom` resolves
 * last-used by id against the catalog. A target-keyword id never
 * matches an entry there and silently flips the widget back to
 * `activeInstanceId` (typically Big Pickle), which the user reads as
 * "I dispatched to Local LLM but the widget jumped back to Big
 * Pickle". Skipping the write preserves whatever real last-used was
 * there before. */
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
    writeFileAtomic(
      OPENCODE_LAST_USED_PATH,
      `${JSON.stringify({
        instanceId: meta.instanceId,
        alias: meta.alias,
        dataRetention: meta.dataRetention,
        model: meta.model || "",
        at: new Date().toISOString(),
      })}\n`
    );
  } catch {
    // best-effort
  }
}

export async function withOpenCodeHeartbeat(meta, runDispatch) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestId = randomUUID();
  let tokens = 0;
  let tokensPerSec = 0;
  const computeTps = makeTpsComputer();

  // wsHash falls back to `workspaceId()` (already a hash of the
  // workspace path, injected by the installer). Target defaults to
  // "opencode" when meta.target is unset so a caller that omits the
  // field still emits a usable heartbeat. Readers filter on
  // workspaceHash first, so a wrong target here only misattributes
  // the turn in the post-dispatch tooltip, never misses an animation.
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
    writeTurnHeartbeat({
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
    // First real progress = the response is streaming back. The
    // coordinator moves stage 1 (dispatched) -> stage 3 (working)
    // target, walker min-holds carry it through stage 2 naturally.
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
      // dropping the latch at the last seen target. The returning
      // flag flips stage 4's alternating glyph to the left-arrow
      // "reply imminent" frame.
      currentStage = "complete";
      writeBeat();
      writeReturningFlag(wsHash);
    }
    return result;
  } finally {
    clearInterval(interval);
    clearOpenCodeHeartbeat();
    deleteTurnHeartbeat(requestId);
  }
}
