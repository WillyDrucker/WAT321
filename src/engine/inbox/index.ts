/**
 * Barrel export for the engine's inbox primitives. Tier code imports
 * the unified envelope schema, path helpers, writer, reader, and
 * multi-target coordinator from one place so the dependency direction
 * stays clean: tier -> engine, never engine -> tier.
 */

export {
  buildInboundEnvelope,
  buildOutboundEnvelope,
  newEnvelopeId,
  parseEnvelope,
  readEnvelope,
  serializeEnvelope,
  writeEnvelopeAtomic,
  type Envelope,
  type EnvelopeAgent,
  type EnvelopeKind,
  type EnvelopePriority,
  type EnvelopeTarget,
  type EnvelopeWaitMode,
} from "./envelope";
export {
  EH_ROOT_DIR,
  allInboundDirs,
  allOutboundDirs,
  inboundDir,
  outboundDir,
  sentDir,
} from "./inboxPaths";
export { inboundPathFor, writeInbound, writeOutbound } from "./inboxWriter";
export {
  LATE_REPLY_THRESHOLD_MS,
  countPendingLateReplies,
  drainPendingReplies,
  listLateReplies,
  newestLateReplyAgeMs,
  peekInbox,
  type DrainedReply,
} from "./inboxReader";
export { InboxCoordinator, type InboxSnapshot } from "./inboxCoordinator";
