import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";
import { serializeEnvelope, type Envelope } from "./envelope";
import { inboundDir } from "./inboxPaths";

/**
 * Writer for inbound (backend -> Claude) reply envelopes. Atomic via
 * tmp+rename so a half-written file never appears in a directory that
 * fs-watchers or pollers might pick up. Outbound envelopes are written
 * by the MCP runtime, which cannot import this TypeScript module and
 * carries its own writer under `WAT321_MCP_SERVER/bin/` that mirrors
 * the envelope contract.
 */

/** Write an inbound envelope. The MCP poller and the inbox
 * coordinator watch the inbound dir, so a reply lands visible to both
 * within ~50ms. */
export function writeInbound(
  env: Envelope,
  workspacePath: string | null
): string {
  const dir = inboundDir(env.target, workspacePath);
  const path = join(dir, `${env.id}.md`);
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileAtomic(path, serializeEnvelope(env));
  return path;
}
