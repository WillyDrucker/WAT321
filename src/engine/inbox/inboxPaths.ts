import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeStateDir } from "../../shared/wat321Paths";
import { workspaceHash } from "../../shared/workspaceHash";
import type { EnvelopeTarget } from "./envelope";

/**
 * Single source of truth for inbox / outbound / sent directory paths
 * across every backend. Centralizing the layout here means dispatchers,
 * MCP runtime, status bar widgets, and the coordinator all derive
 * paths from the same function instead of inlining `join(...)` calls
 * with literal "inbox" / "sent" segments.
 *
 * Layout per target:
 *
 *   codex (Epic Handshake legacy paths):
 *     outbound: ~/.wat321/epic-handshake/inbox/codex/<wsHash>/<id>.md
 *     inbound:  ~/.wat321/epic-handshake/inbox/claude/<wsHash>/<id>.md
 *     sent:     ~/.wat321/epic-handshake/sent/claude/<wsHash>/<id>.md
 *
 *   opencode / local (per-client bridge mailbox):
 *     outbound: <bridgeStateDir>/dispatch/<target>/<id>.md
 *     inbound:  <bridgeStateDir>/inbox/<target>/<id>.md
 *     sent:     <bridgeStateDir>/sent/<target>/<id>.md
 *
 * The Codex paths are encoded directly here rather than imported from
 * `WAT321_EPIC_HANDSHAKE/constants`. Engine is the authoritative router
 * for the unified inbox abstraction across targets - reverse-importing
 * from a tool tier would invert the dep-direction rule (engine never
 * depends on tiers). The EH tier still owns the same path constants
 * for its own internal use - this file just stops piggybacking on
 * those exports to keep the dep arrow one-way.
 *
 * The Codex paths are kept on their historical layout because the
 * Epic Handshake bridge is enabled-by-default in many existing
 * installs and changing the layout would orphan pending envelopes.
 * Non-Codex paths live under the per-client bridge state dir so
 * multiple VS Code windows don't share inboxes.
 */

const EPIC_HANDSHAKE_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CODEX_ROOT = join(EPIC_HANDSHAKE_DIR, "inbox", "codex");
const INBOX_CLAUDE_ROOT = join(EPIC_HANDSHAKE_DIR, "inbox", "claude");
const SENT_CLAUDE_ROOT = join(EPIC_HANDSHAKE_DIR, "sent", "claude");

function ehInboxCodexDir(wsHash: string): string {
  return join(INBOX_CODEX_ROOT, wsHash);
}
function ehInboxClaudeDir(wsHash: string): string {
  return join(INBOX_CLAUDE_ROOT, wsHash);
}
function ehSentClaudeDir(wsHash: string): string {
  return join(SENT_CLAUDE_ROOT, wsHash);
}

export function outboundDir(
  target: EnvelopeTarget,
  workspacePath: string | null
): string {
  if (target === "codex") {
    return ehInboxCodexDir(workspacePath ? workspaceHash(workspacePath) : "default");
  }
  return join(bridgeStateDir(), "dispatch", target);
}

export function inboundDir(
  target: EnvelopeTarget,
  workspacePath: string | null
): string {
  if (target === "codex") {
    return ehInboxClaudeDir(workspacePath ? workspaceHash(workspacePath) : "default");
  }
  return join(bridgeStateDir(), "inbox", target);
}

export function sentDir(
  target: EnvelopeTarget,
  workspacePath: string | null
): string {
  if (target === "codex") {
    return ehSentClaudeDir(workspacePath ? workspaceHash(workspacePath) : "default");
  }
  return join(bridgeStateDir(), "sent", target);
}

/** All inbound (reply) directories the active workspace could see
 * envelopes land in. Used by the multi-target inbox coordinator and
 * the unified `wat321_bridge()` drain. */
export function allInboundDirs(workspacePath: string | null): {
  target: EnvelopeTarget;
  dir: string;
}[] {
  return [
    { target: "codex", dir: inboundDir("codex", workspacePath) },
    { target: "opencode", dir: inboundDir("opencode", workspacePath) },
    { target: "local", dir: inboundDir("local", workspacePath) },
  ];
}

/** All outbound directories. Stage-4 graceful-shutdown sweep walks
 * these to detect abandoned dispatches from a previous VS Code
 * session. */
export function allOutboundDirs(workspacePath: string | null): {
  target: EnvelopeTarget;
  dir: string;
}[] {
  return [
    { target: "codex", dir: outboundDir("codex", workspacePath) },
    { target: "opencode", dir: outboundDir("opencode", workspacePath) },
    { target: "local", dir: outboundDir("local", workspacePath) },
  ];
}

/** Root dir for Codex's Epic Handshake state. Exported for migration
 * code that needs to manipulate paths beyond the inbox/sent layout. */
export const EH_ROOT_DIR = EPIC_HANDSHAKE_DIR;
