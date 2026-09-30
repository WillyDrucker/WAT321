import { codexModelOffersServiceTier } from "../../shared/providers/codex/models";
import {
  loadBridgeThreadRecord,
  loadBridgeThreadRecordIfExists,
  saveBridgeThreadRecord,
} from "../codexTurn/threadRecord";
import { readSessionPin } from "./codexSessionSettings";

/**
 * The session's speed tier: standard, or the faster tier its model
 * offers (Fast, id `priority`, "2x speed, increased usage").
 *
 * Session-scoped like model and effort and stored on the same
 * `BridgeThreadRecord`, so reset and delete return to standard while an
 * involuntary rotation keeps the choice.
 *
 * The tier ALWAYS goes on the wire. Codex resolves an omitted tier from
 * `config.toml`, so a machine whose Codex TUI was set to Fast would run
 * every bridge turn Fast while the menu said Standard. Standard is sent
 * as `default`, never as absence. It rides `thread/start`, so a thread
 * is born on the session's choice, and every `turn/start`, so the choice
 * decides each turn whatever the thread was born on. The sandbox is kept
 * honest the same way.
 *
 * A stored tier counts only while the session's model offers it. Codex
 * drops an id it does not recognize without an error (probed), so an
 * unchecked id would quietly run standard while the menu said Fast.
 */

/** The wire value for standard speed. */
export const STANDARD_SERVICE_TIER = "default";

/** The tier to send for a model and a stored choice. */
export function serviceTierFor(
  model: string | null,
  stored: string | null | undefined
): string {
  if (typeof stored !== "string" || stored.length === 0) return STANDARD_SERVICE_TIER;
  if (model === null || !codexModelOffersServiceTier(model, stored)) {
    return STANDARD_SERVICE_TIER;
  }
  return stored;
}

/** The tier this workspace's session runs, exactly as sent on the wire. */
export function readSessionServiceTier(workspacePath: string): string {
  const stored = loadBridgeThreadRecordIfExists(workspacePath)?.serviceTier;
  return serviceTierFor(readSessionPin(workspacePath).model, stored);
}

/** Pin a tier onto this workspace's session, null for standard. Leaves
 * `pinResolved` alone: a speed choice says nothing about the model, and
 * marking it decided would skip the legacy migration that recovers it. */
export function writeSessionServiceTier(workspacePath: string, tier: string | null): void {
  const record = loadBridgeThreadRecord(workspacePath);
  saveBridgeThreadRecord({ ...record, serviceTier: tier });
}
