import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { AppServerClient } from "./appServerClient";
import {
  inboxClaudeDir,
  inboxCodexDir,
  sentClaudeDir,
  sentCodexDir,
} from "./constants";
import { newEnvelopeId, readEnvelope, writeEnvelopeAtomic, type Envelope } from "./envelope";
import { classifyFailure } from "./failureClassifier";
import { moveToSent, purgeSent } from "./mailbox";
import { loadBridgeThreadRecord } from "./threadPersistence";
import {
  noteFailure,
  noteSuccess,
  rotateThreadRecord,
  spawnFreshThread,
} from "./threadLifecycle";
import {
  clearInFlightFlag,
  clearProcessingFlag,
  writeInFlightFlag,
  writeReturningFlag,
  writeSuppressCodexToast,
} from "./turnFlags";
import { runTurnOnce } from "./turnRunner";
import type { EpicHandshakeLogger } from "./types";
import { workspaceHash } from "./workspaceHash";

/**
 * Watches `inbox/codex/<wshash>/` for envelopes from Claude, dispatches
 * each to `codex app-server` on the shared per-workspace thread, and
 * writes the reply back to `inbox/claude/<wshash>/` so the channel MCP
 * server can push it into the originating Claude session.
 *
 * Lifecycle:
 *   - On first envelope: spawn AppServerClient, initialize, create or
 *     resume the workspace's bridge thread, dispatch turn, aggregate
 *     reply, write reply envelope.
 *   - Thread id persists in bridge-thread.<wshash>.json across
 *     subprocess restarts. Non-ephemeral threads survive the subprocess
 *     idle-kill, so we can drop the client after N minutes idle and
 *     resume cleanly on the next envelope.
 *
 * This file is the orchestration shell. The heavy lifting lives in:
 *   - `mailbox.ts`         - sent/inbox file housekeeping
 *   - `threadLifecycle.ts` - spawn/rotate/note success/failure
 *   - `turnRunner.ts`      - the runTurnOnce subscription + monitor loop
 */

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Consecutive recoverable-shape failures before we give up on the
 * thread and rotate to a fresh one. Keeps a user's S1 alive through
 * transient network blips but bails out of genuinely stuck threads. */
const MAX_CONSECUTIVE_FAILURES = 3;

export class CodexDispatcher {
  private watcher: PathWatcher | null = null;
  private client: AppServerClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private processing = false;
  /** Workspace identity for inbox/sent partitioning. Computed once
   * so both the watcher and the per-envelope reply writer point at
   * the same `<wshash>` subfolder. Multiple dispatchers across
   * separate VS Code instances each watch their own subfolder, so
   * envelopes meant for one workspace can never be picked up by
   * another's dispatcher. */
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
    for (const dir of [this.inboxCodex, this.inboxClaude, this.sentCodex, this.sentClaude]) {
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
    // No downstream consumer - conversation lives in Claude's own
    // transcript, not here. Keeps disk footprint bounded.
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
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.info("codex dispatcher idle timeout - closing app-server");
      if (this.client) {
        void this.client.shutdown();
        this.client = null;
      }
    }, IDLE_TIMEOUT_MS);
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
        await this.processEnvelope(join(this.inboxCodex, f));
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
      this.logger.warn(`envelope ${env.id} target=${env.target}; skipping`);
      return;
    }

    try {
      const reply = await this.dispatchToCodex(env);
      this.writeReply(env, { body: reply, intent: "assessment" });
      // Belt-and-suspenders sentinel write. The runTurnOnce path also
      // writes this on `turn/completed` and rollout-recovery success;
      // the read side is consume-on-read so a double-write is harmless.
      writeSuppressCodexToast(this.workspacePath);
      moveToSent(path, this.sentCodex);
      this.resetIdleTimer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`dispatch failed for ${env.id}: ${msg}`);
      this.writeReply(env, {
        body: `Codex bridge error: ${msg}`,
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
    this.logger.info(`reply written ${reply.id} chain=${reply.chainId} iter=${reply.iteration}`);
  }

  private async dispatchToCodex(env: Envelope): Promise<string> {
    const dispatchStart = Date.now();
    const client = await this.ensureClient();
    const clientReady = Date.now();
    let record = loadBridgeThreadRecord(this.workspacePath);

    // Threshold-based rotation: if we've seen N consecutive recoverable
    // failures on the same thread, rotate. Protects against a thread
    // stuck in a bad state we can't detect cleanly.
    if (
      record.threadId !== null &&
      (record.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES
    ) {
      this.logger.warn(
        `thread ${record.threadId} hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures; rotating`
      );
      record = rotateThreadRecord(record);
    }

    let threadId = record.threadId;
    if (threadId === null) {
      const spawned = await spawnFreshThread({
        client,
        record,
        workspacePath: this.workspacePath,
        logger: this.logger,
      });
      threadId = spawned.threadId;
      record = spawned.record;
    } else {
      try {
        await client.sendRequest("thread/resume", { threadId });
      } catch (err) {
        const cls = classifyFailure(err);
        const msg = err instanceof Error ? err.message : String(err);
        if (cls === "rotate") {
          this.logger.warn(`resume failed (${msg}); thread unrecoverable, rotating`);
          record = rotateThreadRecord(record);
          const spawned = await spawnFreshThread({
            client,
            record,
            workspacePath: this.workspacePath,
            logger: this.logger,
          });
          threadId = spawned.threadId;
          record = spawned.record;
        } else {
          noteFailure(record, msg);
          throw err;
        }
      }
    }

    const threadReady = Date.now();
    try {
      writeInFlightFlag(this.workspacePath);
      let result: string;
      try {
        result = await this.runTurn(client, threadId, env);
      } catch (err) {
        // Late rotation: thread/resume can succeed (Codex's app-server
        // has the thread cached in memory), but turn/start then fails
        // with "no rollout found for thread id ..." when the rollout
        // file on disk is gone - typically because the user deleted
        // sessions manually or from a sibling Codex VS Code instance.
        // Treat this exactly like a resume-time rotate: rotate, spawn
        // fresh, retry runTurn ONCE. Without this the user sees a raw
        // "Codex bridge error" reply for every prompt until they
        // manually pick Reset from the menu.
        const cls = classifyFailure(err);
        if (cls !== "rotate") throw err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `runTurn rotate (${msg}); rotating + spawning fresh thread for retry`
        );
        record = rotateThreadRecord(record);
        const spawned = await spawnFreshThread({
          client,
          record,
          workspacePath: this.workspacePath,
          logger: this.logger,
        });
        threadId = spawned.threadId;
        record = spawned.record;
        result = await this.runTurn(client, threadId, env);
      }
      const turnEnd = Date.now();
      noteSuccess(record);
      // Breakdown: client_setup is spawn + initialize (warm = ~0ms);
      // thread_setup is thread/start or thread/resume; turn is the
      // actual Codex work from turn/start to turn/completed. Helps
      // tell "Codex is slow" from "we are slow" in post-mortems.
      this.logger.info(
        `[timing] turn ok client_setup=${clientReady - dispatchStart}ms thread_setup=${threadReady - clientReady}ms turn=${turnEnd - threadReady}ms total=${turnEnd - dispatchStart}ms`
      );
      // Transition: in-flight -> returning. The reply starts flowing
      // back to Claude via the MCP tool result. Hold the returning
      // flag 5000ms so the status bar renders a clear minimum of the
      // arrow-circle-left animation before the delivered flash kicks in.
      clearProcessingFlag(this.workspacePath);
      clearInFlightFlag(this.workspacePath);
      writeReturningFlag(this.workspacePath);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // User cancellations are intentional stops, not failures. Don't
      // bump the consecutive-failure counter (which would eventually
      // trigger thread rotation on repeated cancels) and don't stash
      // lastError (which would light up the error icon). Still clear
      // the flags and propagate so the reply path writes "cancelled
      // by user" back to Claude cleanly.
      if (msg !== "cancelled by user") {
        noteFailure(record, msg);
      }
      clearProcessingFlag(this.workspacePath);
      clearInFlightFlag(this.workspacePath);
      throw err;
    }
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const spawnStart = Date.now();
    const client = new AppServerClient({ logger: this.logger, instanceId: "codexDispatcher" });
    client.spawn();
    // Bracket each stage so cold-start latency breaks down into spawn
    // time, initialize handshake time, and post-initialize ack time.
    // Warm starts skip this function entirely; only the first turn
    // after a ~15 min idle pays these costs.
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
    return client;
  }

  /** Dispatch a turn. If it fails with a compactable error (context
   * window exceeded), run `thread/compact/start` to summarize the
   * thread in place and retry the same turn once. Same threadId,
   * same S<N> name, same user-visible session - compaction is a
   * repair, not a reset. */
  private async runTurn(
    client: AppServerClient,
    threadId: string,
    env: Envelope
  ): Promise<string> {
    const opts = {
      client,
      threadId,
      env,
      workspacePath: this.workspacePath,
      wsHash: this.wsHash,
      logger: this.logger,
    };
    try {
      return await runTurnOnce(opts);
    } catch (err) {
      if (classifyFailure(err) !== "compact") throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`turn hit context limit (${msg}); running thread/compact/start`);
      try {
        await client.sendRequest("thread/compact/start", { threadId });
      } catch (cerr) {
        const cmsg = cerr instanceof Error ? cerr.message : String(cerr);
        this.logger.error(`compact failed: ${cmsg}`);
        throw err;  // original error is more informative
      }
      this.logger.info(`compact complete; retrying turn on same thread`);
      return await runTurnOnce(opts);
    }
  }
}
