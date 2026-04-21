/**
 * Barrel re-export. Real implementations live in:
 *   - `threadRecord.ts`     - record IO + reset / clear-error operations
 *   - `threadNaming.ts`     - display-name + collision-free counter policy
 *   - `sessionRecovery.ts`  - Codex `~/.codex/sessions/` walks + recover
 *
 * Kept as a single import surface so callers don't need to reach into
 * three files for what conceptually is "everything about the bridge
 * thread record." Splitting was driven by file-size pressure, not by
 * a callsite seam.
 */

export {
  bridgeThreadDisplayName,
  maxExistingSessionCounter,
  nextCollisionFreeCounter,
} from "./threadNaming";
export {
  findRolloutPath,
  listRecoverableSessions,
  recoverBridgeThread,
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
