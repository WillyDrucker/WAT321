import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clientStateDir } from "../wat321Paths";

/**
 * [WAT-DEBUG] Append-only JSONL log of notification-path decisions at
 * `<clientStateDir>/notification-events.jsonl`. Bounded rolling
 * head-truncate at 1MB. Raw `writeFileSync` with `{ flag: "a" }` is
 * intentional - the atomic-write helper would clobber the prior log
 * on every append.
 *
 * Every `logNotifEvent` callsite is part of the `[WAT-DEBUG]` surface
 * for missing-notification post-mortems. Surfaces feeding this log
 * today: session-switch (per provider), bridge-decision (fire / gate),
 * dedup-decision, notifier-decision (toast outcome). `grep -rn
 * "logNotifEvent\\|\\[WAT-DEBUG\\]" src/` pulls the full
 * instrumentation set for review or wholesale removal.
 */

const EVENT_LOG_FILENAME = "notification-events.jsonl";
const EVENT_LOG_MAX_BYTES = 1_000_000;

type NotifEventKind =
  | "session-switch"
  | "bridge-decision"
  | "dedup-decision"
  | "notifier-decision";

/** Specific gate or fire path inside `sessionResponseBridge`. Shared
 * with the bridge so the literal union has a single home; the
 * `fire-*` prefix is load-bearing for the bridge's
 * `reason.startsWith("fire-")` check. */
export type BridgeDecisionReason =
  | "fire-context-increase"
  | "fire-done-transition"
  | "fire-path-switch-completion"
  | "fire-non-active-completion"
  | "suppress-first-read"
  | "suppress-mtime-stale"
  | "suppress-no-trigger";

interface BaseEvent {
  at: number;
  kind: NotifEventKind;
}

interface SessionSwitchEvent extends BaseEvent {
  kind: "session-switch";
  provider: "claude" | "codex";
  fromPath: string | null;
  toPath: string | null;
  /** UUIDs derived from `fromPath` / `toPath` so log readers can
   * grep `sessionId=<uuid>` without parsing filenames. Per-session
   * IDs from Claude / Codex are throw-away by nature - each session
   * gets a fresh UUID, and a session that ends never reuses it -
   * so persisting them in the forensic log carries no risk of
   * confusing a future session. */
  fromSessionId: string | null;
  toSessionId: string | null;
  /** Where the new path came from. Diagnostic label only - the
   * service does not branch on this, but it lets the log reader
   * distinguish a live-process pick from a lastKnown fallback from a
   * Codex rollout scan without re-deriving from the path shape. */
  source: "live" | "lastKnown" | "rollout-scan";
}

interface BridgeDecisionEvent extends BaseEvent {
  kind: "bridge-decision";
  provider: "claude" | "codex";
  path: string | null;
  /** Per-session UUID derived from `path`. Same throw-away rationale
   * as `SessionSwitchEvent.fromSessionId`. */
  sessionId: string | null;
  decision: "fire" | "suppress";
  reason: BridgeDecisionReason;
  contextChanged: boolean;
  isIncrease: boolean;
  classifierDone: boolean;
  mtimeFresh: boolean;
  isPathSwitch: boolean;
  isNewPath: boolean;
}

interface DedupDecisionEvent extends BaseEvent {
  kind: "dedup-decision";
  provider: "claude" | "codex";
  sessionId: string;
  completionBucket: number;
  claimed: boolean;
}

interface NotifierDecisionEvent extends BaseEvent {
  kind: "notifier-decision";
  provider: "claude" | "codex";
  /** Per-session UUID at the time of delivery. Empty string when
   * the toast carries no per-session context (rare - bridge fires
   * with a session id today, but the union allows future event
   * kinds that legitimately lack it). */
  sessionId: string;
  mode: string;
  outcome: string;
  focused: boolean;
}

type NotifEvent =
  | SessionSwitchEvent
  | BridgeDecisionEvent
  | DedupDecisionEvent
  | NotifierDecisionEvent;

function eventLogPath(): string {
  return join(clientStateDir(), EVENT_LOG_FILENAME);
}

/** Derive the per-session UUID from a transcript / rollout path.
 * Centralized here so every event emitter populates `sessionId`
 * consistently without re-importing provider-specific parsers.
 *
 *  - Claude: `~/.claude/projects/<projectKey>/<UUID>.jsonl` -
 *    sessionId is the filename without extension.
 *  - Codex:  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl`
 *    where `<ts>` is `YYYY-MM-DDThh-mm-ss` (six dash-separated
 *    parts). The UUID is everything after the sixth dash; older
 *    rollout filenames without the timestamp still hash through the
 *    full basename fallback. */
export function sessionIdFromPath(
  provider: "claude" | "codex",
  path: string | null
): string | null {
  if (!path) return null;
  const file = basename(path, ".jsonl");
  if (provider === "claude") return file;
  const parts = file.split("-");
  return parts.length > 6 ? parts.slice(6).join("-") : file;
}

/** Append a single event to the JSONL log. Best-effort: a failed
 * write is silently ignored so a disk problem never disrupts the
 * notification path itself. */
export function logNotifEvent(event: NotifEvent): void {
  try {
    const path = eventLogPath();
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a" });
    try {
      const stat = readFileSync(path, "utf8");
      if (stat.length > EVENT_LOG_MAX_BYTES) {
        writeFileSync(path, stat.slice(-EVENT_LOG_MAX_BYTES));
      }
    } catch {
      // best-effort
    }
  } catch {
    // best-effort
  }
}
