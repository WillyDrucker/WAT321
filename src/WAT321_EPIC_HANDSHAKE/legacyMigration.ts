import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  cancelFlagPath,
  FIRE_AND_FORGET_FLAG_PATH,
  inboxClaudeDir,
  inboxCodexDir,
  INBOX_CLAUDE_ROOT,
  INBOX_CODEX_ROOT,
  inFlightFlagPath,
  LEGACY_FLAG_PATHS,
  processingFlagPath,
  returningFlagPath,
  sentClaudeDir,
  sentCodexDir,
  suppressCodexToastFlagPath,
  waitModeFlashFlagPath,
} from "./constants";
import { parseEnvelope } from "./envelope";
import type { EpicHandshakeLogger } from "./types";
import { workspaceHash } from "./workspaceHash";

/**
 * Activate-time housekeeping. Two distinct one-time sweeps that both
 * need to run before the dispatcher binds, otherwise the dispatcher
 * could pick up legacy envelopes from the wrong workspace or render
 * stale runtime flags as if a turn were active.
 *
 *   - `migrateLegacyEnvelopes`: moves root-level legacy envelopes
 *     (`inbox/codex/<id>.md`) into the partitioned workspace layout
 *     (`inbox/codex/<wshash>/<id>.md`). Idempotent. Safe to run
 *     forever - subsequent activates find nothing in the root.
 *
 *   - `clearStaleRuntimeFiles`: deletes per-workspace runtime flags
 *     left behind by a prior crash (in-flight, processing, returning,
 *     cancel, wait-mode flash, suppress-codex-toast) and drops the
 *     user-scope fire-and-forget sentinel so activation restores the
 *     configured default wait mode. Pending inbox replies are
 *     deliberately preserved (the 1h TTL inside `sweepStaleInboxMail`
 *     handles genuinely-stale entries on subsequent dispatches).
 *     Paused and adaptive flags intentionally survive across restarts.
 */

/** Move root-level legacy envelopes into the partitioned workspace
 * layout. Routes by the envelope's own `workspace_path` field;
 * unparseable or workspace-less envelopes archive to
 * `sent/<dir>/legacy/` for human inspection. */
export function migrateLegacyEnvelopes(logger: EpicHandshakeLogger): void {
  migrateLegacyDir(INBOX_CODEX_ROOT, "codex", logger);
  migrateLegacyDir(INBOX_CLAUDE_ROOT, "claude", logger);
}

function migrateLegacyDir(
  rootDir: string,
  kind: "codex" | "claude",
  logger: EpicHandshakeLogger
): void {
  if (!existsSync(rootDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }
  let migrated = 0;
  let orphaned = 0;
  for (const f of entries) {
    // Skip subdirectories (the new partitioned layout) and non-md.
    const src = join(rootDir, f);
    if (!f.endsWith(".md")) continue;
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }

    // Parse to recover workspace identity.
    let envWsHash: string | null = null;
    try {
      const env = parseEnvelope(readFileSync(src, "utf8"));
      if (env?.workspacePath) envWsHash = workspaceHash(env.workspacePath);
    } catch {
      // unparseable - falls through to orphan path
    }

    const dest =
      envWsHash !== null
        ? kind === "codex"
          ? join(inboxCodexDir(envWsHash), f)
          : join(inboxClaudeDir(envWsHash), f)
        : kind === "codex"
          ? join(sentCodexDir("legacy"), f)
          : join(sentClaudeDir("legacy"), f);

    try {
      const destDir = join(dest, "..");
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      writeFileAtomic(dest, readFileSync(src));
      unlinkSync(src);
      if (envWsHash !== null) migrated++;
      else orphaned++;
    } catch {
      // best-effort per file
    }
  }
  if (migrated > 0 || orphaned > 0) {
    logger.info(
      `legacy ${kind} envelope migration: ${migrated} routed to workspace subfolders, ${orphaned} archived as orphans`
    );
  }
}

/** Sweep any orphan runtime files left behind by a prior crash or
 * abrupt VS Code exit. Called once on activate. The 1h safety TTL
 * for in-inbox mail (`sweepStaleInboxMail` in mailbox.ts, fires on
 * every bridge dispatch) handles genuinely-stale replies; this
 * function only clears short-lived sentinels (in-flight, processing,
 * returning, cancel, wait-mode flash) that a prior crash could have
 * left in a misleading state.
 *
 * **Pending late replies in inbox/claude/ are preserved.** Issue #64:
 * a Codex reply that landed in the inbox immediately before VS Code
 * restarted (long-running fire-and-forget scrape, mid-flight close)
 * must survive activation so the next `epic_handshake_inbox` /
 * `epic_handshake_ask` call can deliver it. The earlier "clean slate"
 * sweep that moved every pending reply to sent/ on activate caused
 * silent reply loss; the 1h TTL on subsequent dispatches catches truly
 * stale entries without stranding fresh ones. */
export function clearStaleRuntimeFiles(): void {
  const ws0 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const hash = ws0 ? workspaceHash(ws0) : null;
  try {
    if (hash) {
      const removeIfExists = (path: string): void => {
        if (existsSync(path)) unlinkSync(path);
      };
      removeIfExists(inFlightFlagPath(hash));
      removeIfExists(processingFlagPath(hash));
      removeIfExists(returningFlagPath(hash));
      removeIfExists(cancelFlagPath(hash));
      removeIfExists(waitModeFlashFlagPath(hash));
      // Suppress-toast sentinel is per-turn and consume-on-read; any
      // leftover from a prior session is by definition stale and would
      // otherwise eat the first unrelated Codex toast in this session.
      removeIfExists(suppressCodexToastFlagPath(hash));
    }
    // Legacy root-level flag files from before workspace partitioning.
    // Delete so the partitioned dispatcher never reads them - the
    // active dispatcher only consumes per-workspace flag paths.
    for (const legacyPath of LEGACY_FLAG_PATHS) {
      if (existsSync(legacyPath)) unlinkSync(legacyPath);
    }
    // Fire-and-forget is per-session by design: clearing the sentinel
    // here lets activation restore the configured default wait mode
    // (Adaptive unless the user picked Fire-and-Forget in settings).
    // Adaptive flag intentionally survives so the user's preference
    // is preserved across reloads.
    if (existsSync(FIRE_AND_FORGET_FLAG_PATH)) unlinkSync(FIRE_AND_FORGET_FLAG_PATH);
    // Paused state intentionally persists across restarts: if the
    // user paused the bridge, they expect it to stay paused after a
    // VS Code reload, not silently un-pause.
  } catch {
    // best-effort
  }
  // Per-workspace inbox sweep is intentionally NOT performed here.
  // Issue #64: archiving fresh inbox replies on activate caused silent
  // reply loss when VS Code restarted while a Codex turn was finishing
  // (Codex writes the reply to inbox -> VS Code restarts -> activate
  // moves the reply to sent/ -> next inbox check returns empty even
  // though the work completed). The 1h TTL inside `sweepStaleInboxMail`
  // (mailbox.ts) runs on every subsequent bridge dispatch and handles
  // genuinely-stale entries without racing fresh ones.
}
