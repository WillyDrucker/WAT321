import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Epic Handshake shared paths and flag locations. Everything the
 * tier writes lives under `~/.wat321/epic-handshake/` so Reset WAT321
 * wipes it cleanly. No other writes outside this root.
 */

export const EPIC_HANDSHAKE_DIR = join(homedir(), ".wat321", "epic-handshake");

/** Inbox + sent root directories. Envelopes are partitioned per
 * workspace inside each one (e.g. `inbox/codex/<wshash>/<id>.md`)
 * so multiple VS Code instances on different workspaces don't race
 * on a shared `inbox/codex/` folder. Use the `inboxCodexDir(wsHash)`
 * etc. helpers below to resolve the per-workspace path. The bare
 * roots are still exported for housekeeping callers that need to
 * walk every workspace's subfolder. */
export const INBOX_CLAUDE_ROOT = join(EPIC_HANDSHAKE_DIR, "inbox", "claude");
export const INBOX_CODEX_ROOT = join(EPIC_HANDSHAKE_DIR, "inbox", "codex");
export const SENT_CLAUDE_ROOT = join(EPIC_HANDSHAKE_DIR, "sent", "claude");
export const SENT_CODEX_ROOT = join(EPIC_HANDSHAKE_DIR, "sent", "codex");

/** Per-workspace inbox/sent path helpers. wsHash is the 16-hex
 * identifier from `workspaceHash(workspacePath)` - matches the
 * `bridge-thread.<wshash>.json` naming so a single workspace
 * occupies one consistent identity across every artifact. */
export function inboxCodexDir(wsHash: string): string {
  return join(INBOX_CODEX_ROOT, wsHash);
}
export function inboxClaudeDir(wsHash: string): string {
  return join(INBOX_CLAUDE_ROOT, wsHash);
}
export function sentCodexDir(wsHash: string): string {
  return join(SENT_CODEX_ROOT, wsHash);
}
export function sentClaudeDir(wsHash: string): string {
  return join(SENT_CLAUDE_ROOT, wsHash);
}

/** Bin directory. Holds `channel.mjs` plus its prod-only
 * `node_modules/` copy extracted from the extension at install
 * time. Claude's own CLI points at `channel.mjs` via
 * `claude mcp add -s user wat321 -- node <path>`. */
export const BIN_DIR = join(EPIC_HANDSHAKE_DIR, "bin");

/** Per-workspace turn flag path helpers. Each flag is partitioned by
 * workspace hash so one workspace's in-flight turn does not light up
 * the Epic Handshake status bar in a sibling VS Code instance. The
 * older shared `<name>.flag` files were the bleed source caught
 * during isolated-instance testing: primary and test windows both
 * read the same file, both rendered "busy" regardless of which
 * workspace's dispatcher actually owned the turn.
 *
 * Kept user-scope on purpose:
 *   - `paused.flag` - pausing the bridge applies to all workspaces.
 *   - `adaptive.flag` / `fire-and-forget.flag` - user preference.
 *   - `turn-heartbeat.<envelopeId>.json` - already unique per envelope.
 */
export function inFlightFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `in-flight.${wsHash}.flag`);
}
export function processingFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `processing.${wsHash}.flag`);
}
export function returningFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `returning.${wsHash}.flag`);
}
export function cancelFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `cancel.${wsHash}.flag`);
}
export function waitModeFlashFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `wait-mode-flash.${wsHash}.flag`);
}
/** Per-workspace consume-on-read sentinel. Written by the dispatcher
 * on successful turn completion; the toast notifier consumes-and-
 * deletes it when Codex's transcript-driven `responseComplete` fires
 * within the freshness window. Decouples bridge-completion suppression
 * from the 5s `returning` flag latch so a slow Codex transcript write
 * (>5s after RPC completion) still gets suppressed. */
export function suppressCodexToastFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `suppress-codex-toast.${wsHash}.flag`);
}

/** User-scope toggle for Codex bridge sandbox. When present, Codex
 * sessions run with `danger-full-access` instead of the default
 * `read-only`. Toggled live via the sessions submenu so the user can
 * experiment with permissions without touching settings. Read in two
 * places:
 *   - `threadLifecycle.spawnFreshThread` at `thread/start` (kebab
 *     string form, `sandbox` param)
 *   - `turnRunner.runTurnOnce` at every `turn/start` (camelCase
 *     object form, `sandboxPolicy.type`)
 * Because the flag is read on every turn, toggling takes effect on
 * the next prompt without needing a thread reset. */
export const CODEX_FULL_ACCESS_FLAG_PATH = join(
  EPIC_HANDSHAKE_DIR,
  "codex-full-access.flag"
);

/** Legacy root-level flag paths. Only referenced by the one-time
 * migration sweep at activate that cleans up v1.2.0 leftovers and
 * pre-partition v1.2.1 writes. Runtime code never reads these. */
export const LEGACY_FLAG_PATHS: readonly string[] = [
  join(EPIC_HANDSHAKE_DIR, "in-flight.flag"),
  join(EPIC_HANDSHAKE_DIR, "processing.flag"),
  join(EPIC_HANDSHAKE_DIR, "returning.flag"),
  join(EPIC_HANDSHAKE_DIR, "cancel.flag"),
  join(EPIC_HANDSHAKE_DIR, "wait-mode-flash.flag"),
];

/** Fire-and-forget mode sentinel. User preference, applies to all
 * workspaces on this user account. Status bar toggles it; channel.mjs
 * reads it at the start of each `epic_handshake_ask` invocation. When
 * present, the tool returns immediately with a "dispatched, check
 * inbox later" message instead of blocking for up to 120s. Per-session
 * by design: the tier's clearStaleRuntimeFiles sweep deletes this on
 * every activate so a fresh VS Code window always starts in Standard
 * (blocking) mode. */
export const FIRE_AND_FORGET_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "fire-and-forget.flag");

/** Pause sentinel. Body is the ISO timestamp the user paused at.
 * When present, the dispatcher skips new envelopes and the status
 * bar renders the pause glyph. Persists across VS Code restarts by
 * design: a paused bridge should stay paused until the user un-pauses. */
export const PAUSED_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "paused.flag");

/** Adaptive wait mode sentinel. When present (and fire-and-forget is
 * absent), the bridge uses TurnMonitor's progress-aware stall
 * detection instead of the fixed 120s Standard timeout. Channel.mjs
 * polls the heartbeat file to extend its blocking window while
 * Codex is demonstrably working. Persists across VS Code restarts
 * like paused so user's wait-mode choice sticks. */
export const ADAPTIVE_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, "adaptive.flag");

/** Path for the per-turn heartbeat file the dispatcher writes on
 * every monitor stage transition. Body is JSON: stage, fraction,
 * activeTool, elapsedMs, lastProgressAt. Read by channel.mjs to
 * extend its MCP blocking window while Codex is progressing, and
 * by statusBarItem.ts to render stage fraction + tooltip detail. */
export function turnHeartbeatPath(envelopeId: string): string {
  return join(EPIC_HANDSHAKE_DIR, `turn-heartbeat.${envelopeId}.json`);
}
