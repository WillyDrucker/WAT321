/**
 * Compatibility shim. The implementation moved to the engine layer at
 * `engine/inbox/inboxReader.ts` so all backends share the same drain
 * / list / count primitives. This file stays as a thin re-export so
 * existing callers (pickers, menus) continue to work without a
 * wholesale rename pass.
 *
 * New code should import from `engine/inbox` directly:
 *
 *   import { listLateReplies, type DrainedReply } from "../engine/inbox";
 *
 * The legacy type name `LateReply` aliases `DrainedReply` - the engine
 * version carries every field the legacy shape did (filename, fullPath,
 * body, createdAt, intent, sizeKb, sentDestPath, source) plus an
 * `envelope` field for callers that want the full parsed shape.
 */

export {
  countPendingLateReplies,
  newestLateReplyAgeMs,
  listLateReplies,
  type DrainedReply as LateReply,
} from "../engine/inbox";
