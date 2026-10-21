import type { CodexEffortLevel } from "../../engine/bridgeTypes";
import {
  codexModelOffersServiceTier,
  defaultCodexEffortLevel,
  defaultCodexModelSlug,
  getCodexModelInfo,
} from "../../shared/providers/codex/models";
import { workspaceHash } from "../../engine/workspaceHash";
import {
  clearLegacyCodexPinFlags,
  isCodexEffortLevel,
  readLegacyCodexEffortFlag,
  readLegacyCodexModelFlag,
} from "./codexRuntimeOverrides";
import { readRolloutEffectiveModel } from "../codexTurn/rolloutModel";
import { findRolloutPath } from "../codexTurn/sessionRecovery";
import {
  loadBridgeThreadRecord,
  loadBridgeThreadRecordIfExists,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "../codexTurn/threadRecord";

/**
 * The model and effort an Epic Handshake session runs, and how a
 * session acquires them. WAT321 owns this state because Codex does not:
 * a thread's model is fixed at `thread/start` and forgotten, and a
 * resume from a cold app-server reports the `config.toml` model, not
 * the one the thread last ran (verified by probe). A pin that survives
 * closing the IDE therefore lives in our own session record.
 *
 * Lifecycle: a session is BORN on whatever Codex recommends right then
 * (`model/list` `isDefault` plus that model's `defaultReasoningEffort`,
 * nothing hardcoded), KEEPS what it was last set to across restarts,
 * and FORGETS on reset, which is how a user returns to Codex's current
 * recommendation. `~/.codex/config.toml` is never read: it is a
 * machine-wide TUI preference that would make a fresh install behave
 * differently on two machines for reasons invisible in our UI. One
 * record per workspace, S1 then S2 as it is reset.
 */

/** What a session runs. Either field may be null, which `turn/start`
 * reads as "inherit" rather than as an error. */
export interface CodexSessionPin {
  model: string | null;
  effort: CodexEffortLevel | null;
}

/** Threads whose legacy migration has already been attempted in this
 * window. `readSessionPin` runs on the status-bar tick and migration
 * walks `~/.codex/sessions`, so without this latch a record whose
 * migration write fails (EBUSY, read-only disk) would re-walk at 1Hz
 * for the life of the window. One attempt is enough: the write landed
 * and the record answers for itself, or it did not and retrying will
 * not help, and the cached result keeps the answer stable instead of
 * reverting to Codex's default. Keyed by THREAD id, not workspace:
 * a recovered or rotated session is a different thread and migrates on
 * its own terms, and nothing here could invalidate a workspace key
 * since `sessionRecovery` cannot import this module without a cycle. */
const migrationCache = new Map<string, CodexSessionPin>();

/** What Codex would run for a brand-new session, right now. Both halves
 * come from the live catalog, so this tracks OpenAI's default rather
 * than restating it. */
export function codexRecommendedPin(): CodexSessionPin {
  const model = defaultCodexModelSlug();
  const effort = defaultCodexEffortLevel();
  return { model, effort: effort !== null ? effort : null };
}

/** The effort the given model itself defaults to. Used when the user
 * switches model without naming an effort - carrying the old model's
 * effort across would silently apply `ultra` to a model that has no
 * such level. Null when the model is unknown. */
export function defaultEffortForModel(slug: string | null): CodexEffortLevel | null {
  if (slug === null) return null;
  const info = getCodexModelInfo(slug);
  const cand = info?.defaultEffort;
  return typeof cand === "string" && cand.length > 0 ? cand : null;
}

/** Recover a pin for a session that predates this field, most
 * deliberate signal first: the retired per-workspace override flag
 * (the user picked that model in our picker), then the model the
 * rollout shows the session actually running (read from `turn_context`
 * as well as the header, because rollouts from older Codex CLIs carry
 * no `session_meta.model` and a header-only read would silently move
 * the session onto today's recommendation), then Codex's current
 * recommendation. The rollout step is why an existing S1 keeps the
 * model it has been running across an upgrade. */
function migrateLegacyPin(record: BridgeThreadRecord): CodexSessionPin {
  const wsHash = workspaceHash(record.workspacePath);
  const recommended = codexRecommendedPin();

  const fromRollout =
    record.threadId !== null
      ? (() => {
          const path = findRolloutPath(record.threadId);
          return path !== null ? readRolloutEffectiveModel(path) : null;
        })()
      : null;

  const model =
    readLegacyCodexModelFlag(wsHash) ?? fromRollout ?? recommended.model;

  // The model's own default, not the recommended model's default: a
  // session recovered onto 5.4-mini must not inherit 5.6-sol's `low`.
  const effort =
    readLegacyCodexEffortFlag(wsHash) ?? defaultEffortForModel(model);

  return { model, effort };
}

/** The pin for this workspace's session.
 *
 * Never throws, always answers. Migrates a pre-field record in place on
 * first read so the retired flags are consulted exactly once and the
 * record becomes self-describing.
 *
 * A workspace with no record, or one whose session was reset, reports
 * Codex's recommendation. That is not a lie: it is precisely what the
 * next `thread/start` will use, so the picker shows the truth before
 * the session exists. */
export function readSessionPin(workspacePath: string): CodexSessionPin {
  const record = loadBridgeThreadRecordIfExists(workspacePath);
  if (record === null) return codexRecommendedPin();

  if (typeof record.model === "string" && record.model.length > 0) {
    const stored = record.effort;
    // A stored effort that is null or unrecognized falls back to the
    // pinned model's own advertised default, because Codex reads a null
    // effort on `turn/start` as "inherit" and what it inherits is
    // `config.toml`'s `model_reasoning_effort` - the very file this
    // design exists to stop consulting.
    //
    // That fallback can itself be null, when NO source knows the pinned
    // model: no catalog because the app-server has not answered, and no
    // cache-file entry either. Then null is the honest answer and we let
    // Codex inherit. Inventing a level we cannot confirm the model
    // accepts would turn a silent inherit into a hard turn error, and by
    // definition we cannot tell which levels it advertises.
    const effort =
      typeof stored === "string" && isCodexEffortLevel(stored)
        ? stored
        : defaultEffortForModel(record.model);
    return { model: record.model, effort };
  }

  // A resolved pin that is null was CLEARED on purpose (reset, delete,
  // Reset WAT321). Migrating here would walk the still-live thread's
  // rollout and restore the model the user just cleared.
  if (record.pinResolved === true) return codexRecommendedPin();

  // Only a live thread has anything to recover. A null threadId means
  // no session exists yet, so there is nothing to migrate and the next
  // spawn materializes the recommendation.
  if (record.threadId === null) return codexRecommendedPin();

  const cached = migrationCache.get(record.threadId);
  if (cached !== undefined) return cached;

  const migrated = migrateLegacyPin(record);
  migrationCache.set(record.threadId, migrated);
  const persisted = saveBridgeThreadRecord({
    ...record,
    model: migrated.model,
    effort: migrated.effort,
    pinResolved: true,
  });
  // Sweep the legacy flags ONLY once the record is safely on disk. They
  // are the sole other copy of the user's choice, so deleting them after
  // a failed write would lose it outright. A skipped sweep just means we
  // migrate again next window, which is idempotent.
  if (persisted) clearLegacyCodexPinFlags(workspaceHash(record.workspacePath));
  return migrated;
}

/** True when the model advertises this exact effort level.
 *
 * False when the model is unknown to every source. That is the cautious
 * direction: an unverifiable pairing falls back to the model's own
 * default rather than betting the user's next turn on it. */
function modelSupportsEffort(slug: string, effort: CodexEffortLevel): boolean {
  const info = getCodexModelInfo(slug);
  if (info === null) return false;
  return info.supportedEfforts.some((level) => level.effort === effort);
}

/** Pin a model onto this workspace's session.
 *
 * The current effort is CARRIED OVER when the incoming model advertises
 * it, and reset to that model's own default when it does not. Effort
 * levels are model-scoped: `xhigh` is legal on both 5.5 and 5.6 Sol, so
 * a user switching between them keeps the depth they chose. But `ultra`
 * exists on 5.6 Sol and not on 5.6 Luna, and carrying it across would
 * produce a pairing Codex rejects mid-turn.
 *
 * The speed tier follows the same rule: kept when the incoming model
 * offers it, dropped to standard when it does not.
 *
 * Writing before any session exists is legal and useful: the record is
 * created with a null `threadId`, and `spawnFreshThread` honors the pin
 * instead of overwriting it. */
export function writeSessionModel(workspacePath: string, slug: string): void {
  const record = loadBridgeThreadRecord(workspacePath);
  const current = record.effort;
  const keepCurrent =
    typeof current === "string" &&
    isCodexEffortLevel(current) &&
    modelSupportsEffort(slug, current);
  const tier = record.serviceTier ?? null;
  const keepTier = tier !== null && codexModelOffersServiceTier(slug, tier);
  saveBridgeThreadRecord({
    ...record,
    model: slug,
    effort: keepCurrent ? current : defaultEffortForModel(slug),
    serviceTier: keepTier ? tier : null,
    pinResolved: true,
  });
}

/** Pin an effort onto this workspace's session, leaving the model
 * alone. A null clears it back to "inherit". */
export function writeSessionEffort(
  workspacePath: string,
  level: CodexEffortLevel | null
): void {
  const record = loadBridgeThreadRecord(workspacePath);
  saveBridgeThreadRecord({ ...record, effort: level, pinResolved: true });
}

/** True when this session runs exactly what Codex recommends. Drives the
 * `*default*` tag, so it compares against Codex's answer and never
 * against a value of ours. */
export function pinMatchesCodexDefault(pin: CodexSessionPin): boolean {
  const recommended = codexRecommendedPin();
  if (recommended.model === null) return false;
  return pin.model === recommended.model && pin.effort === recommended.effort;
}
