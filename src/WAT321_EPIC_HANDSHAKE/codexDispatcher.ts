import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { releaseClaim, tryAcquireClaim } from "../shared/claimFile";
import { resolveCodexCli } from "../shared/providers/codex/cliResolver";
import { clearCodexCatalog } from "../shared/providers/codex/modelCatalog";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { workspaceHash } from "../shared/workspaceHash";
import { AppServerClient } from "./appServerClient";
import { syncCodexCatalog } from "./codexCatalogSync";
import { dispatchTurn } from "./codexTurnDispatch";
import {
  inboxClaudeDir,
  inboxCodexDir,
  sentClaudeDir,
  sentCodexDir,
} from "./constants";
import {
  newEnvelopeId,
  readEnvelope,
  writeEnvelopeAtomic,
  type Envelope,
} from "./envelope";
import { moveToSent, purgeSent } from "./mailbox";
import { writeSuppressCodexToast } from "./turnFlags";
import type { EpicHandshakeLogger } from "./types";

/**
 * Watches `inbox/codex/<wshash>/` for envelopes from Claude, dispatches
 * each to `codex app-server` on the shared per-workspace thread, and
 * writes the reply back to `inbox/claude/<wshash>/` so the channel MCP
 * server can push it into the originating Claude session.
 *
 * This file owns the orchestration shell: inbox watching, per-envelope
 * claim arbitration, app-server lifecycle (spawn / initialize / idle
 * shutdown / force-restart), and reply envelope writing. The per-turn
 * thread / dispatch / recover flow lives in `codexTurnDispatch.ts` -
 * the actual turn run loop lives in `turnRunner.ts`.
 */

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Per-envelope claim TTL. Two VS Code windows on the same workspace
 * each watch the same `inbox/codex/<wsHash>/` directory - without a
 * claim, both would dispatch the same envelope and write duplicate
 * replies. TTL exceeds the monitor's hard cap so a healthy long-
 * running turn never reclaims - a crashed dispatcher's claim ages out
 * and the surviving window picks up the orphan on its next scan. */
const ENVELOPE_CLAIM_TTL_MS = 30 * 60 * 1000;

export class CodexDispatcher {
  private watcher: PathWatcher | null = null;
  private client: AppServerClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private processing = false;
  /** Workspace identity for inbox/sent partitioning. Multiple
   * dispatchers across separate VS Code instances each watch their
   * own `<wshash>` subfolder, so envelopes meant for one workspace
   * can never be picked up by another's dispatcher. */
  private readonly wsHash: string;
  private readonly inboxCodex: string;
  private readonly inboxClaude: string;
  private readonly sentCodex: string;
  private readonly sentClaude: string;

  constructor(
    private readonly workspacePath: string,
    private readonly logger: EpicHandshakeLogger
  ) {
    this.wsHash = workspaceHash(workspacePath);
    this.inboxCodex = inboxCodexDir(this.wsHash);
    this.inboxClaude = inboxClaudeDir(this.wsHash);
    this.sentCodex = sentCodexDir(this.wsHash);
    this.sentClaude = sentClaudeDir(this.wsHash);
  }

  start(): void {
    for (const dir of [
      this.inboxCodex,
      this.inboxClaude,
      this.sentCodex,
      this.sentClaude,
    ]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.logger.info(
      `codex dispatcher binding to workspace ${this.wsHash} path=${this.workspacePath}`
    );
    this.watcher = new PathWatcher(
      () => {
        void this.drainInbox();
      },
      { debounceMs: 250 }
    );
    this.watcher.sync(this.inboxCodex);
    void this.drainInbox();
    // Sent-folder purge: delivered envelopes older than 5 minutes.
    // No downstream consumer (conversation lives in Claude's
    // transcript). Keeps disk footprint bounded.
    this.runPurge();
    this.purgeTimer = setInterval(() => this.runPurge(), 5 * 60 * 1000);
    this.purgeTimer.unref?.();
    this.logger.info("codex dispatcher started");
  }

  private runPurge(): void {
    purgeSent({
      sentCodex: this.sentCodex,
      inboxClaude: this.inboxClaude,
      sentClaude: this.sentClaude,
      logger: this.logger,
    });
  }

  /** Eagerly spawn the codex app-server child process and complete
   * `initialize` without dispatching any turn. Idempotent. Called at
   * tier activate (deferred 2s) and after `forceRestart()` so the
   * first user-visible dispatch pays only `thread/start` + `turn/
   * start` latency (~1-3s) instead of the full ~20s cold-start
   * chain. Failures are logged and swallowed - the first real
   * dispatch surfaces the problem the normal way. */
  async prewarm(): Promise<void> {
    if (this.client !== null) return;
    try {
      await this.ensureClient();
      this.logger.info("codex app-server prewarmed and ready");
      this.resetIdleTimer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`prewarm skipped: ${msg}`);
    }
  }

  /** Force-kill the current app-server child and drop the cached
   * client. Next dispatch spawns fresh. Used by "Restart Codex
   * Bridge" when the user needs the Codex process gone now (stale
   * cached config, stuck state). Idempotent. */
  forceRestart(): void {
    // Cleared before the early return, not after. A restart requested
    // once the idle timer already closed the child still has to drop the
    // catalog: the user reaches for this action precisely when Codex
    // changed underneath us (upgraded binary, stale cached config), and
    // a catalog outliving its process would describe a binary we no
    // longer talk to. Next ensureClient refills it.
    clearCodexCatalog();
    if (this.client === null) return;
    this.client.forceKill();
    this.client = null;
    this.logger.info("codex app-server force-killed (bridge restart)");
  }

  async stop(): Promise<void> {
    this.disposed = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    if (this.client) {
      try {
        await this.client.shutdown();
      } catch {
        // best-effort
      }
      this.client = null;
    }
    // The tier is going away. Leaving module state behind would let a
    // re-activated dispatcher serve the previous process's answer.
    clearCodexCatalog();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdleTimerFire(), IDLE_TIMEOUT_MS);
  }

  /** Idle-timer callback. The app-server child must never be idle-
   * killed during an active turn (#81). Reset is called at turn
   * start and on every successful turn end - this guard handles the
   * regression case where the timer arms during a turn. When the
   * timer fires with `this.processing` still true, re-schedule THIS
   * check (not a full new idle window) for 60s so the next firing
   * re-evaluates against fresh state. */
  private onIdleTimerFire(): void {
    if (this.processing) {
      this.logger.warn(
        "codex dispatcher idle timeout fired while processing; deferring shutdown"
      );
      this.idleTimer = setTimeout(() => this.onIdleTimerFire(), 60_000);
      return;
    }
    this.logger.info("codex dispatcher idle timeout - closing app-server");
    if (this.client) {
      void this.client.shutdown();
      this.client = null;
    }
    // Catalog deliberately survives an idle shutdown. The same binary
    // respawns, so its answer is still true, and keeping it means a
    // picker opened after 15 idle minutes renders from the app-server's
    // list instead of dropping back to the shared cache file. Only
    // `forceRestart` clears it, where the binary itself may have moved.
  }

  private async drainInbox(): Promise<void> {
    if (this.disposed || this.processing) return;
    this.processing = true;
    try {
      let files: string[];
      try {
        files = readdirSync(this.inboxCodex).filter((f) => f.endsWith(".md"));
      } catch {
        return;
      }
      files.sort();
      for (const f of files) {
        if (this.disposed) return;
        const envelopePath = join(this.inboxCodex, f);
        const claimPath = `${envelopePath}.claim`;
        // Cross-window arbitration: same-workspace siblings race on
        // the same inbox dir. Claim before reading - loser skips. TTL
        // reclaims stale claims so a crashed dispatcher cannot
        // deadlock the envelope forever.
        if (!tryAcquireClaim(claimPath, ENVELOPE_CLAIM_TTL_MS)) continue;
        try {
          await this.processEnvelope(envelopePath);
        } finally {
          releaseClaim(claimPath);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async processEnvelope(path: string): Promise<void> {
    const env = readEnvelope(path);
    if (!env) {
      this.logger.warn(`failed to parse envelope ${path}; moving to sent`);
      moveToSent(path, this.sentCodex);
      return;
    }
    if (env.target !== "codex") {
      this.logger.warn(`envelope ${env.id} target=${env.target}; quarantining`);
      moveToSent(path, this.sentCodex);
      return;
    }

    // Reset the idle timer at turn start so the 15-min window starts
    // now, not from whenever the LAST turn ended. Without this, a
    // turn arriving 14:59 into the window can be cut off by the idle
    // shutdown SIGKILL'ing the child mid-stream (#81).
    this.resetIdleTimer();

    try {
      const reply = await dispatchTurn(
        {
          workspacePath: this.workspacePath,
          wsHash: this.wsHash,
          logger: this.logger,
          ensureClient: () => this.ensureClient(),
          forceRestart: () => this.forceRestart(),
        },
        env
      );
      this.writeReply(env, { body: reply, intent: "assessment" });
      // Belt-and-suspenders sentinel write. dispatchTurn also writes
      // this on its success and recovery paths - the read side is
      // consume-on-read so a double-write is harmless.
      writeSuppressCodexToast(this.workspacePath);
      moveToSent(path, this.sentCodex);
      this.resetIdleTimer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`dispatch failed for ${env.id}: ${msg}`);
      // Body wording invites the caller to investigate before
      // declaring failure (#73 / #75 / #69). Many "couldn't complete"
      // verdicts arrive AFTER Codex's underlying work has landed on
      // disk (the failure is in the reply-marshal step, not the work
      // itself). Tersely refusing here strands Claude with no path
      // forward - we surface the on-disk + inbox check hints and gate
      // re-issue on "nothing landed".
      this.writeReply(env, {
        body:
          `Codex bridge turn ended without a reply payload (chain ${env.chainId}). ` +
          "Codex's underlying work may still have landed on disk - check the workspace for new files / commits / artifacts, and check `wat321_bridge()` for a late reply, before treating this as a failure. " +
          "Re-issue only if nothing landed, since re-issuing while the turn may still be running starts a parallel turn. To recover bridge state, pick Restart Epic Handshake Bridge from the status bar. " +
          "Open the WAT321: Epic Handshake output channel for the lower-layer error detail.",
        intent: "blocker",
      });
      moveToSent(path, this.sentCodex);
    }
  }

  private writeReply(
    original: Envelope,
    opts: { body: string; intent: string }
  ): void {
    const reply: Envelope = {
      id: newEnvelopeId(),
      chainId: original.chainId,
      iteration: original.iteration + 1,
      source: "codex",
      target: "claude",
      sourceSessionFp: original.sourceSessionFp,
      priority: original.priority,
      intent: opts.intent,
      workspacePath: original.workspacePath,
      createdAt: new Date().toISOString(),
      replyTo: original.id,
      body: opts.body,
    };
    const out = join(this.inboxClaude, `${reply.id}.md`);
    writeEnvelopeAtomic(out, reply);
    this.logger.info(
      `reply written ${reply.id} chain=${reply.chainId} iter=${reply.iteration}`
    );
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const spawnStart = Date.now();
    // Resolve the codex binary with extension-bundled-then-PATH
    // fallback. Lets users who only installed the OpenAI Codex VS
    // Code extension (no global codex CLI) still drive the bridge.
    // Cached after first probe.
    const resolved = await resolveCodexCli();
    const client = new AppServerClient({
      logger: this.logger,
      instanceId: "codexDispatcher",
      executable: resolved?.command,
    });
    if (resolved !== null) {
      this.logger.info(
        `[client] codex binary resolved via ${resolved.source}: ${resolved.command}`
      );
    }
    client.spawn();
    const initStart = Date.now();
    await client.sendRequest("initialize", {
      clientInfo: {
        name: "wat321_bridge",
        title: "WAT321 Epic Handshake",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
    });
    const initEnd = Date.now();
    // `initialized` is a notification, no id
    client.sendNotification("initialized", {});
    this.client = client;
    this.logger.info(
      `[timing] app-server cold-start spawn_to_init=${initStart - spawnStart}ms initialize=${initEnd - initStart}ms total=${Date.now() - spawnStart}ms`
    );
    // Not awaited: the catalog is a display / validation convenience and
    // must not sit in front of the first turn. Readers fall back to the
    // cache file until it lands. Never touches the idle timer.
    void syncCodexCatalog(client, resolved?.command ?? "codex", this.logger);
    return client;
  }
}
