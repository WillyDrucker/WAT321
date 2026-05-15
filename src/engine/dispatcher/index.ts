/**
 * Barrel export for the engine's dispatcher framework. Tier code
 * implements `BackendDispatcher`, registers it with `OutboundWatcher`,
 * and the engine handles outbound envelope routing + graceful
 * shutdown + stale sweep uniformly.
 */

export type {
  BackendDispatcher,
  DispatchHandler,
  DispatchRequest,
  DispatchResult,
} from "./dispatcherTypes";
export { OutboundWatcher } from "./outboundWatcher";
