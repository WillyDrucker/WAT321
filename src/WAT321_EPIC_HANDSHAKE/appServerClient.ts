import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  JsonRpcDispatch,
  type ClientDisposable,
  type NotificationHandler,
} from "./jsonRpcDispatch";
import { JSONRPC_VERSION, type JsonRpcRequest } from "./protocol";
import type { EpicHandshakeLogger } from "./types";

export {
  AppServerRequestError,
  type ClientDisposable,
  type NotificationHandler,
} from "./jsonRpcDispatch";

/**
 * JSON-RPC 2.0 client that drives `codex app-server` over stdio.
 *
 * Owns the child-process lifecycle (spawn / shutdown / force-kill)
 * and the public send / subscribe surface. JSON-RPC frame parsing,
 * pending-request tracking, and notification fan-out live in the
 * sibling `JsonRpcDispatch` helper - this class drives stdin and
 * forwards stdout lines into the helper's `routeFrame`.
 *
 * Does NOT:
 *
 *   - Retry requests. Callers (the service layer) handle backoff,
 *     `-32001` overload recovery, and reconnect.
 *   - Know anything about specific methods. The typed bindings in
 *     `protocol.ts` are consumed by callers, not here.
 *   - Import `vscode`. This file is pure Node + our own types so
 *     standalone integration tests can drive it without loading a
 *     full VS Code extension host.
 */

/** Default command used to spawn `codex app-server`. Discovered on
 * `PATH` at runtime via the standard child-process search, so the
 * user just needs `codex` installed normally. */
const DEFAULT_CODEX_COMMAND = "codex";

/** Subcommand arguments. `app-server` is the headless JSON-RPC
 * surface. `stdio://` is the documented default transport. */
const CODEX_APP_SERVER_ARGS = ["app-server"];

/** Default timeout for a request's response. Covers control-plane
 * calls like `initialize` and `thread/start`. The dispatcher
 * overrides with its own per-turn timeout (`TURN_TIMEOUT_MS` in
 * `codexDispatcher.ts`) because turns routinely exceed 30s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Sentinel for the stdout line parser. Codex app-server writes
 * one JSON object per line terminated by `\n`. */
const LINE_TERMINATOR = "\n";

/** Options passed to the client constructor. */
export interface AppServerClientOptions {
  /** Logger for lifecycle events. Required: this is the one place
   * in WAT321 where debug logging is allowed. */
  logger: EpicHandshakeLogger;
  /** Per-window instance id for log prefixing. Helps distinguish
   * which VS Code window's client produced which log lines. */
  instanceId: string;
  /** Override the `codex` command path. Defaults to `codex` on
   * PATH. Mainly useful for tests. */
  executable?: string;
  /** Override the default per-request timeout. Per-call timeouts
   * can be supplied to `sendRequest` directly for long operations
   * like `turn/start`. */
  defaultRequestTimeoutMs?: number;
}

export class AppServerClient {
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  // stderr from the Codex app-server is discarded on purpose: the
  // server emits structured logs there that are not actionable from
  // the extension side, and buffering them has historically leaked
  // memory on chatty builds.
  private isShuttingDown = false;
  private hasSpawned = false;

  private readonly logger: EpicHandshakeLogger;
  private readonly instanceId: string;
  private readonly executable: string;
  private readonly defaultRequestTimeoutMs: number;
  private readonly dispatch: JsonRpcDispatch;

  constructor(options: AppServerClientOptions) {
    this.logger = options.logger;
    this.instanceId = options.instanceId;
    this.executable = options.executable ?? DEFAULT_CODEX_COMMAND;
    this.defaultRequestTimeoutMs =
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.dispatch = new JsonRpcDispatch(this.logger, this.instanceId);
  }

  /** Spawn the `codex app-server` child process. Resolves once the
   * process is running with stdio pipes wired up. Callers must
   * then send `initialize` before any other request. */
  spawn(): void {
    if (this.hasSpawned) {
      throw new Error("AppServerClient: already spawned");
    }
    this.hasSpawned = true;
    this.logger.info(
      `[${this.instanceId}] spawning ${this.executable} ${CODEX_APP_SERVER_ARGS.join(" ")}`
    );

    // On Windows, `codex` is typically a `.cmd` shim installed by
    // npm. Node's child_process.spawn without `shell: true` will not
    // find `.cmd`/`.bat` wrappers on PATH, so we enable shell on
    // win32. This matches how other Node tooling (e.g. cross-spawn)
    // handles the same case. On POSIX, `codex` is a real binary and
    // we spawn it directly.
    const useShell = process.platform === "win32";
    const child = spawn(this.executable, CODEX_APP_SERVER_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });

    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stdout?.on("error", (err) => {
      this.logger.error(`[${this.instanceId}] stdout error: ${err.message}`);
    });

    // Codex app-server's stderr is intentionally drained and ignored.
    // The server emits structured operational logs there that the
    // extension cannot act on - surfacing them would only add noise.
    child.stderr?.resume();

    child.on("error", (err) => {
      this.logger.error(`[${this.instanceId}] spawn error: ${err.message}`);
      this.dispatch.failAllPending(err);
    });

    child.on("exit", (code, signal) => {
      this.logger.info(
        `[${this.instanceId}] app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`
      );
      this.child = null;
      if (!this.isShuttingDown) {
        const err = new Error(
          `codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
        );
        this.dispatch.failAllPending(err);
      }
    });
  }

  /** Is the child process alive and usable? */
  get isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.isShuttingDown;
  }

  /** Send a JSON-RPC request and await its response. Rejects with
   * `AppServerRequestError` on protocol errors, or a generic
   * `Error` on transport failures (child dead, write error, timeout).
   *
   * The returned promise resolves with the raw `result` field from
   * the server, typed as `unknown`. Callers do their own runtime
   * shape check. */
  sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number = this.defaultRequestTimeoutMs
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isAlive || this.child === null) {
        reject(new Error("AppServerClient: not alive"));
        return;
      }
      const id = this.nextRequestId++;
      const request: JsonRpcRequest = {
        jsonrpc: JSONRPC_VERSION,
        id,
        method,
        params,
      };
      const frame = `${JSON.stringify(request)}\n`;

      const timer = setTimeout(() => {
        if (this.dispatch.hasPending(id)) {
          this.dispatch.failPending(
            id,
            new Error(
              `AppServerClient: request ${method} (id=${id}) timed out after ${timeoutMs}ms`
            )
          );
        }
      }, timeoutMs);
      // Allow the Node process to exit even if a timer is pending
      // (mostly relevant to standalone tests).
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }

      this.dispatch.registerPending(id, { method, resolve, reject, timer });

      try {
        const stdin = this.child.stdin;
        if (stdin === null || stdin.writable !== true) {
          throw new Error("stdin is not writable");
        }
        stdin.write(frame, (err) => {
          if (err !== null && err !== undefined) {
            this.dispatch.failPending(id, err);
          }
        });
      } catch (err) {
        this.dispatch.failPending(id, err as Error);
      }
    });
  }

  /** Send a fire-and-forget JSON-RPC notification (no id, no
   * response awaited). Used for the MCP-style `initialized`
   * handshake ack and any other notification frames the client
   * needs to emit. */
  sendNotification(method: string, params: unknown): void {
    if (!this.isAlive || this.child === null) {
      throw new Error("AppServerClient: not alive");
    }
    const frame = `${JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      method,
      params,
    })}\n`;
    const stdin = this.child.stdin;
    if (stdin === null || stdin.writable !== true) {
      throw new Error("stdin is not writable");
    }
    stdin.write(frame);
  }

  /** Subscribe to a specific notification method. Returns a
   * disposable that unsubscribes on `dispose()`. Multiple handlers
   * for the same method are supported and all fire in registration
   * order. */
  onNotification(
    method: string,
    handler: NotificationHandler
  ): ClientDisposable {
    return this.dispatch.addNotificationHandler(method, handler);
  }

  /** Clean shutdown. Sends SIGTERM to the child, waits briefly for
   * it to exit, then SIGKILLs if still alive. Safe to call multiple
   * times or after the child has already exited. */
  async shutdown(graceMs: number = 2000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.info(`[${this.instanceId}] shutting down app-server`);

    const child = this.child;
    if (child === null || child.exitCode !== null) {
      this.child = null;
      this.dispatch.failAllPending(new Error("AppServerClient: shutting down"));
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // best-effort
    }

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    });

    if (!exited) {
      this.logger.warn(
        `[${this.instanceId}] SIGTERM grace expired, sending SIGKILL`
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }

    this.child = null;
    this.dispatch.failAllPending(new Error("AppServerClient: shut down"));
  }

  /** Immediate kill. Sends SIGKILL straight to the child without
   * the SIGTERM grace period that `shutdown` uses. The bridge's
   * "Restart Codex Bridge" menu action calls this when the user
   * wants the running app-server gone now (cached stale config,
   * misbehaving connection, etc.). Any in-flight pending requests
   * are rejected synchronously so callers unwind cleanly. Idempotent -
   * subsequent calls no-op once `child` is null. */
  forceKill(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.info(`[${this.instanceId}] force-killing app-server (SIGKILL)`);
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
    this.dispatch.failAllPending(new Error("AppServerClient: force-killed"));
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const nlIndex = this.stdoutBuffer.indexOf(LINE_TERMINATOR);
      if (nlIndex === -1) break;
      const line = this.stdoutBuffer.substring(0, nlIndex);
      this.stdoutBuffer = this.stdoutBuffer.substring(nlIndex + 1);
      if (line.trim() === "") continue;
      this.dispatch.routeFrame(line);
    }
  }
}
