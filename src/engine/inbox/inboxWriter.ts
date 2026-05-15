import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../shared/fs/atomicWrite";
import {
  serializeEnvelope,
  type Envelope,
  type EnvelopeTarget,
} from "./envelope";
import { inboundDir, outboundDir } from "./inboxPaths";

/**
 * Unified writer for outbound dispatch envelopes and inbound reply
 * envelopes. Atomic via tmp+rename so a half-written file never
 * appears in a directory that fs-watchers or pollers might pick up.
 *
 * All writers go through this module so the parent-dir creation,
 * atomic-write discipline, and path layout stay in one place. The
 * MCP runtime's mjs callers can't import this TypeScript module
 * directly, so the runtime has its own minimal writer (in
 * `WAT321_MCP_SERVER/bin/`) that mirrors this contract.
 */

function ensureParent(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

/** Write an outbound (Claude -> backend) envelope. Dispatchers
 * fs-watch the outbound dir and pick up this file on rename. */
export function writeOutbound(
  env: Envelope,
  workspacePath: string | null
): string {
  const dir = outboundDir(env.target, workspacePath);
  const path = join(dir, `${env.id}.md`);
  ensureParent(path);
  writeFileAtomic(path, serializeEnvelope(env));
  return path;
}

/** Write an inbound (backend -> Claude) envelope. The MCP poller
 * and the inbox coordinator watch the inbound dir; this lands a
 * reply visible to both within ~50ms. */
export function writeInbound(
  env: Envelope,
  workspacePath: string | null
): string {
  const dir = inboundDir(env.target, workspacePath);
  const path = join(dir, `${env.id}.md`);
  ensureParent(path);
  writeFileAtomic(path, serializeEnvelope(env));
  return path;
}

/** Build the inbound envelope path for a given id without writing,
 * so callers can probe for an existing reply file (e.g. the MCP
 * poll-for-reply loop). */
export function inboundPathFor(
  target: EnvelopeTarget,
  id: string,
  workspacePath: string | null
): string {
  return join(inboundDir(target, workspacePath), `${id}.md`);
}
