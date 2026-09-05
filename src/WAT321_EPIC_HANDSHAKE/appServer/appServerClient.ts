import { AppServerProcess } from "./appServerProcess";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import {
  JsonRpcDispatch,
  type ClientDisposable,
  type NotificationHandler,
} from "./jsonRpcDispatch";
import { JSONRPC_VERSION, type JsonRpcRequest } from "./jsonRpcEnvelope";

/**
 * JSON-RPC 2.0 client that drives `codex app-server` over stdio.
 *
 * Owns the public send / subscribe surface and request ids. The child
 * process lives in the sibling `AppServerProcess` (spawn, stdin,
 * stdout lines, shutdown, force-kill), and JSON-RPC frame parsing,
 * pending-request tracking, and notification fan-out live in
 * `JsonRpcDispatch`. This class wires the two together.
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

/** Default timeout for a request's response. Covers control-plane
 * calls like `initialize` and `thread/start`. Turn requests pass
 * their own longer timeout because turns routinely exceed 30s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** SIGTERM grace before `shutdown` escalates to SIGKILL. */
const DEFAULT_SHUTDOWN_GRACE_MS = 2000;

/** Options passed to the client constructor. */
interface AppServerClientOptions {
  /** Logger for lifecycle events. Required: this is the one place
   * in WAT321 where debug logging is allowed. */
  logger: EpicHandshakeLogger;
  /** Per-window instance id for log prefixing. Helps distinguish
   * which VS Code window's client produced which log lines. */
  instanceId: string;
  /** Override the `codex` command path. Defaults to `codex` on
   * PATH. */
  executable?: string;
  /** Override the default per-request timeout. Per-call timeouts
   * can be supplied to `sendRequest` directly for long operations
   * like `turn/start`. */
  defaultRequestTimeoutMs?: number;
}

export class AppServerClient {
  private nextRequestId = 1;
  private readonly defaultRequestTimeoutMs: number;
  private readonly dispatch: JsonRpcDispatch;
  private readonly process: AppServerProcess;

  constructor(options: AppServerClientOptions) {
    this.defaultRequestTimeoutMs =
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.dispatch = new JsonRpcDispatch(options.logger, options.instanceId);
    this.process = new AppServerProcess(options.logger, options.instanceId, options.executable, {
      onLine: (line) => this.dispatch.routeFrame(line),
      onFailure: (err) => this.dispatch.failAllPending(err),
    });
  }

  /** Spawn the `codex app-server` child process. Callers must then
   * send `initialize` before any other request. */
  spawn(): void {
    this.process.spawn();
  }

  /** Is the child process alive and usable? */
  get isAlive(): boolean {
    return this.process.isAlive;
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
      if (!this.isAlive) {
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
      timer.unref?.();

      this.dispatch.registerPending(id, { method, resolve, reject, timer });

      try {
        this.process.write(`${JSON.stringify(request)}\n`, (err) =>
          this.dispatch.failPending(id, err)
        );
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
    if (!this.isAlive) {
      throw new Error("AppServerClient: not alive");
    }
    this.process.write(
      `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`
    );
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

  /** Clean shutdown: SIGTERM, a grace period, then SIGKILL. Safe to
   * call multiple times or after the child has already exited. */
  shutdown(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    return this.process.shutdown(graceMs);
  }

  /** Immediate SIGKILL with no grace period. Pending requests are
   * rejected synchronously so callers unwind cleanly. */
  forceKill(): void {
    this.process.forceKill();
  }
}
