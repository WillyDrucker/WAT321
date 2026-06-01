import { EventHub } from "./eventHub";
import { ProviderRegistry } from "./providerRegistry";
import { validateCatalog } from "./widgetCatalog";

/**
 * Thin container for engine subsystems. Passed to tool activation
 * functions so they can access the registry and event hub without
 * importing singletons. Created once in `extension.ts activate()`.
 *
 * Single-tool coordinators (`bridgeStageCoordinator`,
 * `lateReplyInboxCoordinator`) live inside their owning tool tier
 * and are constructed during that tier's activation, not here.
 */
export interface EngineContext {
  providers: ProviderRegistry;
  events: EventHub;
  /** Absolute path to the extension's per-workspace storage dir
   * (`<workspaceStorage>/<wsHash>/<publisher>.<name>/`). Used by the
   * Claude session-tokens tier to derive `state.vscdb` for the
   * selected-session memento read, sidestepping the question of how
   * VS Code computes `<wsHash>`. `null` when no workspace folder is
   * open (`context.storageUri` is undefined). */
  extensionStorageDir: string | null;
}

/** Create the engine context and run startup validation. */
export function createEngineContext(
  extensionStorageDir: string | null
): EngineContext {
  validateCatalog();
  return {
    providers: new ProviderRegistry(),
    events: new EventHub(),
    extensionStorageDir,
  };
}
