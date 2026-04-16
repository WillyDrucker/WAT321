import type * as vscode from "vscode";

/**
 * Generic activator for the read-only usage widgets. Each provider
 * has two widget shapes (5 hour, weekly) and both follow exactly the
 * same wiring: construct the widget, subscribe it to the shared
 * service's state stream, and return the widget plus an unsubscribe
 * disposable so the caller can tear everything down in one pass.
 *
 * Lives in `shared/` so the four near-identical `activateXTool`
 * functions can collapse into a single call. The helper is
 * intentionally minimal - it does not start the service, since
 * provider activation in `bootstrap.ts` starts each shared service
 * exactly once after wiring all of its widgets.
 */

interface SubscribableService<S> {
  subscribe(listener: (state: S) => void): void;
  unsubscribe(listener: (state: S) => void): void;
}

interface UpdatableWidget<S> extends vscode.Disposable {
  update(state: S): void;
}

export function activateWidget<S>(
  service: SubscribableService<S>,
  widget: UpdatableWidget<S>
): vscode.Disposable[] {
  const listener = (state: S) => widget.update(state);
  service.subscribe(listener);
  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
