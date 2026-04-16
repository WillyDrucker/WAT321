import type * as vscode from "vscode";
import type { ProviderKey } from "./contracts";

/**
 * Typed fire-and-forget event hub for cross-cutting concerns.
 * Providers and tools emit events; any consumer subscribes.
 * No state retention - each emission is independent.
 *
 * Type safety is enforced via the `AppEvents` interface map:
 * `emit<K>` and `on<K>` are both keyed to the same payload type,
 * so a handler registered for "provider.activated" is guaranteed
 * to receive `{ provider: ProviderKey }`, never `unknown`.
 *
 * Subscribers return a `Disposable` for cleanup. The hub itself
 * is window-local - no cross-window coordination.
 */

/** Every event the engine can emit. Add new events here as the
 * engine grows. Handlers receive the exact payload type. */
export interface AppEvents {
  "provider.activated": { provider: ProviderKey };
  "provider.deactivated": { provider: ProviderKey };
  "provider.connected": { provider: ProviderKey };
  "provider.disconnected": { provider: ProviderKey };
  "provider.rateLimited": { provider: ProviderKey; message?: string };
  "engine.reset": Record<string, never>;
}

type Handler<T> = (payload: T) => void;

export class EventHub {
  private handlers = new Map<string, Set<Handler<never>>>();

  /** Subscribe to a typed event. Returns a Disposable for cleanup. */
  on<K extends keyof AppEvents>(
    event: K,
    handler: Handler<AppEvents[K]>
  ): vscode.Disposable {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(handler as Handler<never>);
    return {
      dispose: () => {
        set?.delete(handler as Handler<never>);
        if (set?.size === 0) this.handlers.delete(event as string);
      },
    };
  }

  /** Emit a typed event to all registered handlers. Fire-and-forget:
   * handler exceptions are swallowed so one bad subscriber cannot
   * break another. */
  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    const set = this.handlers.get(event as string);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as Handler<AppEvents[K]>)(payload);
      } catch {
        // Swallow - one subscriber must not break another.
      }
    }
  }

  /** Remove all handlers. Called from engine dispose. */
  clear(): void {
    this.handlers.clear();
  }
}
