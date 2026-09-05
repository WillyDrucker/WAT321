import { EventHub } from "./eventHub";
import { ProviderRegistry } from "./providerRegistry";
import { validateCatalog } from "./widgetCatalog";

/**
 * Thin container for engine subsystems. Passed to tool activation
 * functions so they can access the registry and event hub without
 * importing singletons. Created once in `extension.ts activate()`.
 *
 * Coordinators (`bridgeStageCoordinator`, the engine's
 * `InboxCoordinator`) are constructed during the Epic Handshake
 * tier's activation, not here.
 */
export interface EngineContext {
  providers: ProviderRegistry;
  events: EventHub;
}

/** Create the engine context and run startup validation. */
export function createEngineContext(): EngineContext {
  validateCatalog();
  return {
    providers: new ProviderRegistry(),
    events: new EventHub(),
  };
}
