import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { readFirstLine, readHead, readTail } from "../../engine/fs/fileReaders";

/**
 * The model slug a Codex rollout carries, read three ways and rewritten
 * one way. `readRolloutModelSlug` answers what `thread/resume` will ship
 * (the header), `readRolloutEffectiveModel` answers what the session was
 * created with when the header is silent, and `readRolloutLatestModel`
 * answers what the session was last running. `rewriteRolloutModelSlug`
 * repairs a header whose slug the CLI no longer recognizes. Callers own
 * the bridge-ownership gate, nothing here checks it.
 */

/** Read `session_meta.payload.model` from the rollout header. Locked
 * at session creation - every `thread/resume` ships this value to the
 * API. A slug that's no longer in the user's Codex `models_cache.json`
 * (because the CLI upgraded and renamed or retired that model) 404s
 * on the next resume. The dispatcher uses this to gate broken sessions
 * at pre-flight instead of letting them fail mid-turn. */
export function readRolloutModelSlug(rolloutPath: string): string | null {
  const firstLine = readFirstLine(rolloutPath);
  if (firstLine === null) return null;
  try {
    const entry = JSON.parse(firstLine) as {
      type?: string;
      payload?: { model?: unknown };
    };
    if (entry.type !== "session_meta") return null;
    const model = entry.payload?.model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

/** How many leading rollout lines `readRolloutEffectiveModel` will scan
 * for a `turn_context`. The event is emitted at the head of the first
 * turn, so it lands within the first few lines or not at all. */
const TURN_CONTEXT_SCAN_LINES = 12;

/** The model a rollout's session ACTUALLY ran, not just what its header
 * declares.
 *
 * `session_meta.payload.model` is absent on rollouts written by older
 * Codex CLIs, which recorded the model only on the `turn_context` event
 * at the head of the first turn. `readRolloutModelSlug` returns null for
 * those, which is the right answer for its own callers (they gate on the
 * value `thread/resume` ships) but the wrong answer when the question is
 * "what has this session been running".
 *
 * Used by the session-pin migration, where a null would mean adopting
 * Codex's current default and silently moving a long-lived session onto
 * a new model. Falls back to the header, then to the first
 * `turn_context.model`, then to null. */
export function readRolloutEffectiveModel(rolloutPath: string): string | null {
  const fromHeader = readRolloutModelSlug(rolloutPath);
  if (fromHeader !== null) return fromHeader;

  // Generous cap: `session_meta` alone routinely runs 15-25KB and keeps
  // growing as Codex adds metadata, and `turn_context` follows it. A cap
  // that truncated the header would leave line 0 unparseable and abort
  // the scan before reaching the line we came for.
  const raw = readHead(rolloutPath, 262_144);
  if (raw === null) return null;
  const lines = raw.split("\n");
  for (const line of lines.slice(0, TURN_CONTEXT_SCAN_LINES)) {
    if (line.length === 0) continue;
    let entry: { type?: string; payload?: { model?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      // A truncated final line is expected when the head cap splits an
      // event. Stop rather than keep scanning garbage.
      break;
    }
    if (entry.type !== "turn_context") continue;
    const model = entry.payload?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/** Tail windows tried in order when hunting for the newest
 * `turn_context`, stopping at the first that finds one.
 *
 * `turn_context` is emitted at the START of a turn, so the tail of a
 * rollout is the middle of that turn's output, not its header. A single
 * long turn on a real 4.7MB rollout buried the last `turn_context` more
 * than 256KB from the end, and a 26MB rollout buried it further. The
 * windows escalate rather than starting large because the common case
 * (a short final turn) is answered by the first, and only a genuinely
 * long final turn pays for the bigger reads.
 *
 * The last entry is deliberately larger than any rollout observed. A
 * recovery is a rare, explicit user action, so reading the file once is
 * an acceptable price for getting the model right. */
const LATEST_MODEL_TAIL_WINDOWS = [262_144, 4_194_304, 33_554_432] as const;

/** The model a session was running MOST RECENTLY, by scanning backward
 * from the end of its rollout for the newest `turn_context.model`.
 *
 * Distinct from `readRolloutEffectiveModel`, which answers "what was
 * this session created with" by reading forward from the header. Both
 * questions are legitimate and they differ for any session whose model
 * changed mid-life:
 *   - `thread/resume` ships `session_meta.model`, so the header is the
 *     right answer for resume validation and rollout repair.
 *   - Recovering a session into the bridge should adopt what it was LAST
 *     running, because that is the state the user is returning to.
 *
 * Falls back to the creation model when the tail carries no parseable
 * `turn_context`, which is the case for a session that never completed
 * a turn. */
export function readRolloutLatestModel(rolloutPath: string): string | null {
  let previousLength = -1;
  for (const window of LATEST_MODEL_TAIL_WINDOWS) {
    const raw = readTail(rolloutPath, window);
    if (raw === null) break;
    // A window that read no more than the last one means we already have
    // the whole file. Rescanning it at a larger size finds nothing new.
    if (raw.length <= previousLength) break;
    previousLength = raw.length;

    const found = lastTurnContextModel(raw);
    if (found !== null) return found;
  }
  return readRolloutEffectiveModel(rolloutPath);
}

/** Newest `turn_context.model` in a chunk of rollout lines, scanning
 * backward. Null when the chunk holds none.
 *
 * The first line of a tail window is almost always truncated mid-JSON.
 * It simply fails to parse and is skipped, which is why an unparseable
 * line continues the scan rather than ending it. */
function lastTurnContextModel(raw: string): string | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length === 0) continue;
    let entry: { type?: string; payload?: { model?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "turn_context") continue;
    const model = entry.payload?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/** Rewrite `session_meta.payload.model` on a bridge-owned rollout to a
 * valid slug. Only the first line gets modified - every subsequent
 * turn event passes through byte-for-byte. Writes to a tmp file and
 * atomic-renames so a partial write cannot leave the rollout truncated.
 *
 * Caller owns the ownership gate (thread_name match + cwd match). This
 * helper just performs the edit - it does NOT verify the rollout is
 * bridge-owned, so never call with a rollout path you haven't already
 * gated. Returns true on successful rewrite, false on any failure
 * (unreadable, unparseable first line, write error, rename EBUSY on
 * Windows when Codex has the file open mid-turn). */
export function rewriteRolloutModelSlug(
  rolloutPath: string,
  newSlug: string
): boolean {
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, "utf8");
  } catch {
    return false;
  }
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return false;
  const firstLine = raw.slice(0, newlineIdx);
  const remainder = raw.slice(newlineIdx);
  let entry: {
    type?: string;
    payload?: Record<string, unknown>;
    [k: string]: unknown;
  };
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return false;
  }
  if (entry.type !== "session_meta" || !entry.payload) return false;
  entry.payload = { ...entry.payload, model: newSlug };
  let rewrittenFirstLine: string;
  try {
    rewrittenFirstLine = JSON.stringify(entry);
  } catch {
    return false;
  }
  // Windows may reject rename-over-open-file with EBUSY if Codex's
  // app-server has the rollout open. Caller's job to advise the user
  // to ensure no turn is mid-flight before retrying.
  return writeFileAtomic(rolloutPath, rewrittenFirstLine + remainder);
}
