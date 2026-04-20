import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Epic Handshake shared paths and flag locations. Everything the
 * tier writes lives under `~/.wat321/epic-handshake/` so Reset WAT321
 * wipes it cleanly. No other writes outside this root.
 */

export const EPIC_HANDSHAKE_DIR = join(homedir(), ".wat321", "epic-handshake");

/** Inbox directories. Files land here when a message is addressed
 * to the named agent. Dispatcher drains `inbox/codex/`; the MCP
 * server's `epic_handshake_ask` tool drains `inbox/claude/` on its
 * next invocation via the late-reply preamble. */
export const INBOX_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "claude");
export const INBOX_CODEX_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "codex");

/** Sent archives. Delivered envelopes move here so they never
 * re-deliver. Dispatcher sweeps sent/codex at 5min; inbox/claude
 * 1h TTL sweep also lands here. */
export const SENT_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "sent", "claude");
export const SENT_CODEX_DIR = join(EPIC_HANDSHAKE_DIR, "sent", "codex");

/** Bin directory. Holds `channel.mjs` plus its prod-only
 * `node_modules/` copy extracted from the extension at install
 * time. Claude's own CLI points at `channel.mjs` via
 * `claude mcp add -s user wat321 -- node <path>`. */
export const BIN_DIR = join(EPIC_HANDSHAKE_DIR, "bin");

/** Flag file the dispatcher writes while a Codex turn is running.
 * Status bar stats this file every refresh tick to render the
 * arrow-circle-right animation. Cleared in a `finally` on turn
 * end; orphaned flags are cleaned by the tier on activate. */
export const IN_FLIGHT_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "in-flight.flag");

/** Flag file written for 5000ms after a successful turn so the
 * arrow-circle-left "reply returning to Claude" animation has a
 * clear minimum airtime. Reply-transfer itself is <500ms of physical
 * travel; the extended TTL keeps the user oriented to what just
 * happened - a shorter latch was easy to miss. */
export const RETURNING_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "returning.flag");

/** Flag file written when Codex emits its first streaming delta and
 * cleared on turn completion. Presence = "Codex accepted the turn
 * and is actively producing output" - a stronger signal than the
 * in-flight flag, which covers dispatcher-side preparation too.
 * Drives the comment-discussion animation in the status bar. */
export const PROCESSING_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "processing.flag");

/** Cancellation sentinel. Status bar's "Cancel in-flight prompt"
 * action writes this file; the dispatcher's runTurnOnce polls for
 * it every 500ms while a turn is in progress and, when it appears,
 * sends `turn/interrupt` to Codex and rejects the pending promise.
 * The rejection path then writes a "cancelled by user" reply to
 * inbox/claude/ so the blocked MCP tool call unblocks cleanly. */
export const CANCEL_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "cancel.flag");

/** Fire-and-forget mode sentinel. Status bar toggles it; channel.mjs
 * reads it at the start of each `epic_handshake_ask` invocation. When
 * present, the tool returns immediately with a "dispatched, check
 * inbox later" message instead of blocking for up to 120s. Per-session
 * by design: the tier's clearStaleRuntimeFiles sweep deletes this on
 * every activate so a fresh VS Code window always starts in Standard
 * (blocking) mode. */
export const FIRE_AND_FORGET_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "fire-and-forget.flag");

/** Wait-mode toggle visual flash sentinel. Body is the ISO timestamp
 * the toggle fired at; the status bar reads the mtime to compute the
 * 2500ms 5-frame bolt/square sequence and renders idle once the
 * window elapses. Cleared by the next refresh tick after expiry. */
export const WAIT_MODE_FLASH_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "wait-mode-flash.flag");

/** Pause sentinel. Body is the ISO timestamp the user paused at.
 * When present, the dispatcher skips new envelopes and the status
 * bar renders the pause glyph. Persists across VS Code restarts by
 * design: a paused bridge should stay paused until the user un-pauses. */
export const PAUSED_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "paused.flag");
