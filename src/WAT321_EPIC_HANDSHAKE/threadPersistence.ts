/**
 * Barrel re-export for the bridge thread record. Real implementations
 * live in:
 *   - `threadRecord.ts`     - record IO + reset / clear-error operations
 *   - `threadNaming.ts`     - display-name + collision-free counter policy
 *   - `sessionRecovery.ts`  - Codex `~/.codex/sessions/` walks + recover
 *
 * Single import surface so callers don't reach into three files for
 * what conceptually is "everything about the bridge thread record."
 */

export {
  bridgeThreadDisplayName,
  maxExistingSessionCounter,
  nextCollisionFreeCounter,
} from "./threadNaming";
export {
  findRolloutPath,
  listRecoverableSessions,
  readRolloutModelSlug,
  recoverBridgeThread,
  rewriteRolloutModelSlug,
  type RecoverableSession,
} from "./sessionRecovery";
export {
  clearBridgeErrorState,
  loadBridgeThreadRecord,
  loadBridgeThreadRecordIfExists,
  resetBridgeThread,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadRecord";
