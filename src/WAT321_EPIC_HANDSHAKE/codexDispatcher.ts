import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { AppServerClient } from "./appServerClient";
import { CANCEL_FLAG_PATH, INBOX_CLAUDE_DIR, INBOX_CODEX_DIR, SENT_CODEX_DIR } from "./constants";
import { classifyFailure } from "./failureClassifier";
import {
  clearInFlightFlag,
  clearProcessingFlag,
  writeInFlightFlag,
  writeProcessingFlag,
  writeReturningFlag,
} from "./turnFlags";
import { newEnvelopeId, readEnvelope, writeEnvelopeAtomic, type Envelope } from "./envelope";
import type {
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
} from "./protocol";
import {
  bridgeThreadDisplayName,
  loadBridgeThreadRecord,
  nextCollisionFreeCounter,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadPersistence";
import type { EpicHandshakeLogger } from "./types";

/**
 * Watches `inbox/codex/` for envelopes from Claude, dispatches each
 * to `codex app-server` on the shared per-workspace thread, and
 * writes the reply back to `inbox/claude/` so the channel MCP server
 * can push it into the originating Claude session.
 *
 * Lifecycle:
 *   - On first envelope: spawn AppServerClient, initialize, create or
 *     resume the workspace's bridge thread, dispatch turn, aggregate
 *     reply, write reply envelope.
 *   - Thread id persists in bridge-thread.<wshash>.json across
 *     subprocess restarts. Non-ephemeral threads survive the subprocess
 *     idle-kill, so we can drop the client after N minutes idle and
 *     resume cleanly on the next envelope.
 */

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** Consecutive recoverable-shape failures before we give up on the
 * thread and rotate to a fresh one. Keeps a user's S1 alive through
 * transient network blips but bails out of genuinely stuck threads. */
const MAX_CONSECUTIVE_FAILURES = 3;

interface ThreadStartResult {
  thread: { id: string; path: string | null; ephemeral: boolean };
}

interface AgentMessageDelta {
  itemId: string;
  delta: string;
}

interface TurnCompleted {
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed";
    items: Array<{ type: string; id: string; text?: string; status: string }>;
    error?: {
      message: string;
      codexErrorInfo?: string;
      additionalDetails?: string;
    } | null;
  };
}

export class CodexDispatcher {
  private watcher: PathWatcher | null = null;
  private client: AppServerClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private processing = false;

  constructor(
    private readonly workspacePath: string,
    private readonly logger: EpicHandshakeLogger
  ) {}

  start(): void {
    for (const dir of [INBOX_CODEX_DIR, INBOX_CLAUDE_DIR, SENT_CODEX_DIR]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.watcher = new PathWatcher(() => {
      void this.drainInbox();
    }, 250, false);
    this.watcher.sync(INBOX_CODEX_DIR);
    void this.drainInbox();
    // Sent-folder purge: delivered envelopes older than 5 minutes.
    // No downstream consumer - conversation lives in Claude's own
    // transcript, not here. Keeps disk footprint bounded.
    this.purgeSent();
    this.purgeTimer = setInterval(() => this.purgeSent(), 5 * 60 * 1000);
    this.purgeTimer.unref?.();
    this.logger.info("codex dispatcher started");
  }

  private purgeSent(): void {
    try {
      const cutoff = Date.now() - 5 * 60 * 1000;
      if (existsSync(SENT_CODEX_DIR)) {
        for (const f of readdirSync(SENT_CODEX_DIR)) {
          const p = join(SENT_CODEX_DIR, f);
          try {
            const st = statSync(p);
            if (st.mtimeMs < cutoff) unlinkSync(p);
          } catch {
            // best-effort
          }
        }
      }
    } catch {
      // never throw from housekeeping
    }
    this.sweepStaleInboxMail();
  }

  /** Move any envelope in inbox/claude/ older than 1 hour to the
   * sent/claude/ archive. Safety floor for the late-reply flow:
   * normally a prompt via collectLateReplies consumes pending mail
   * on the user's next bridge invocation, or the status-bar menu
   * retrieves it. A user who walks away entirely should not find
   * unbounded accumulation on return. 1 hour is long enough that a
   * useful reply had real chances to be seen. */
  private sweepStaleInboxMail(): void {
    try {
      if (!existsSync(INBOX_CLAUDE_DIR)) return;
      const sentDir = join(SENT_CODEX_DIR, "..", "claude");
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const f of readdirSync(INBOX_CLAUDE_DIR)) {
        if (!f.endsWith(".md")) continue;
        const src = join(INBOX_CLAUDE_DIR, f);
        try {
          const st = statSync(src);
          if (st.mtimeMs >= cutoff) continue;
          if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });
          renameSync(src, join(sentDir, f));
          this.logger.info(`swept stale late reply ${f} (1h TTL)`);
        } catch {
          // best-effort per file
        }
      }
    } catch {
      // never throw from housekeeping
    }
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
        files = readdirSync(INBOX_CODEX_DIR).filter((f) => f.endsWith(".md"));
      } catch {
        return;
      }
      files.sort();
      for (const f of files) {
        if (this.disposed) return;
        await this.processEnvelope(join(INBOX_CODEX_DIR, f));
      }
    } finally {
      this.processing = false;
    }
  }

  private async processEnvelope(path: string): Promise<void> {
    const env = readEnvelope(path);
    if (!env) {
      this.logger.warn(`failed to parse envelope ${path}; moving to sent`);
      this.moveToSent(path);
      return;
    }
    if (env.target !== "codex") {
      this.logger.warn(`envelope ${env.id} target=${env.target}; skipping`);
      return;
    }

    try {
      const reply = await this.dispatchToCodex(env);
      this.writeReply(env, { body: reply, intent: "assessment" });
      this.moveToSent(path);
      this.resetIdleTimer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`dispatch failed for ${env.id}: ${msg}`);
      this.writeReply(env, {
        body: `Codex bridge error: ${msg}`,
        intent: "blocker",
      });
      this.moveToSent(path);
    }
  }

  private moveToSent(path: string): void {
    const filename = path.split(/[\\/]/).pop() || "";
    const dest = join(SENT_CODEX_DIR, filename);
    try {
      renameSync(path, dest);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
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
    const out = join(INBOX_CLAUDE_DIR, `${reply.id}.md`);
    writeEnvelopeAtomic(out, reply);
    this.logger.info(`reply written ${reply.id} chain=${reply.chainId} iter=${reply.iteration}`);
  }

  private async dispatchToCodex(env: Envelope): Promise<string> {
    const client = await this.ensureClient();
    let record = loadBridgeThreadRecord(this.workspacePath);

    // Threshold-based rotation: if we've seen N consecutive
    // recoverable failures on the same thread, rotate. Protects
    // against a thread stuck in a bad state we can't detect cleanly.
    if (
      record.threadId !== null &&
      (record.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES
    ) {
      this.logger.warn(
        `thread ${record.threadId} hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures; rotating`
      );
      record = this.rotateThreadRecord(record);
    }

    let threadId = record.threadId;
    if (threadId === null) {
      const spawned = await this.spawnFreshThread(client, record);
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
          record = this.rotateThreadRecord(record);
          const spawned = await this.spawnFreshThread(client, record);
          threadId = spawned.threadId;
          record = spawned.record;
        } else {
          this.noteFailure(record, msg);
          throw err;
        }
      }
    }

    try {
      writeInFlightFlag();
      const result = await this.runTurn(client, threadId, env);
      this.noteSuccess(record);
      // Transition: in-flight -> returning. The reply starts flowing
      // back to Claude via the MCP tool result. Hold the returning
      // flag 5000ms so the status bar renders a clear minimum of the
      // arrow-circle-left animation before the delivered flash kicks in.
      clearProcessingFlag();
      clearInFlightFlag();
      writeReturningFlag();
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
        this.noteFailure(record, msg);
      }
      clearProcessingFlag();
      clearInFlightFlag();
      throw err;
    }
  }

  /** Create a fresh Codex thread with collision-free S<N> name and
   * persist its id. Returns both the new threadId and the updated
   * record so the caller's local view stays consistent. */
  private async spawnFreshThread(
    client: AppServerClient,
    record: BridgeThreadRecord
  ): Promise<{ threadId: string; record: BridgeThreadRecord }> {
    const counter = nextCollisionFreeCounter(
      this.workspacePath,
      record.sessionCounter
    );
    const threadStartParams: ThreadStartParams = {
      cwd: this.workspacePath,
      approvalPolicy: "never",
      sandbox: "read-only",
      sessionStartSource: "startup",
    };
    const started = (await client.sendRequest(
      "thread/start",
      threadStartParams
    )) as ThreadStartResult;
    const threadId = started.thread.id;
    const updated: BridgeThreadRecord = {
      ...record,
      threadId,
      sessionCounter: counter,
      consecutiveFailures: 0,
      lastError: null,
    };
    saveBridgeThreadRecord(updated);
    try {
      await client.sendRequest("thread/name/set", {
        threadId,
        name: bridgeThreadDisplayName(this.workspacePath, counter),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`thread/name/set failed: ${msg}`);
    }
    return { threadId, record: updated };
  }

  /** Null out threadId and bump counter so the next call creates a
   * fresh S<N+1>. Called on definitive "thread not found" or
   * threshold-exceeded failures. */
  private rotateThreadRecord(record: BridgeThreadRecord): BridgeThreadRecord {
    const next: BridgeThreadRecord = {
      ...record,
      threadId: null,
      sessionCounter: record.sessionCounter + 1,
      lastResetAt: new Date().toISOString(),
      consecutiveFailures: 0,
      lastError: null,
    };
    saveBridgeThreadRecord(next);
    return next;
  }

  /** Mark success: clear failure counter, stamp lastSuccessAt. */
  private noteSuccess(record: BridgeThreadRecord): void {
    saveBridgeThreadRecord({
      ...record,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    });
  }

  /** Mark failure: bump consecutive counter, stash lastError. The
   * threshold check at the top of dispatchToCodex uses this. */
  private noteFailure(record: BridgeThreadRecord, message: string): void {
    saveBridgeThreadRecord({
      ...record,
      consecutiveFailures: (record.consecutiveFailures ?? 0) + 1,
      lastError: message.slice(0, 500),
    });
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const client = new AppServerClient({ logger: this.logger, instanceId: "codexDispatcher" });
    client.spawn();
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
    // `initialized` is a notification, no id
    client.sendNotification("initialized", {});
    this.client = client;
    this.logger.info("app-server client ready");
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
    try {
      return await this.runTurnOnce(client, threadId, env);
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
      return await this.runTurnOnce(client, threadId, env);
    }
  }

  private runTurnOnce(
    client: AppServerClient,
    threadId: string,
    env: Envelope
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      const itemText: Map<string, string> = new Map();

      let processingSignaled = false;
      const deltaSub = client.onNotification("item/agentMessage/delta", (params) => {
        if (!processingSignaled) {
          // First streaming delta = Codex has accepted the turn and
          // is actively producing output. Flip the status bar from
          // the "sending" arrow to the "processing" comment-discussion
          // animation so the user sees the real work phase.
          writeProcessingFlag();
          processingSignaled = true;
        }
        const d = params as AgentMessageDelta;
        const prev = itemText.get(d.itemId) || "";
        itemText.set(d.itemId, prev + (d.delta || ""));
      });

      const completedSub = client.onNotification("turn/completed", (params) => {
        const c = params as TurnCompleted;
        deltaSub.dispose();
        completedSub.dispose();
        clearInterval(cancelWatch);

        if (c.turn.status !== "completed") {
          const errMsg = c.turn.error?.message ?? `turn ${c.turn.status}`;
          reject(new Error(errMsg));
          return;
        }

        // Prefer final item text over aggregated deltas
        for (const item of c.turn.items) {
          if (item.type === "agentMessage" && item.text) {
            chunks.push(item.text);
          }
        }
        if (chunks.length === 0) {
          // Fall back to delta aggregation
          for (const text of itemText.values()) chunks.push(text);
        }

        const combined = chunks.join("\n").trim();
        if (combined.length === 0) {
          // Empty completed turn means Codex accepted and finished
          // but produced no agentMessage items - typically a thread
          // poisoned by a prior orphan turn (timeout without
          // interrupt) or a transient model issue. Treat as a
          // recoverable failure so the consecutive-failure counter
          // bumps and threshold-based rotation can kick in instead
          // of silently surfacing "(empty reply)" to Claude.
          clearTimeout(timeout);
          reject(new Error("empty reply from Codex (thread may be in a degraded state; will rotate after threshold or pick \"Reset Codex Session\" from the menu)"));
          return;
        }
        clearTimeout(timeout);
        resolve(combined);
      });

      const timeout = setTimeout(() => {
        deltaSub.dispose();
        completedSub.dispose();
        clearInterval(cancelWatch);
        // Send turn/interrupt to Codex so the orphan turn stops on
        // its side. Without this, the thread stays "busy" from
        // Codex's view and the next prompt gets a degraded turn
        // (often a turn/completed with zero agentMessage items,
        // surfaced as "(empty reply)"). Best-effort - if interrupt
        // itself errors there's nothing useful we can do.
        const interruptParams: TurnInterruptParams = { threadId };
        client
          .sendRequest("turn/interrupt", interruptParams)
          .catch(() => {
            // intentionally swallowed
          });
        reject(new Error(`turn timeout after ${TURN_TIMEOUT_MS}ms`));
      }, TURN_TIMEOUT_MS);

      // User-cancel sentinel. Status bar's "Cancel in-flight prompt"
      // action writes CANCEL_FLAG_PATH; we poll every 500ms, and
      // when we see it we send turn/interrupt just like the timeout
      // path and reject with a distinct message so the reply Claude
      // sees is unambiguous ("cancelled by user"). The flag gets
      // unlinked here so a later turn can set it again without a
      // stale file blocking dispatch.
      const cancelWatch = setInterval(() => {
        if (!existsSync(CANCEL_FLAG_PATH)) return;
        try {
          unlinkSync(CANCEL_FLAG_PATH);
        } catch {
          // best-effort
        }
        clearTimeout(timeout);
        clearInterval(cancelWatch);
        deltaSub.dispose();
        completedSub.dispose();
        const interruptParams: TurnInterruptParams = { threadId };
        client
          .sendRequest("turn/interrupt", interruptParams)
          .catch(() => {
            // intentionally swallowed
          });
        reject(new Error("cancelled by user"));
      }, 500);

      // Fire and forget - responses arrive via the subscriptions above
      const turnStartParams: TurnStartParams = {
        threadId,
        input: [{ type: "text", text: env.body }],
        sandboxPolicy: { type: "readOnly" },
        approvalPolicy: "never",
      };
      client
        .sendRequest("turn/start", turnStartParams, TURN_TIMEOUT_MS)
        .then(() => {
          // turn/start returned with the turn object; we still wait
          // for turn/completed notification (above)
        })
        .catch((err) => {
          clearTimeout(timeout);
          clearInterval(cancelWatch);
          deltaSub.dispose();
          completedSub.dispose();
          reject(err);
        });
    });
  }
}
