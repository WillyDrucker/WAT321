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

/** EH-owned bin directory. Holds the clipboard-staging helper
 * (`stage-clipboard.mjs`). The unified MCP server (`channel.mjs`) now
 * lives under `~/.wat321/bridge/bin/` at project scope - see
 * `WAT321_MCP_SERVER/installer.ts`. */
export const BIN_DIR = join(EPIC_HANDSHAKE_DIR, "bin");

/** Per-workspace turn flag path helpers. Every runtime sentinel is
 * partitioned by workspace hash so toggling wait mode, pausing the
 * bridge, or running a turn in one VS Code window never leaks into a
 * sibling. `turn-heartbeat.<envelopeId>.json` is keyed by envelope
 * (per-call) rather than by workspace, but its reader filters on the
 * `workspaceHash` field inside the JSON. */
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
 * on successful turn completion - the toast notifier consumes-and-
 * deletes it when Codex's transcript-driven `responseComplete` fires
 * within the freshness window. Decouples bridge-completion suppression
 * from the 5s `returning` flag latch so a slow Codex transcript write
 * (>5s after RPC completion) still gets suppressed. */
export function suppressCodexToastFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `suppress-codex-toast.${wsHash}.flag`);
}

/** Per-workspace toggle for Codex bridge sandbox. When present, Codex
 * sessions in this workspace run with `danger-full-access` instead of
 * the default `read-only`. Toggled live via the Codex Session Settings
 * picker. Read on every `turn/start` so toggling takes effect on the
 * next prompt without a thread reset.
 *
 * Workspace-scoped so two VS Code windows on the same machine can
 * carry different sandbox preferences for different projects (test
 * instance + main dev, project A vs project B, etc.). Mirrors the
 * partitioning of in-flight / processing / paused flags. */
export function codexSandboxFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `codex-sandbox.${wsHash}.flag`);
}

/** Companion sentinel that records whether the user has ever explicitly
 * set the sandbox state for this workspace (regardless of which value
 * they picked). Used to drive the "*default*" tag in the picker - the
 * tag should appear on truly pristine slots (fresh install, post-Reset)
 * and disappear once the user makes any choice, even if their choice
 * happens to match the schema default (read-only). Without this, every
 * read-only slot would re-render *default* after the user explicitly
 * picked it, which reads as "you haven't done anything" when they have.
 *
 * Sentinel is write-once-then-stays - no logic deletes it short of
 * Reset wiping `~/.wat321/`. */
export function codexSandboxTouchedFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `codex-sandbox-touched.${wsHash}.flag`);
}

/** RETIRED per-workspace model override. Body is the bare slug (e.g.
 * `gpt-5.4-mini`).
 *
 * Superseded by the per-session `model` field on `BridgeThreadRecord`.
 * A workspace-scoped pin bled across every session in a folder and
 * outlived the session it was chosen for. Nothing writes this path any
 * more: `migrateLegacyPin` reads it once to adopt a choice an existing
 * user already made, then `clearLegacyCodexPinFlags` deletes it. Kept
 * only so that migration and the Reset sweep can name the file. */
export function codexModelFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `codex-model.${wsHash}.flag`);
}

/** RETIRED per-workspace reasoning-effort override. Body is the bare
 * effort level (e.g. `xhigh`). Same history and same migration path as
 * the model flag above. */
export function codexEffortFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `codex-effort.${wsHash}.flag`);
}

/** Pre-partition root-level sentinels. Retired by the activate-time
 * sweep - runtime code only reads `<name>.<wsHash>.flag` paths. */
export const LEGACY_FLAG_PATHS: readonly string[] = [
  join(EPIC_HANDSHAKE_DIR, "in-flight.flag"),
  join(EPIC_HANDSHAKE_DIR, "processing.flag"),
  join(EPIC_HANDSHAKE_DIR, "returning.flag"),
  join(EPIC_HANDSHAKE_DIR, "cancel.flag"),
  join(EPIC_HANDSHAKE_DIR, "wait-mode-flash.flag"),
  join(EPIC_HANDSHAKE_DIR, "fire-and-forget.flag"),
  join(EPIC_HANDSHAKE_DIR, "adaptive.flag"),
  join(EPIC_HANDSHAKE_DIR, "paused.flag"),
];

/** Per-workspace fire-and-forget sticky-mode sentinel read by
 * `channel.mjs` when no per-call `fire_and_forget` arg is passed.
 * Session-scoped: `clearStaleRuntimeFiles` deletes on every activate
 * so a fresh window starts in sync mode. */
export function fireAndForgetFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `fire-and-forget.${wsHash}.flag`);
}

/** Per-workspace pause sentinel. ISO timestamp body. While present,
 * this window's dispatcher skips new envelopes and the status bar
 * renders the pause glyph. Persists across VS Code restarts. */
export function pausedFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `paused.${wsHash}.flag`);
}

/** Per-workspace adaptive sticky-mode sentinel. When present (and
 * fire-and-forget is absent), `channel.mjs` extends the MCP blocking
 * window while the heartbeat is fresh instead of using the 120s
 * standard cap. Persists across VS Code restarts. */
export function adaptiveFlagPath(wsHash: string): string {
  return join(EPIC_HANDSHAKE_DIR, `adaptive.${wsHash}.flag`);
}

/** Path for the per-turn heartbeat file the dispatcher writes on
 * every monitor stage transition. Body is JSON: stage, fraction,
 * activeTool, elapsedMs, lastProgressAt. Read by channel.mjs to
 * extend its MCP blocking window while Codex is progressing, and
 * by statusBarItem.ts to render stage fraction + tooltip detail. */
export function turnHeartbeatPath(envelopeId: string): string {
  return join(EPIC_HANDSHAKE_DIR, `turn-heartbeat.${envelopeId}.json`);
}
