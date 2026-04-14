import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcResponse,
  JSONRPC_VERSION,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol";
import type { EpicHandshakeLogger } from "./types";

/**
 * JSON-RPC 2.0 client that drives `codex app-server` over stdio.
 *
 * Responsibilities:
 *
 *   - Spawn the child process with `codex app-server` and pipe
 *     stdin/stdout/stderr.
 *   - Parse line-delimited JSON frames from stdout into structured
 *     JSON-RPC responses and notifications.
 *   - Route responses back to the `Promise` that `sendRequest`
 *     returned, matched by the `id` field.
 *   - Route notifications to per-method subscriber handlers.
 *   - Handle child process crash and stdin write errors by
 *     surfacing them to pending requests and marking the client
 *     unhealthy.
 *   - Clean shutdown on `close()`.
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

/** How long to wait for a request's response before rejecting the
 * pending promise. Individual turn/start calls take much longer
 * than this, so the service layer overrides with its own per-turn
 * timeout (5 minutes per the plan). This is the default for
 * control-plane calls like `initialize` and `thread/start`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Sentinel for the stdout line parser. Codex app-server writes
 * one JSON object per line terminated by `\n`. */
const LINE_TERMINATOR = "\n";

/** Handler for a JSON-RPC notification. Receives the raw `params`
 * (typed as unknown) and is responsible for any shape validation. */
export type NotificationHandler = (params: unknown) => void;

/** Disposable returned by `onNotification` so callers can
 * unsubscribe. Matches the VS Code `Disposable` shape without
 * importing vscode. */
export interface ClientDisposable {
  dispose(): void;
}

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

/** Result of a request failure. Clients can check `isOverloaded`
 * to decide whether to retry. */
export class AppServerRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly isOverloaded: boolean;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "AppServerRequestError";
    this.code = code;
    this.data = data;
    this.isOverloaded = code === -32001;
  }
}

/** Internal pending-request tracking. */
interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerClient {
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<
    string,
    Set<NotificationHandler>
  >();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private isShuttingDown = false;
  private hasSpawned = false;

  private readonly logger: EpicHandshakeLogger;
  private readonly instanceId: string;
  private readonly executable: string;
  private readonly defaultRequestTimeoutMs: number;

  constructor(options: AppServerClientOptions) {
    this.logger = options.logger;
    this.instanceId = options.instanceId;
    this.executable = options.executable ?? DEFAULT_CODEX_COMMAND;
    this.defaultRequestTimeoutMs =
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Buffer stderr for diagnostics but do not log by default;
      // Codex app-server emits structured logs there and spamming
      // the output channel is counterproductive.
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 16_384) {
        // Trim to last 16KB so we do not leak memory on a chatty
        // server. Diagnostic value is in the most recent output.
        this.stderrBuffer = this.stderrBuffer.slice(-16_384);
      }
    });

    child.on("error", (err) => {
      this.logger.error(`[${this.instanceId}] spawn error: ${err.message}`);
      this.failAllPending(err);
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
        this.failAllPending(err);
      }
    });
  }

  /** Is the child process alive and usable? */
  get isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.isShuttingDown;
  }

  /** Recent stderr output (up to ~16KB). Useful for diagnostics
   * after an unexpected exit. */
  get recentStderr(): string {
    return this.stderrBuffer;
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
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

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        const stdin = this.child.stdin;
        if (stdin === null || stdin.writable !== true) {
          throw new Error("stdin is not writable");
        }
        stdin.write(frame, (err) => {
          if (err !== null && err !== undefined) {
            this.failPending(id, err);
          }
        });
      } catch (err) {
        this.failPending(id, err as Error);
      }
    });
  }

  /** Subscribe to a specific notification method. Returns a
   * disposable that unsubscribes on `dispose()`. Multiple handlers
   * for the same method are supported and all fire in registration
   * order. */
  onNotification(
    method: string,
    handler: NotificationHandler
  ): ClientDisposable {
    let handlers = this.notificationHandlers.get(method);
    if (handlers === undefined) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return {
      dispose: (): void => {
        const set = this.notificationHandlers.get(method);
        if (set !== undefined) {
          set.delete(handler);
          if (set.size === 0) this.notificationHandlers.delete(method);
        }
      },
    };
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
      this.failAllPending(new Error("AppServerClient: shutting down"));
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // best-effort
    }

    // Wait for exit within the grace period
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
    this.failAllPending(new Error("AppServerClient: shut down"));
  }

  // -----------------------------------------------------------------
  // Internal: stdout line parsing and frame dispatch
  // -----------------------------------------------------------------

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nlIndex: number;
    while ((nlIndex = this.stdoutBuffer.indexOf(LINE_TERMINATOR)) !== -1) {
      const line = this.stdoutBuffer.substring(0, nlIndex);
      this.stdoutBuffer = this.stdoutBuffer.substring(nlIndex + 1);
      if (line.trim() === "") continue;
      this.dispatchFrame(line);
    }
  }

  private dispatchFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.logger.error(
        `[${this.instanceId}] malformed JSON frame: ${(err as Error).message}`
      );
      return;
    }

    if (isJsonRpcResponse(parsed)) {
      this.dispatchResponse(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      this.dispatchNotification(parsed);
      return;
    }
    this.logger.warn(
      `[${this.instanceId}] unexpected frame shape (neither response nor notification): ${line.slice(0, 400)}`
    );
  }

  private dispatchResponse(response: JsonRpcResponse): void {
    const id = response.id;
    const pending = this.pending.get(id);
    if (pending === undefined) {
      this.logger.warn(
        `[${this.instanceId}] response for unknown request id=${id}`
      );
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (isJsonRpcErrorResponse(response)) {
      pending.reject(this.wrapError(pending.method, response));
      return;
    }
    pending.resolve(response.result);
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    const handlers = this.notificationHandlers.get(notification.method);
    if (handlers === undefined || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(notification.params);
      } catch (err) {
        this.logger.error(
          `[${this.instanceId}] notification handler for ${notification.method} threw: ${(err as Error).message}`
        );
      }
    }
  }

  private wrapError(
    method: string,
    response: JsonRpcErrorResponse
  ): AppServerRequestError {
    const { code, message, data } = response.error;
    this.logger.warn(
      `[${this.instanceId}] request ${method} failed code=${code} message=${message}`
    );
    return new AppServerRequestError(code, message, data);
  }

  private failPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
