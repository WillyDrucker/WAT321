import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../shared/fs/atomicWrite";
import { workspaceHash } from "../../shared/workspaceHash";
import {
  buildInboundEnvelope,
  readEnvelope,
  type Envelope,
  type EnvelopeTarget,
} from "../inbox/envelope";
import { EH_ROOT_DIR, allOutboundDirs, sentDir } from "../inbox/inboxPaths";
import { writeInbound } from "../inbox/inboxWriter";

/**
 * Envelope-side I/O helpers for `OutboundWatcher`. These are all
 * best-effort: every disk operation catches its own failure and
 * returns, because a single failed write must never crash the
 * watcher loop (the next poll tick / next session sweep will retry).
 *
 *   - `writeReturningFlag` drops the per-workspace returning flag
 *     for the shared bridge-stage animation.
 *   - `moveOutboundToSent` retires an outbound envelope after dispatch
 *     so the watcher doesn't pick it up again.
 *   - `writeShutdownEnvelope` deposits a synthetic "cancelled by
 *     shutdown" reply when VS Code closes mid-dispatch.
 *   - `sweepStaleOutboundEnvelopes` runs once at activate, retires
 *     anything older than the stale cutoff with an "abandoned from
 *     previous session" reply.
 */

const STALE_OUTBOUND_MS = 5 * 60_000;

/** Best-effort write of `~/.wat321/epic-handshake/returning.<wsHash>.flag`
 * with a self-clearing 3s timer. Mirrors Codex's turnRunner returning-
 * flag so a non-Codex dispatch's return ceremony hits the same 3-second
 * window the rest of the bridge UI is built around. The unref'd timer
 * lets the dispatcher shut down without waiting on cleanup. Atomic
 * tmp+rename so a status-bar reader cannot observe a torn write. */
export function writeReturningFlag(workspacePath: string): void {
  try {
    const wsHash = workspaceHash(workspacePath);
    const path = join(EH_ROOT_DIR, `returning.${wsHash}.flag`);
    if (!existsSync(EH_ROOT_DIR)) {
      mkdirSync(EH_ROOT_DIR, { recursive: true });
    }
    writeFileAtomic(path, new Date().toISOString());
    const t = setTimeout(() => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }, 3_000);
    t.unref?.();
  } catch {
    // missed flag write costs one animation frame
  }
}

/** Move (or as a last-resort, unlink) the outbound envelope after
 * dispatch so the watcher doesn't pick it up on the next poll tick.
 * Failure here leaves a stale file the next activation's sweep
 * catches. */
export function moveOutboundToSent(
  target: EnvelopeTarget,
  outboundPath: string,
  workspacePath: string
): void {
  try {
    const sent = join(
      sentDir(target, workspacePath),
      `outbound.${dirname(outboundPath).split(/[/\\]/).pop()}.${Date.now()}.md`
    );
    const sentParent = dirname(sent);
    if (!existsSync(sentParent)) mkdirSync(sentParent, { recursive: true });
    renameSync(outboundPath, sent);
  } catch {
    try {
      unlinkSync(outboundPath);
    } catch {
      // best-effort
    }
  }
}

export function writeShutdownEnvelope(
  envelope: Envelope,
  workspacePath: string | null
): void {
  try {
    const inbound = buildInboundEnvelope({
      target: envelope.target,
      body:
        `[Dispatch cancelled by VS Code shutdown.]\n\nThis fire-and-forget dispatch to ${
          envelope.alias || envelope.target
        } was in flight when VS Code closed. The backend may or may not have completed it; no reply was captured by the bridge.`,
      replyToId: envelope.id,
      workspacePath: workspacePath ?? envelope.workspacePath,
      alias: envelope.alias,
      error: true,
    });
    writeInbound(inbound, workspacePath ?? null);
  } catch {
    // best-effort
  }
}

/** Sweep outbound dirs at startup for envelopes left over from a
 * previous session. Any file older than the stale cutoff that no
 * in-flight tracker claims gets an "abandoned" reply envelope and
 * is moved to sent/ so the dispatcher doesn't pick it up again. */
export function sweepStaleOutboundEnvelopes(workspacePath: string): void {
  const cutoff = Date.now() - STALE_OUTBOUND_MS;

  for (const { target, dir } of allOutboundDirs(workspacePath)) {
    if (!existsSync(dir)) continue;
    let filenames: string[];
    try {
      filenames = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const fullPath = join(dir, filename);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > cutoff) continue;
      const env = readEnvelope(fullPath);
      if (env === null) {
        moveOutboundToSent(target, fullPath, workspacePath);
        continue;
      }
      try {
        const inbound = buildInboundEnvelope({
          target,
          body:
            `[Dispatch abandoned from previous session.]\n\nThis fire-and-forget dispatch to ${
              env.alias || env.target
            } was queued ${Math.round(
              (Date.now() - mtimeMs) / 60_000
            )} minute(s) ago but never completed. The previous VS Code session ended before the backend replied; this envelope was retired during startup cleanup.`,
          replyToId: env.id,
          workspacePath,
          alias: env.alias,
          error: true,
        });
        writeInbound(inbound, workspacePath);
      } catch {
        // best-effort
      }
      moveOutboundToSent(target, fullPath, workspacePath);
    }
  }
}
