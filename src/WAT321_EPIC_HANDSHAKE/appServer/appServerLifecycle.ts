import { resolveCodexCli } from "../../shared/providers/codex/cliResolver";
import { clearCodexCatalog } from "../../shared/providers/codex/modelCatalog";
import { spawnInitializedAppServer } from "./appServerBootstrap";
import type { AppServerClient } from "./appServerClient";
import { syncCodexCatalog } from "../codexSettings/codexCatalogSync";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * The dispatcher's warm `codex app-server` child: lazy spawn on first
 * use, a 15-minute idle shutdown that never fires mid-turn, prewarm
 * for bridge restart, force-kill for a binary that changed underneath
 * us, and the model-catalog side effect each of those carries.
 */

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Re-check cadence when the idle timer fires during a turn. */
const IDLE_RECHECK_MS = 60_000;

export class AppServerLifecycle {
  private client: AppServerClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly logger: EpicHandshakeLogger,
    /** True while an envelope is being processed, so the idle timer
     * defers instead of killing the child mid-turn. */
    private readonly isProcessing: () => boolean
  ) {}

  /** The warm client, spawning and initializing one when absent. */
  async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const resolved = await resolveCodexCli();
    const client = await spawnInitializedAppServer(this.logger, "codexDispatcher", resolved);
    this.client = client;
    // Not awaited: the catalog is a display / validation convenience and
    // must not sit in front of the first turn. Readers fall back to the
    // cache file until it lands. Never touches the idle timer. Also
    // persists the answer under this binary's identity so the next
    // window starts truthful.
    void syncCodexCatalog(client, resolved, this.logger);
    return client;
  }

  /** Eagerly spawn the child and complete `initialize` without
   * dispatching any turn. Idempotent.
   *
   * NOT called at activate. The tier deliberately spawns no codex
   * daemon on activation (see `index.ts`), so the only caller is
   * `restartBridge()`, whose whole point is to leave the bridge ready.
   * The first user-visible dispatch otherwise pays the cold-start chain
   * itself, and the model catalog stays empty until something
   * dispatches, which is why `hydrateCodexCatalog` at dispatcher start
   * covers the picker for that window.
   *
   * Failures are logged and swallowed - the first real dispatch
   * surfaces the problem the normal way. */
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

  /** Force-kill the current child and drop the cached client. Next
   * dispatch spawns fresh. Used by "Restart Codex Bridge" when the
   * user needs the Codex process gone now (stale cached config, stuck
   * state). Idempotent. */
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

  /** Start the 15-minute idle window over. Called at turn start so
   * the window counts from now, not from whenever the LAST turn
   * ended, and again on every successful turn end. */
  resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdleTimerFire(), IDLE_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
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

  /** The child must never be idle-killed during an active turn (#81).
   * When the timer fires with a turn still processing, re-schedule
   * THIS check (not a full new idle window) so the next firing
   * re-evaluates against fresh state. */
  private onIdleTimerFire(): void {
    if (this.isProcessing()) {
      this.logger.warn(
        "codex dispatcher idle timeout fired while processing, deferring shutdown"
      );
      this.idleTimer = setTimeout(() => this.onIdleTimerFire(), IDLE_RECHECK_MS);
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
}
