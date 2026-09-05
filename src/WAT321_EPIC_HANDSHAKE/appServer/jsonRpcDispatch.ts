import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./jsonRpcEnvelope";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * JSON-RPC dispatch helper for `AppServerClient`. Owns the pending-
 * request map, the notification handler registry, and the frame
 * parser. The client owns the child process and the stdin write
 * side - this helper handles everything that arrives back over
 * stdout, plus failure surfaces (timeout, transport error,
 * shutdown) that need to reject pending requests cleanly.
 *
 * Split out of `appServerClient.ts` so the client class can stay
 * focused on lifecycle (spawn / shutdown / force-kill) and the
 * send/subscribe public surface.
 */

/** Handler for a JSON-RPC notification. Receives the raw `params`
 * (typed as unknown) and is responsible for any shape validation. */
export type NotificationHandler = (params: unknown) => void;

/** Disposable returned by `onNotification` so callers can
 * unsubscribe. Matches the VS Code `Disposable` shape without
 * importing vscode. */
export interface ClientDisposable {
  dispose(): void;
}

/** Failure thrown by `sendRequest` when the server responds with a
 * JSON-RPC error body. Callers use `failureClassifier.classifyFailure()`
 * to branch on recoverable vs definitive modes via message substring
 * matching - numeric codes have drifted across Codex app-server
 * versions and are not the stable signal. */
class AppServerRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "AppServerRequestError";
    this.code = code;
    this.data = data;
  }
}

/** Internal pending-request tracking. */
interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Redact value fields when logging a malformed JSON-RPC frame so
 * content that happens to appear there never leaks. Returns the
 * top-level key names only, truncated. */
function frameShapeForLog(line: string): string {
  try {
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object") {
      return `keys=[${Object.keys(parsed).slice(0, 10).join(",")}]`;
    }
    return `type=${typeof parsed}`;
  } catch {
    return `unparseable len=${line.length}`;
  }
}

export class JsonRpcDispatch {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<
    string,
    Set<NotificationHandler>
  >();

  constructor(
    private readonly logger: EpicHandshakeLogger,
    private readonly instanceId: string
  ) {}

  /** Register a pending request so the response routes back to it. */
  registerPending(id: number, pending: PendingRequest): void {
    this.pending.set(id, pending);
  }

  /** Is this id still waiting for a response? Used by the timeout
   * callback so a late response cannot reject a timed-out request. */
  hasPending(id: number): boolean {
    return this.pending.has(id);
  }

  /** Route an inbound JSON-RPC frame. Parses, classifies, and either
   * resolves a pending request (response) or fans out to subscribed
   * notification handlers. Malformed frames log and drop. */
  routeFrame(line: string): void {
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
      this.routeResponse(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      this.routeNotification(parsed);
      return;
    }
    const shape = frameShapeForLog(line);
    this.logger.warn(
      `[${this.instanceId}] unexpected frame shape (neither response nor notification): ${shape}`
    );
  }

  /** Subscribe to a notification method. Returns a disposer.
   * Multiple handlers for the same method fire in registration
   * order. */
  addNotificationHandler(
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

  /** Reject one pending request by id (transport error, write
   * failure, timeout). No-op when the id is no longer pending. */
  failPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  /** Reject every pending request with the same error. Called on
   * child-process death, transport error, or shutdown. */
  failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private routeResponse(response: JsonRpcResponse): void {
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
      pending.reject(this.toRequestError(pending.method, response));
      return;
    }
    pending.resolve(response.result);
  }

  private routeNotification(notification: JsonRpcNotification): void {
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

  private toRequestError(
    method: string,
    response: JsonRpcErrorResponse
  ): AppServerRequestError {
    const { code, message, data } = response.error;
    this.logger.warn(
      `[${this.instanceId}] request ${method} failed code=${code} message=${message}`
    );
    return new AppServerRequestError(code, message, data);
  }
}
