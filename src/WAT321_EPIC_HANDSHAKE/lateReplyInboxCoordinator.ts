/**
 * Compatibility shim. The implementation moved to the engine layer at
 * `engine/inbox/inboxCoordinator.ts` so all backends share the same
 * multi-target fs-watch + snapshot logic. This file stays as a thin
 * re-export so existing callers (`statusBarItem.ts`, `index.ts`)
 * continue to work without a wholesale rename pass.
 *
 * New code should import from `engine/inbox` directly:
 *
 *   import { InboxCoordinator, type InboxSnapshot } from "../engine/inbox";
 *
 * The legacy name `LateReplyInboxCoordinator` aliases `InboxCoordinator`
 * because the engine version covers more than just "late replies" - it
 * watches every inbound dir across every enabled target.
 */

export {
  InboxCoordinator as LateReplyInboxCoordinator,
  type InboxSnapshot,
} from "../engine/inbox";
