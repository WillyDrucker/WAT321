import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  buildInboundEnvelope,
  readEnvelope,
  type Envelope,
  type EnvelopeTarget,
} from "../inbox/envelope";
import { allOutboundDirs } from "../inbox/inboxPaths";
import { writeInbound } from "../inbox/inboxWriter";
import type { BackendDispatcher, DispatchResult } from "./dispatcherTypes";
import {
  moveOutboundToSent,
  sweepStaleOutboundEnvelopes,
  writeReturningFlag,
  writeShutdownEnvelope,
} from "./outboundEnvelopeIO";

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
 *   - dispose() broadcasts an AbortSignal to every in-flight handler.
 *   - For each in-flight dispatch, deposits a synthetic "cancelled by
 *     shutdown" inbound envelope so the user sees a clear status when
 *     they reopen VS Code.
 *   - The next session's `sweepStaleOutboundEnvelopes` catches any
 *     outbound file that wasn't moved to sent/ in time.
 *
 * Envelope-side I/O (returning-flag write, outbound->sent move,
 * shutdown / abandoned synthetic envelopes) lives in
 * `outboundEnvelopeIO.ts` so this file stays focused on watcher
 * lifecycle + dispatch flow.
 */

const WATCH_DEBOUNCE_MS = 50;

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
    const workspacePath = this.activeWorkspace();
    if (workspacePath !== null) sweepStaleOutboundEnvelopes(workspacePath);
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

    const workspacePath = this.activeWorkspace();
    for (const { envelope, controller } of this.inFlight.values()) {
      try {
        controller.abort();
      } catch {
        // best-effort
      }
      writeShutdownEnvelope(envelope, workspacePath);
    }
    this.inFlight.clear();

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
      // failed inbound leaves dispatch invisible but won't crash watcher
    }

    // returning.<wsHash>.flag drives the shared delivery animation
    // (stage 4 -> left-arrow glyph) so non-Codex success paths reach
    // the same user-facing state as Codex's turnRunner. Skip on error -
    // failed calls shouldn't animate.
    if (inboundWritten && !result.error) {
      writeReturningFlag(workspacePath);
    }

    moveOutboundToSent(envelope.target, outboundPath, workspacePath);
  }
}
