import type { CodexEffortOverride } from "../../engine/bridgeTypes";

/**
 * Typed bindings for the `codex app-server` JSON-RPC 2.0 protocol
 * (reference: https://developers.openai.com/codex/app-server and the
 * Rust source in `openai/codex/codex-rs/app-server-protocol/`). Only
 * what Epic Handshake uses is bound: the requests initialize,
 * thread/start, thread/resume, thread/name/set, thread/compact/start,
 * turn/start, turn/interrupt, and model/list, plus the notifications
 * item/agentMessage/delta and turn/completed.
 *
 * Method names stay string literals at the call sites, so what the
 * dispatcher sends is what you read. Params are typed strictly, results
 * are `unknown` and shape-checked at the call site that cares, so a
 * field Codex adds changes nothing and a field that goes missing fails
 * loud exactly where it is read.
 */

// -----------------------------------------------------------------------
// Request param types for the methods Epic Handshake uses
// -----------------------------------------------------------------------

/** Sandbox policy values Codex's app-server accepts. Defines what
 * the bridge's Codex session is allowed to do at the OS level. Same
 * values as the Codex CLI's `--sandbox` flag. */
type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Approval policy values. Controls when Codex pauses to ask for
 * permission. `never` is what Bridge needs (we cannot present
 * prompts back to the user mid-turn). The other values exist on the
 * Codex CLI but are not useful from the bridge's blocking-call
 * shape. */
type CodexApprovalPolicy =
  | "never"
  | "untrusted"
  | "on-failure"
  | "on-request";

/** `thread/start` params. Creates a fresh Bridge thread owned by
 * this client. Always opens the thread at maximum capability
 * ceiling (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`)
 * so any per-turn dial-down is reachable without a thread reset.
 * Per-turn `model`, `effort`, and `sandboxPolicy` overrides are
 * applied on every `turn/start` (see `TurnStartParams`). The Codex
 * Session Settings menu picker writes runtime override flag files
 * that turnRunner reads on every dispatch - the flags persist across
 * activations and clear on Reset WAT321.
 * `sessionStartSource` is echoed into the rollout metadata and
 * helps distinguish bridge-spawned sessions from user-spawned ones
 * when inspecting history. */
export interface ThreadStartParams {
  clientInfo?: {
    name: string;
  };
  /** Working directory hint. Used as the Codex session cwd so
   * rollout files land alongside the user's workspace-scoped
   * sessions instead of in a stray tmpdir. */
  cwd?: string;
  /** Optional model override. Omit to use the user's default. */
  model?: string;
  approvalPolicy?: CodexApprovalPolicy | string;
  sandbox?: CodexSandbox | string;
  /** Source tag echoed into session metadata. Bridge uses `"startup"`. */
  sessionStartSource?: string;
  /** Speed tier the thread is born on. Always sent: omitted, Codex
   * inherits `config.toml`'s `service_tier`. An id no model offers is
   * dropped silently rather than rejected (probed), so callers send only
   * `default` or an id the catalog lists. */
  serviceTier?: string;
}

/** Sandbox policy object shape accepted by `turn/start`. Casing here
 * is DIFFERENT from the `thread/start` `sandbox` string parameter:
 *   - `thread/start.sandbox` -> kebab string (`"read-only"`, `"danger-full-access"`)
 *   - `turn/start.sandboxPolicy.type` -> camelCase (`"readOnly"`, `"dangerFullAccess"`)
 * Both casings are native to the app-server's Rust source. Do not
 * try to unify - the server rejects the wrong casing at the wrong
 * layer. */
type TurnSandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite" }
  | { type: "dangerFullAccess" };

/** `turn/start` params. `approvalPolicy` is always `"never"`, the
 * bridge has no UI to relay approval prompts mid-turn. All three
 * settings are re-read on every turn, so a change in the Codex Model
 * Settings picker takes effect on the next prompt with no thread reset:
 * `sandboxPolicy` from the workspace's `codex-sandbox.<wsHash>.flag`,
 * `model` and `effort` from the session's `BridgeThreadRecord` (see
 * `codexSessionSettings.ts`). `model` and `effort` accept null, which
 * Codex reads as "inherit from the thread / config.toml", but a pinned
 * session never sends a null model: Codex enforces per-turn values and
 * a thread does NOT remember its model across an app-server restart. */
export interface TurnStartParams {
  threadId: string;
  /** Input content. We send a single text block constructed from
   * the Bridge message body plus a compact header listing the
   * sender, intent, title, and any attachment paths. */
  input: TurnInputItem[];
  /** Always `"never"` for Bridge. */
  approvalPolicy: "never";
  /** Resolved per-turn from the full-access flag. */
  sandboxPolicy: TurnSandboxPolicy;
  /** Model override slug. Null = inherit thread / config default. */
  model: string | null;
  /** Reasoning effort override. Null = inherit thread / config default.
   * A level is legal when the target model advertises it, so the wire
   * type does not re-gate what the live catalog already gated. */
  effort: CodexEffortOverride;
  /** Speed tier for this turn and the ones after it. `default` is
   * standard. Sent on every turn so the session's choice, not the
   * thread's birth value or `config.toml`, decides each turn. */
  serviceTier: string;
}

/** Supported input item types in a `turn/start`. Bridge only sends
 * text - images and file attachments are deferred. */
type TurnInputItem = { type: "text"; text: string };

/** `turn/interrupt` params. Cancels an in-flight turn on a thread.
 * `turnId` is optional - the app-server accepts a thread-level cancel
 * and resolves it against the currently active turn, which is what
 * Bridge wants since there is always at most one turn per thread. */
export interface TurnInterruptParams {
  threadId: string;
  turnId?: string;
}

// -----------------------------------------------------------------
// model/list
// -----------------------------------------------------------------

/**
 * `model/list` reports the models the app-server on the other end of
 * this pipe can actually run. The bound fields have held steady on
 * every codex-cli release probed, the retirement pointers are optional
 * because older releases never send them.
 *
 * WARNING: the field names are NOT the cache file's. The RPC is
 * camelCase and renames every field that matters (`slug` -> `id`,
 * `visibility` -> `hidden`, `supported_reasoning_levels[].effort` ->
 * `supportedReasoningEfforts[].reasoningEffort`,
 * `default_reasoning_level` -> `defaultReasoningEffort`,
 * `upgrade.retirement_at` ISO -> `upgradeInfo.retirementAt` epoch
 * seconds). `isDefault` exists only here, `context_window` only in the
 * file, so the default model comes from the RPC and the auto-compact
 * ceiling stays file-sourced.
 *
 * The list is decided server-side per account AND per binary, so two
 * machines answer differently and one answer can change with no
 * upgrade: the catalog records when it was fetched and which binary
 * answered. Hidden models are omitted from the response (0.142.5
 * returns 3 where its file lists 4), so `hidden` has only been seen
 * false. `serviceTiers` drives the Speed row, its deprecated twin
 * `additionalSpeedTiers` is ignored. Also on the wire and unbound until
 * something consumes them: `defaultServiceTier`, `inputModalities`,
 * `supportsPersonality`, `multiAgentVersion`, `modelSpecialty`,
 * `availabilityNux`, `availableAccessPrograms`.
 */
export interface ModelListParams {
  /** Omit for the first page. Feed back `nextCursor` for the rest. */
  cursor?: string;
  /** Also return the models Codex keeps out of its own picker. Verified
   * on 0.153.x: the hidden rows come back flagged `hidden: true`. The
   * app-server runs them all the same, so WAT321 always asks. */
  includeHidden?: boolean;
}

interface ModelListReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

/** A speed tier beyond standard. Observed: every model offers one, id
 * `priority`, named Fast, "2x speed, increased usage". */
interface ModelListServiceTier {
  id: string;
  name?: string;
  description?: string;
}

/** Retirement pointer for a model OpenAI is winding down. `model` is
 * the successor slug, `retirementAt` epoch SECONDS, `migrationMarkdown`
 * the notice Codex shows its own users. */
interface ModelListUpgradeInfo {
  model?: string;
  migrationMarkdown?: string | null;
  retirementAt?: number | null;
}

export interface ModelListEntry {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  /** Codex's own answer to "which model when config.toml names none".
   * Tracks the binary and the account, so a newer codex can flag a
   * newer model. Never hardcode it. */
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: ModelListReasoningEffort[];
  /** Successor slug when the model is being retired, null otherwise.
   * `upgradeInfo` repeats it with the date. */
  upgrade?: string | null;
  upgradeInfo?: ModelListUpgradeInfo | null;
  serviceTiers?: ModelListServiceTier[];
}

/** Cursor-paginated. `nextCursor` is null on the final page. Every
 * version observed returns the full set on page one, but the cursor is
 * part of the contract so we honor it. */
export interface ModelListResult {
  data: ModelListEntry[];
  nextCursor?: string | null;
}
