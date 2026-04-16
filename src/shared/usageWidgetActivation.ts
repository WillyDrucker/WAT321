import type * as vscode from "vscode";
import type { Subscribable } from "../engine/contracts";

/**
 * Generic widget activator. Subscribes a widget to a service's
 * state stream and returns disposables for teardown. Used by
 * bootstrap.ts to wire every usage and session token widget.
 */

interface UpdatableWidget<S> extends vscode.Disposable {
  update(state: S): void;
}

export function activateWidget<S>(
  service: Pick<Subscribable<S>, "subscribe" | "unsubscribe">,
  widget: UpdatableWidget<S>
): vscode.Disposable[] {
  const listener = (state: S) => widget.update(state);
  service.subscribe(listener);
  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
