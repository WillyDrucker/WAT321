import {
  getCodexModelInfo,
  readCodexConfigModel,
} from "../shared/providers/codex/models";
import { workspaceHash } from "../shared/workspaceHash";
import {
  readCodexEffortOverride,
  readCodexModelOverride,
  readCodexSandboxOverride,
  type CodexEffortLevel,
  type CodexSandboxState,
} from "./codexRuntimeOverrides";
import { currentWorkspacePath } from "./statusBarState";

/**
 * Baseline + label helpers for the Codex Model Settings picker. The
 * three override flag files are workspace-scoped; `currentWsHash`
 * partitions reads so two VS Code windows on different projects
 * stay isolated. "Baseline" is the codex config.toml default for
 * model + model's own default-effort + read-only sandbox - the
 * `*default*` tag marks values that match it.
 */

/** Hash of the current workspace path for flag-file partitioning.
 * Falls back to a sentinel hash when no workspace is open so the
 * flags still partition away from real workspaces. */
export function currentWsHash(): string {
  const ws = currentWorkspacePath();
  return workspaceHash(ws ?? "no-workspace");
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
  return `MODEL: ${label}${isDefault ? " *default*" : ""}`;
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

export function configModelLabel(): string {
  const cfg = readCodexConfigModel();
  if (cfg === null) return "default";
  const info = getCodexModelInfo(cfg);
  return info?.displayName ?? cfg;
}

export function sandboxIsDefault(state: CodexSandboxState): boolean {
  return state === "read-only";
}

/** Whatever Codex's own config.toml declares. If config has no model
 * line, the picker has no `*default*` to mark. Picking the same slug
 * as the baseline is functionally identical to having no override. */
export function baselineModel(): string | null {
  return readCodexConfigModel();
}

/** Model's own default effort from the cache; falls back to
 * `"medium"` when no model context applies. */
export function baselineEffort(): CodexEffortLevel | null {
  const model = readCodexModelOverride(currentWsHash()) ?? baselineModel();
  if (model === null) return "medium";
  const info = getCodexModelInfo(model);
  const cand = info?.defaultEffort;
  if (cand === "low" || cand === "medium" || cand === "high" || cand === "xhigh") {
    return cand;
  }
  return "medium";
}

export function everythingAtDefault(): boolean {
  const wsHash = currentWsHash();
  const sandbox = readCodexSandboxOverride(wsHash);
  const modelOverride = readCodexModelOverride(wsHash);
  const effortOverride = readCodexEffortOverride(wsHash);
  if (!sandboxIsDefault(sandbox)) return false;
  // No override = "use the baseline" = default.
  if (modelOverride !== null && modelOverride !== baselineModel()) return false;
  if (effortOverride !== null && effortOverride !== baselineEffort()) return false;
  return true;
}
