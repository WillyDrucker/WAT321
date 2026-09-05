import type { CodexEffortLevel } from "../../engine/bridgeTypes";
import {
  defaultCodexModelSlug,
  getCodexModelInfo,
  isUnlistedCodexModel,
  type CodexModelInfo,
} from "../../shared/providers/codex/models";
import { workspaceHash } from "../../engine/workspaceHash";
import {
  readCodexSandboxOverride,
  type CodexSandboxState,
} from "./codexRuntimeOverrides";
import {
  defaultEffortForModel,
  pinMatchesCodexDefault,
  readSessionPin,
} from "./codexSessionSettings";
import { currentWorkspacePath } from "../statusBar/statusBarState";

/**
 * Baseline + label helpers for the Codex Model Settings picker.
 *
 * "Baseline" is what CODEX recommends: `model/list`'s `isDefault` model,
 * that model's own `defaultReasoningEffort`, and a read-only sandbox.
 * The `*default*` tag marks rows matching it. Nothing here defines a
 * default of WAT321's own, and `~/.codex/config.toml` is not read.
 *
 * The sandbox override is workspace-scoped, so `currentWsHash`
 * partitions its reads and two windows on different projects stay
 * isolated. Model and effort are session-scoped and come from
 * `codexSessionSettings`.
 */

/** Sentinel path for a window with no folder open. Keeps a
 * workspace-less window from colliding with a real project's state,
 * while still giving the session record and the sandbox flag one
 * stable key to agree on. */
const NO_WORKSPACE = "no-workspace";

/** Current workspace path, or the sentinel. */
export function currentWorkspacePathOrSentinel(): string {
  return currentWorkspacePath() ?? NO_WORKSPACE;
}

/** Hash of the current workspace path for flag-file partitioning.
 * Falls back to a sentinel hash when no workspace is open so the
 * flags still partition away from real workspaces. */
export function currentWsHash(): string {
  return workspaceHash(currentWorkspacePathOrSentinel());
}

export function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Trim a row description so it survives narrow QuickPick columns
 * without truncation. Splits on the first sentence boundary, falling
 * back to a hard 60-char ceiling. */
export function shortenForRow(description: string): string {
  if (!description) return "";
  const trimmed = description.trim();
  const firstSentence = trimmed.split(/\.\s/)[0]?.replace(/\.$/, "") ?? trimmed;
  const candidate = firstSentence.length > 0 ? firstSentence : trimmed;
  return candidate.length <= 60 ? candidate : `${candidate.slice(0, 57)}...`;
}

export function modelRowLabel(model: string | null): string {
  const baseline = baselineModel();
  const effective = model ?? baseline;
  if (effective === null) {
    return "MODEL: (codex config has no model set)";
  }
  const info = getCodexModelInfo(effective);
  const label = (info?.displayName ?? effective).toUpperCase();
  const isDefault = effective === baseline;
  const warn = retirementNote(info) !== null ? "⚠ " : "";
  const unlisted = isUnlistedCodexModel(effective) ? " (unlisted)" : "";
  return `MODEL: ${warn}${label}${unlisted}${isDefault ? " *default*" : ""}`;
}

/** Row description for the model line. Leads with the retirement notice
 * when there is one, so the user learns Codex is moving on before they
 * open the sub-picker. */
export function modelRowDescription(model: string | null): string {
  const effective = model ?? baselineModel();
  const note =
    effective === null ? null : retirementNote(getCodexModelInfo(effective));
  return note === null ? "Click to change model." : `${note}. Click to change model.`;
}

/** "Retiring, Codex recommends GPT-5.6-Terra" for a model OpenAI has
 * put a successor on, null otherwise. Reads "Retired" once the date
 * Codex published has passed, even though Codex may keep listing the
 * model for a while. The successor is named by display name when a
 * source knows it and by slug otherwise. */
export function retirementNote(info: CodexModelInfo | null): string | null {
  const upgrade = info?.upgrade ?? null;
  if (upgrade === null) return null;
  const past =
    upgrade.retirementAtMs !== null && upgrade.retirementAtMs <= Date.now();
  const successor =
    getCodexModelInfo(upgrade.model)?.displayName ?? upgrade.model;
  return `${past ? "Retired" : "Retiring"}, Codex recommends ${successor}`;
}

export function effortRowLabel(effort: CodexEffortLevel | null): string {
  const baseline = baselineEffort();
  const effective = effort ?? baseline;
  if (effective === null) {
    return "EFFORT: (no default available)";
  }
  const isDefault = effective === baseline;
  return `EFFORT: ${effective.toUpperCase()}${isDefault ? " *default*" : ""}`;
}

export function sandboxIsDefault(state: CodexSandboxState): boolean {
  return state === "read-only";
}

/** The model Codex recommends for a brand-new session.
 *
 * This is what `*default*` means in the picker: Codex's answer, not
 * ours and not this machine's. It comes from `model/list`'s `isDefault`
 * flag, read live, so it tracks the installed binary rather than a
 * constant we would have to chase. Today `gpt-5.6-sol`.
 *
 * `~/.codex/config.toml` is deliberately NOT consulted. It is a machine-
 * wide CLI preference that Codex's own TUI writes when a user picks a
 * model there, and letting it define `*default*` meant a fresh WAT321
 * install behaved differently on two machines for reasons our UI never
 * showed. Null when no catalog has answered, and the picker then has no
 * `*default*` to mark. */
export function baselineModel(): string | null {
  return defaultCodexModelSlug();
}

/** The effort that goes with the recommended model, per Codex.
 *
 * Scoped to the SESSION's model, not the recommended one, so the tag in
 * the effort picker marks the default of the model actually selected.
 * A session on 5.4-mini sees 5.4-mini's default tagged, never 5.6-sol's.
 * Null when nothing can answer, which the row renders as "no default
 * available" rather than inventing `medium`. */
export function baselineEffort(): CodexEffortLevel | null {
  const model = readSessionPin(currentWorkspacePathOrSentinel()).model;
  return defaultEffortForModel(model ?? baselineModel());
}

export function everythingAtDefault(): boolean {
  const sandbox = readCodexSandboxOverride(currentWsHash());
  if (!sandboxIsDefault(sandbox)) return false;
  return pinMatchesCodexDefault(readSessionPin(currentWorkspacePathOrSentinel()));
}
