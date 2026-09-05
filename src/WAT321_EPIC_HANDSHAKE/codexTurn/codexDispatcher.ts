import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceHash } from "../../engine/workspaceHash";
import { releaseClaim, tryAcquireClaim } from "../../shared/claimFile";
import { PathWatcher } from "../../shared/polling/pathWatcher";
import { AppServerLifecycle } from "../appServer/appServerLifecycle";
import { hydrateCodexCatalog } from "../codexSettings/codexCatalogRefresh";
import { dispatchTurn } from "./codexTurnDispatch";
import {
  inboxClaudeDir,
  inboxCodexDir,
  sentClaudeDir,
  sentCodexDir,
} from "../epicHandshakePaths";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import {
  newEnvelopeId,
  readEnvelope,
  writeEnvelopeAtomic,
  type Envelope,
} from "./envelope";
import { moveToSent, purgeSent } from "./mailbox";
import { writeSuppressCodexToast } from "./turnFlags";

/**
 * Watches `inbox/codex/<wshash>/` for envelopes from Claude, dispatches
 * each to `codex app-server` on the shared per-workspace thread, and
 * writes the reply back to `inbox/claude/<wshash>/` so the channel MCP
 * server can push it into the originating Claude session.
 *
 * This file owns the orchestration shell: inbox watching, per-envelope
 * claim arbitration, and reply envelope writing. The app-server child
 * and its idle shutdown live in `appServerLifecycle.ts`, the per-turn
 * thread / dispatch / recover flow in `codexTurnDispatch.ts`, and the
 * turn run loop in `turnRunner.ts`.
 */

/** Sent-folder purge cadence. Delivered envelopes older than 5 minutes
 * go, since no downstream consumer reads them (the conversation lives
 * in Claude's transcript). Keeps disk footprint bounded. */
const PURGE_INTERVAL_MS = 5 * 60 * 1000;
/** Per-envelope claim TTL. Two VS Code windows on the same workspace
 * each watch the same `inbox/codex/<wsHash>/` directory - without a
 * claim, both would dispatch the same envelope and write duplicate
 * replies. TTL exceeds the monitor's hard cap so a healthy long-
 * running turn never reclaims - a crashed dispatcher's claim ages out
 * and the surviving window picks up the orphan on its next scan. */
const ENVELOPE_CLAIM_TTL_MS = 30 * 60 * 1000;

export class CodexDispatcher {
  private watcher: PathWatcher | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private processing = false;
  private readonly appServer: AppServerLifecycle;
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
    this.appServer = new AppServerLifecycle(logger, () => this.processing);
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
    this.runPurge();
    this.purgeTimer = setInterval(() => this.runPurge(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
    // Load the model catalog this binary wrote on a previous run. Reads
    // one small file and spawns nothing, so it does not violate the
    // tier's no-activate-time-daemon rule. Without it the model picker
    // in a fresh window falls back to the shared, frequently clobbered
    // ~/.codex/models_cache.json until the first dispatch lands.
    void hydrateCodexCatalog(this.logger);
    this.logger.info("codex dispatcher started");
  }

  /** Spawn the app-server ahead of the first dispatch. Only bridge
   * restart calls this, see `AppServerLifecycle.prewarm`. */
  prewarm(): Promise<void> {
    return this.appServer.prewarm();
  }

  /** Kill the app-server now so the next dispatch spawns fresh. */
  forceRestart(): void {
    this.appServer.forceRestart();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    await this.appServer.stop();
  }

  private runPurge(): void {
    purgeSent({
      sentCodex: this.sentCodex,
      inboxClaude: this.inboxClaude,
      sentClaude: this.sentClaude,
      logger: this.logger,
    });
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
      this.logger.warn(`failed to parse envelope ${path}, moving to sent`);
      moveToSent(path, this.sentCodex);
      return;
    }
    if (env.target !== "codex") {
      this.logger.warn(`envelope ${env.id} target=${env.target}, quarantining`);
      moveToSent(path, this.sentCodex);
      return;
    }

    // Start the idle window at turn start so a turn arriving 14:59 into
    // the previous window is not cut off by the idle shutdown
    // SIGKILL'ing the child mid-stream (#81).
    this.appServer.resetIdleTimer();

    try {
      const reply = await dispatchTurn(
        {
          workspacePath: this.workspacePath,
          wsHash: this.wsHash,
          logger: this.logger,
          ensureClient: () => this.appServer.ensureClient(),
          forceRestart: () => this.appServer.forceRestart(),
        },
        env
      );
      this.writeReply(env, { body: reply, intent: "assessment" });
      // Belt-and-suspenders sentinel write. dispatchTurn also writes
      // this on its success and recovery paths - the read side is
      // consume-on-read so a double-write is harmless.
      writeSuppressCodexToast(this.workspacePath);
      moveToSent(path, this.sentCodex);
      this.appServer.resetIdleTimer();
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
}
