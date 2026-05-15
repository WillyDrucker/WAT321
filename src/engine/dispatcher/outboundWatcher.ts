import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { workspaceHash } from "../../shared/workspaceHash";
import {
  buildInboundEnvelope,
  readEnvelope,
  type Envelope,
  type EnvelopeTarget,
} from "../inbox/envelope";
import { EH_ROOT_DIR, allOutboundDirs, sentDir } from "../inbox/inboxPaths";
import { writeInbound } from "../inbox/inboxWriter";
import type { BackendDispatcher, DispatchResult } from "./dispatcherTypes";

/**
 * Engine-side outbound watcher. fs-watches every backend's outbound
 * dispatch dir for new envelopes, hands each to the matching tier's
 * `BackendDispatcher.run` implementation, and writes the resulting
 * inbound envelope so the MCP-side poller can pick it up.
 *
 * Per-target dispatcher registration lets the engine handle dispatch
 * orchestration uniformly while each tier owns its run-turn semantics
 * (Codex spawns app-server; OpenCode posts HTTP/SSE; future targets
 * implement whatever fits their backend).
 *
 * Graceful shutdown:
 *   - On dispose(), broadcasts an AbortSignal to every in-flight
 *     dispatch's handler.
 *   - For each in-flight dispatch, deposits a synthetic "cancelled by
 *     shutdown" inbound envelope so the user sees a clear status when
 *     they reopen VS Code.
 *   - Moves the outbound envelope into sent/ so a fresh activation
 *     does NOT re-run an already-cancelled dispatch. The new-session
 *     sweep below also catches anything we missed.
 *
 * Stale sweep on activate:
 *   - sweepStale() runs once at the start of every session. Any
 *     outbound envelope older than STALE_OUTBOUND_MS that the
 *     dispatcher never claimed gets deposited as a synthetic
 *     "abandoned from previous session" inbound envelope and the
 *     outbound file is moved to sent/.
 */

const WATCH_DEBOUNCE_MS = 50;
const STALE_OUTBOUND_MS = 5 * 60_000;

interface InFlight {
  envelope: Envelope;
  controller: AbortController;
}

export class OutboundWatcher implements vscode.Disposable {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = new Map<string, InFlight>();
  private shuttingDown = false;
  private dispatchers = new Map<EnvelopeTarget, BackendDispatcher>();

  /** Register a per-target dispatcher. The engine routes outbound
   * envelopes matching the target to this implementation. Calling
   * twice for the same target replaces the previous registration. */
  register(dispatcher: BackendDispatcher): void {
    this.dispatchers.set(dispatcher.target, dispatcher);
  }

  /** Begin watching every registered target's outbound dir for the
   * active workspace. Re-watches when the workspace folder changes. */
  start(): void {
    this.ensureWatchers();
    void this.sweepStale();
    void this.pollOnce();
  }

  /** Re-evaluate watchers (called on workspace-folder changes or
   * after a target dispatcher registration). */
  refresh(): void {
    this.ensureWatchers();
    void this.pollOnce();
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Abort every in-flight dispatch and write a shutdown envelope so
    // the user sees a definitive outcome on next activation.
    const workspacePath = this.activeWorkspace();
    for (const { envelope, controller } of this.inFlight.values()) {
      try {
        controller.abort();
      } catch {
        // best-effort
      }
      this.writeShutdownEnvelope(envelope, workspacePath);
    }
    this.inFlight.clear();

    // Detach watchers.
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // best-effort
      }
    }
    this.watchers.clear();

    // Shutdown registered dispatchers in parallel; cap at a few
    // seconds so a hung backend can't block VS Code's exit.
    await Promise.race([
      Promise.all(
        Array.from(this.dispatchers.values()).map((d) =>
          d.shutdown().catch(() => undefined)
        )
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  private activeWorkspace(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private ensureWatchers(): void {
    const workspacePath = this.activeWorkspace();
    const targets =
      workspacePath !== null
        ? allOutboundDirs(workspacePath)
            .filter((d) => this.dispatchers.has(d.target))
            .map((d) => d.dir)
        : [];

    // Tear down watchers no longer in the set.
    for (const [dir, watcher] of this.watchers) {
      if (!targets.includes(dir)) {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        this.watchers.delete(dir);
      }
    }

    for (const dir of targets) {
      if (this.watchers.has(dir)) continue;
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
          continue;
        }
      }
      try {
        const w = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename && !filename.toString().endsWith(".md")) return;
          if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.pollOnce();
          }, WATCH_DEBOUNCE_MS);
        });
        w.on("error", () => {
          try {
            w.close();
          } catch {
            // best-effort
          }
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        // skip; retry next refresh
      }
    }
  }

  /** Scan every registered target's outbound dir for new envelopes
   * and dispatch them. Called by the watcher's debounce timer and on
   * startup; idempotent because in-flight envelope ids are tracked. */
  private async pollOnce(): Promise<void> {
    if (this.shuttingDown) return;
    const workspacePath = this.activeWorkspace();
    if (workspacePath === null) return;

    for (const { target, dir } of allOutboundDirs(workspacePath)) {
      const dispatcher = this.dispatchers.get(target);
      if (!dispatcher || !dispatcher.isAccepting()) continue;
      if (!existsSync(dir)) continue;

      let filenames: string[];
      try {
        filenames = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }

      for (const filename of filenames) {
        const fullPath = join(dir, filename);
        const id = filename.replace(/\.md$/, "");
        if (this.inFlight.has(id)) continue;

        const env = readEnvelope(fullPath);
        if (env === null) continue;
        // Sanity check: target should match the directory.
        if (env.target !== target) continue;

        void this.runOne(dispatcher, env, fullPath, workspacePath);
      }
    }
  }

  private async runOne(
    dispatcher: BackendDispatcher,
    envelope: Envelope,
    outboundPath: string,
    workspacePath: string
  ): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(envelope.id, { envelope, controller });

    let result: DispatchResult;
    try {
      result = await dispatcher.run({
        envelope,
        workspacePath,
        signal: controller.signal,
      });
    } catch (err) {
      result = {
        body: `[Dispatch handler threw: ${
          err instanceof Error ? err.message : String(err)
        }]`,
        error: true,
      };
    } finally {
      this.inFlight.delete(envelope.id);
    }

    // Write the inbound envelope and move the outbound to sent/.
    let inboundWritten = false;
    try {
      const inbound = buildInboundEnvelope({
        target: envelope.target,
        body: result.body,
        replyToId: envelope.id,
        workspacePath,
        alias: result.alias ?? envelope.alias,
        error: result.error,
      });
      writeInbound(inbound, workspacePath);
      inboundWritten = true;
    } catch {
      // best-effort: failure to write the inbound envelope leaves the
      // dispatch invisible to the user but won't crash the watcher
    }

    // Drop the per-workspace `returning.flag` to drive the shared
    // delivery animation (stage 4 -> left-arrow glyph) so non-Codex
    // success paths reach the same user-facing state as Codex's
    // turnRunner. Skip on error - failed calls shouldn't animate.
    if (inboundWritten && !result.error) {
      this.writeReturningFlag(workspacePath);
    }

    this.moveOutboundToSent(envelope.target, outboundPath, workspacePath);

  }

  /** Best-effort write of `~/.wat321/epic-handshake/returning.<wsHash>.flag`
   * with a self-clearing timer 3s later. Mirrors the Codex turnRunner's
   * `writeReturningFlag` from `WAT321_EPIC_HANDSHAKE/turnFlags.ts` so a
   * non-Codex dispatch's return ceremony has the same 3-second window
   * the rest of the bridge UI is built around (`STAGE_LATCH_MS["complete"]`
   * + `COMPLETE_WALK_HOLD_MS`). The unref'd timer lets the dispatcher
   * shut down without waiting on this flag's cleanup. */
  private writeReturningFlag(workspacePath: string): void {
    try {
      const wsHash = workspaceHash(workspacePath);
      const path = join(EH_ROOT_DIR, `returning.${wsHash}.flag`);
      if (!existsSync(EH_ROOT_DIR)) {
        mkdirSync(EH_ROOT_DIR, { recursive: true });
      }
      writeFileSync(path, new Date().toISOString());
      const t = setTimeout(() => {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          // best-effort
        }
      }, 3_000);
      t.unref?.();
    } catch {
      // best-effort - a missed flag write costs one animation frame
    }
  }

  /** Move (or as a last-resort, unlink) the outbound envelope after
   * dispatch so the watcher doesn't pick it up again on the next
   * poll tick. Best-effort: failure here leaves a stale file the
   * next activation's sweepStale will catch. */
  private moveOutboundToSent(
    target: EnvelopeTarget,
    outboundPath: string,
    workspacePath: string
  ): void {
    try {
      const sent = join(sentDir(target, workspacePath), `outbound.${dirname(outboundPath).split(/[/\\]/).pop()}.${Date.now()}.md`);
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

  private writeShutdownEnvelope(
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
   * previous session. Any file older than STALE_OUTBOUND_MS that no
   * in-flight tracker claims gets an "abandoned" reply envelope and
   * is moved to sent/ so the dispatcher doesn't pick it up. */
  private async sweepStale(): Promise<void> {
    const workspacePath = this.activeWorkspace();
    if (workspacePath === null) return;
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
          // Unparseable - just move out of the way.
          this.moveOutboundToSent(target, fullPath, workspacePath);
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
        this.moveOutboundToSent(target, fullPath, workspacePath);
      }
    }
  }
}
