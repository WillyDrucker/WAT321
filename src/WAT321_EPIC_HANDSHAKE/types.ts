/** Minimal logger interface used by the JSON-RPC client and service.
 * Kept dependency-free (no `vscode` import) so standalone tests can
 * provide a console or array-backed implementation while the real
 * extension wires the VS Code output channel via `outputChannel.ts`.
 *
 * This is the one place in WAT321 where debug logging is allowed,
 * driven by the fact that a child process + event stream is
 * inherently harder to debug than the pure-pull usage widgets. The
 * logger is deliberately tiny and its call sites are strictly
 * limited - see Section 14 risk #5 in the plan. */
export interface EpicHandshakeLogger {
  /** Lifecycle / state transition events. */
  info(message: string): void;
  /** Expected recoverable conditions (crash, retry, JSONC fallback). */
  warn(message: string): void;
  /** Unexpected failures that need attention. */
  error(message: string): void;
}

/** Recipient/sender agent identifier. */
export type AgentId = "claude" | "codex";

/** Semantic intent of an Epic Handshake message. Drives the receiving
 * agent's triage decision but has no extension-side behavior. */
export type MessageIntent =
  | "question"
  | "review"
  | "handoff"
  | "decision"
  | "reply";

/** Full on-disk message envelope. Fields mirror the YAML frontmatter
 * schema documented in the plan. `body` is the markdown text below
 * the frontmatter separator. */
export interface MessageEnvelope {
  /** Unique id. Matches the filename stem. Format
   * `YYYY-MM-DDTHH-MM-SS-<6hex>`, generated via `generateMessageId`. */
  id: string;
  /** Agent that sent this message. */
  from: AgentId;
  /** Agent that should receive this message. */
  to: AgentId;
  /** Semantic tag for the recipient's triage. */
  intent: MessageIntent;
  /** One-line subject. Shown in widget tooltip and hook output. */
  title: string;
  /** ISO 8601 wall-clock creation time. */
  createdAt: string;
  /** Id of the message this is replying to, or `null` for originals. */
  replyTo: string | null;
  /** Repo-relative file paths the recipient can read via their own
   * `Read` tool. Bodies are never inlined so envelopes stay small
   * and tokens stay cheap. */
  attachments: string[];
  /** Markdown body. Everything below the frontmatter separator. */
  body: string;
}
