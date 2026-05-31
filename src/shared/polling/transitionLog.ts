import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";

/**
 * Persistent ring-buffer log of usage-service state transitions for
 * one provider in one workspace. Captures the historical evidence the
 * in-memory diagnostics throw away on a successful fetch (kickstart
 * resets, absorbs counter zeroes), so a user diagnosing "widget went
 * idle randomly" can run `WAT321: Show Provider Health` AFTER the
 * widget has already recovered and still see the park->wake sequence.
 *
 * Append-only JSONL at the configured path with rotation when the
 * file grows past `MAX_LINES_BEFORE_ROTATE`: rewrite atomically with
 * the most recent `KEEP_LINES` entries. One file per provider per
 * workspace; the per-window state machine is the natural granularity
 * for this log because the cross-window cache only ever holds a
 * single most-recent snapshot.
 *
 * Best-effort: every write path is wrapped in try/catch so a
 * filesystem hiccup never blocks the poller. A missing or corrupt
 * file just reads as empty.
 */

export type TransitionStatus =
  | "loading"
  | "ok"
  | "rate-limited"
  | "no-auth"
  | "token-expired"
  | "offline"
  | "error"
  | "not-connected";

export type TransitionReason =
  | "fetch-attempted"
  | "fetch-ok"
  | "fetch-429-absorbed"
  | "fetch-429-parked"
  | "fetch-429-strike-retry"
  | "fetch-auth-error"
  | "fetch-network-error"
  | "fetch-other-error"
  | "wake-from-park"
  | "kickstart-skipped-idle"
  | "auth-missing"
  | "auth-dir-vanished"
  | "discovery-recovered"
  | "cache-adopted"
  | "recovery-ceiling-hit";

export interface TransitionRecord {
  at: number;
  provider: "claude" | "codex";
  from: TransitionStatus;
  to: TransitionStatus;
  reason: TransitionReason;
  isColdStart?: boolean;
  consecutiveColdStartAbsorbs?: number;
  consecutiveFailedKickstarts?: number;
  retryAfterMs?: number;
  serverMessage?: string;
  /** Wall-clock ms since the activity probe (session-token mtime)
   * last saw a transcript write, or null when the probe has no signal
   * (no session resolved yet). The kickstart gate's idle/active
   * decision is `idleForMs > KICKSTART_ACTIVITY_WINDOW_MS` (30s) - a
   * value over that threshold at the moment of a 429 absorb or park
   * is the smoking gun for "I was actively using Claude but the widget
   * didn't kickstart because typing-in-input-box isn't a transcript
   * write." */
  idleForMs?: number | null;
  /** Current poll cadence in ms at the moment of the record. Normal is
   * `POLL_INTERVAL_MS` (122_000); rate-limited park raises this to
   * `retryAfterMs` (up to `RATE_LIMIT_BACKOFF_MS`, 15 minutes).
   * Sudden cadence drops point at unintentional fast-poll loops; long
   * stretches at the rate-limit cadence point at "we haven't tried in
   * a while" idle-feel even when the state is technically ok. */
  pollIntervalMs?: number;
  /** Age in ms of the cross-window cache entry the record adopted.
   * Only set on `cache-adopted` reasons. Helps distinguish "this
   * window read a fresh cache another window just wrote" from "this
   * window read its own stale cache and skipped the API call." */
  cacheAgeMs?: number;
}

const KEEP_LINES = 100;
const MAX_LINES_BEFORE_ROTATE = 120;
const SERVER_MESSAGE_MAX = 120;

function truncateServerMessage(msg: string | undefined): string | undefined {
  if (msg === undefined) return undefined;
  if (msg.length <= SERVER_MESSAGE_MAX) return msg;
  return `${msg.slice(0, SERVER_MESSAGE_MAX)}...`;
}

/** Append a transition record. Rotates the file in-place if it has
 * grown past the cap. Idempotent on missing directory. */
export function logTransition(filePath: string, record: TransitionRecord): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const normalized: TransitionRecord = {
      ...record,
      serverMessage: truncateServerMessage(record.serverMessage),
    };
    appendFileSync(filePath, `${JSON.stringify(normalized)}\n`);
    rotateIfNeeded(filePath);
  } catch {
    // best-effort
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length <= MAX_LINES_BEFORE_ROTATE) return;
    const kept = lines.slice(-KEEP_LINES);
    writeFileAtomic(filePath, `${kept.join("\n")}\n`);
  } catch {
    // best-effort
  }
}

/** Read the most recent `limit` transitions. Oldest first within the
 * returned slice. Malformed lines are skipped. Returns empty array
 * when the file is missing. */
export function readRecentTransitions(
  filePath: string,
  limit: number
): TransitionRecord[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-limit);
    const out: TransitionRecord[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as TransitionRecord;
        if (
          typeof parsed.at === "number" &&
          typeof parsed.from === "string" &&
          typeof parsed.to === "string"
        ) {
          out.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}
