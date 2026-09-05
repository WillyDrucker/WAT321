import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope, type Envelope, type EnvelopeTarget } from "./envelope";
import { allInboundDirs, sentDir } from "./inboxPaths";

/**
 * Unified reader for inbound (reply) envelopes across every backend.
 *
 * "Late reply" = an envelope sitting in an inbound dir whose original
 * MCP `wat321_ask` call has already returned (either FF intentional
 * early return, sync timeout, or adaptive abort). The user can drain
 * these via `wat321_bridge()` or surface them through the status bar
 * widget's late-reply picker.
 *
 * Threshold: envelopes younger than `LATE_REPLY_THRESHOLD_MS` are
 * NOT counted as pending. Active prompts poll the same dir at
 * sub-200ms intervals and consume their matching reply within a
 * tick, so a brief gate prevents the inbox coordinator from flashing
 * the mail icon for replies that the active wat321_ask is about to
 * claim. 1 second is well past the sync poll's tick cadence and
 * keeps the user-visible mail-pulse delay imperceptible (any longer
 * is noticeable after Codex finishes its stage walk - any shorter
 * narrows the safety margin against a slow sync poll). */

const LATE_REPLY_THRESHOLD_MS = 1_000;

export interface DrainedReply {
  target: EnvelopeTarget;
  filename: string;
  fullPath: string;
  envelope: Envelope;
  /** Pre-computed sent/ destination so the caller can move-after-
   * format without re-deriving paths. */
  sentDestPath: string;
  sizeKb: number;
  // === Flattened convenience fields (mirror the parsed envelope) ===
  /** Reply body text (same as `envelope.body`). */
  body: string;
  /** ISO timestamp (same as `envelope.createdAt`). */
  createdAt: string;
  /** Codex-side intent or "reply" / "ff-reply" / "ff-error" for
   * non-Codex. Mirrors `envelope.intent` with a sensible default. */
  intent: string;
}

/** Walk all inbound dirs for the workspace and return their stat-able
 * `.md` entries that pass the late-reply staleness gate. Internal
 * helper consumed by `listLateReplies`, `countPendingLateReplies`,
 * and `newestLateReplyAgeMs`. */
function walkInboundFiles(
  workspacePath: string | null,
  predicate: (mtimeMs: number) => boolean
): { target: EnvelopeTarget; dir: string; filename: string; fullPath: string; mtimeMs: number; size: number }[] {
  const out: {
    target: EnvelopeTarget;
    dir: string;
    filename: string;
    fullPath: string;
    mtimeMs: number;
    size: number;
  }[] = [];
  for (const { target, dir } of allInboundDirs(workspacePath)) {
    try {
      if (!existsSync(dir)) continue;
      for (const filename of readdirSync(dir)) {
        if (!filename.endsWith(".md")) continue;
        const fullPath = join(dir, filename);
        try {
          const st = statSync(fullPath);
          if (!predicate(st.mtimeMs)) continue;
          out.push({
            target,
            dir,
            filename,
            fullPath,
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return out;
}

/** Pending late reply count across every inbound dir for the workspace. */
export function countPendingLateReplies(workspacePath: string | null): number {
  if (!workspacePath) return 0;
  const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
  return walkInboundFiles(workspacePath, (m) => m < cutoff).length;
}

/** Milliseconds since the newest pending reply landed. Drives the
 * status bar's mail pulse arrival animation. */
export function newestLateReplyAgeMs(workspacePath: string | null): number | null {
  if (!workspacePath) return null;
  const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
  let newest = 0;
  for (const f of walkInboundFiles(workspacePath, (m) => m < cutoff)) {
    if (f.mtimeMs > newest) newest = f.mtimeMs;
  }
  return newest === 0 ? null : Date.now() - newest;
}

/** Fully parsed late-reply list for the picker UI. Parses envelopes
 * via the unified parser - entries that fail to parse are skipped
 * with no error surfaced (best-effort - corrupt files shouldn't
 * break the picker). */
export function listLateReplies(workspacePath: string | null): DrainedReply[] {
  if (!workspacePath) return [];
  const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
  const out: DrainedReply[] = [];
  for (const f of walkInboundFiles(workspacePath, (m) => m < cutoff)) {
    try {
      const raw = readFileSync(f.fullPath, "utf8");
      const env = parseEnvelope(raw);
      if (env === null) continue;
      out.push({
        target: f.target,
        filename: f.filename,
        fullPath: f.fullPath,
        envelope: env,
        sentDestPath: join(sentDir(f.target, workspacePath), f.filename),
        sizeKb: Math.ceil(f.size / 1024),
        body: env.body,
        createdAt: env.createdAt,
        intent:
          env.intent ||
          (env.error
            ? "ff-error"
            : env.target === "codex"
              ? "reply"
              : "ff-reply"),
      });
    } catch {
      // skip malformed / unreadable
    }
  }
  return out;
}
