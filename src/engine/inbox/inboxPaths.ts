import { join } from "node:path";
import type { BridgeTarget } from "../bridgeTypes";
import { bridgeStateDir, EPIC_HANDSHAKE_DIR } from "../wat321Paths";
import { workspaceHash } from "../workspaceHash";

/**
 * Single source of truth for inbox / outbound / sent directory paths
 * across every backend: dispatchers, status bar widgets, and the
 * coordinator derive paths here instead of inlining "inbox" / "sent"
 * segments. `WAT321_EPIC_HANDSHAKE/epicHandshakePaths.ts` carries the
 * same Codex layout for that tier, and the MCP runtime mirrors both in
 * `WAT321_MCP_SERVER/bin/epicHandshakePaths.mjs`.
 *
 * codex (Epic Handshake mailbox, partitioned by workspace hash):
 * outbound `<EPIC_HANDSHAKE_DIR>/inbox/codex/<wsHash>/<id>.md`, inbound
 * `.../inbox/claude/<wsHash>/<id>.md`, sent `.../sent/claude/<wsHash>/`.
 * opencode / local (per-client bridge mailbox): outbound
 * `<bridgeStateDir>/dispatch/<target>/<id>.md`, inbound
 * `.../inbox/<target>/`, sent `.../sent/<target>/`. The Codex layout
 * cannot move: the bridge is enabled by default in existing installs
 * and a new layout would orphan pending envelopes.
 */

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

function outboundDir(
  target: BridgeTarget,
  workspacePath: string | null
): string {
  if (target === "codex") {
    return ehInboxCodexDir(workspacePath ? workspaceHash(workspacePath) : "default");
  }
  return join(bridgeStateDir(), "dispatch", target);
}

export function inboundDir(
  target: BridgeTarget,
  workspacePath: string | null
): string {
  if (target === "codex") {
    return ehInboxClaudeDir(workspacePath ? workspaceHash(workspacePath) : "default");
  }
  return join(bridgeStateDir(), "inbox", target);
}

export function sentDir(
  target: BridgeTarget,
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
  target: BridgeTarget;
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
  target: BridgeTarget;
  dir: string;
}[] {
  return [
    { target: "codex", dir: outboundDir("codex", workspacePath) },
    { target: "opencode", dir: outboundDir("opencode", workspacePath) },
    { target: "local", dir: outboundDir("local", workspacePath) },
  ];
}
