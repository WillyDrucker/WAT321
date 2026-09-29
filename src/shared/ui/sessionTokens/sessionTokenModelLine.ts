import type * as vscode from "vscode";
import type { CodexEffortOverride } from "../../../engine/bridgeTypes";
import { formatModelDisplayName } from "../../../engine/contracts";
import {
  getCodexModelInfo,
  isKnownCodexModel,
  isUnlistedCodexModel,
} from "../../providers/codex/models";
import { formatTokens } from "../tokenFormatters";
import type { ClaudeTurnInfo } from "./sessionTokenWidget";

/**
 * The model line of the session token tooltip and the advisory lines
 * under it: the friendly model name with its effort tag and context
 * window, then for Codex a warning badge when the stored slug is not
 * one the running app-server lists, a retirement nudge naming the
 * successor, or a note that Codex hides the model from its own picker.
 */

interface ModelLineInput {
  provider: "Claude" | "Codex";
  modelId: string;
  contextWindowSize?: number;
  effort: string | null;
  codexEffort?: CodexEffortOverride;
  claudeTurnInfo?: ClaudeTurnInfo;
}

export function appendModelLines(md: vscode.MarkdownString, input: ModelLineInput): void {
  const { provider, modelId, contextWindowSize, effort, codexEffort, claudeTurnInfo } = input;
  const modelName = formatModelDisplayName(modelId);
  const windowLabel = contextWindowSize
    ? ` (${formatTokens(contextWindowSize)} context)`
    : "";
  // Codex-only: flag a stored model slug the running app-server does
  // not advertise (from its `model/list` catalog, falling back to
  // `~/.codex/models_cache.json` before the bridge has answered).
  // Every `thread/resume` ships the stored slug to the API, so an
  // unknown slug guarantees a 404 on the next prompt. Prefixing a
  // warning badge lets the user spot config drift before dispatching.
  // Claude model IDs aren't validated this way - Claude's slugs come
  // from WAT321's own MODEL_CONTEXT_WINDOWS table, not a user cache.
  const codexModelInvalid = provider === "Codex" && !isKnownCodexModel(modelId);
  const prefix = codexModelInvalid ? "⚠ " : "";
  const effortLabel = resolveEffortLabel(provider, modelId, effort, codexEffort, claudeTurnInfo);
  const effortSegment = effortLabel ? ` · ${effortLabel}` : "";
  md.appendMarkdown(`${prefix}Model: ${modelName}${effortSegment}${windowLabel}  \n`);
  if (codexModelInvalid) {
    md.appendMarkdown(
      `_Model not in your installed Codex's known set. The next prompt will fail - repair via the bridge menu._  \n`
    );
  }
  if (provider !== "Codex" || codexModelInvalid) return;
  // A model OpenAI is retiring still runs today, so this is a nudge
  // rather than a badge. Names the successor Codex points at.
  const codexUpgrade = getCodexModelInfo(modelId)?.upgrade ?? null;
  if (codexUpgrade !== null) {
    const successor =
      getCodexModelInfo(codexUpgrade.model)?.displayName ?? codexUpgrade.model;
    md.appendMarkdown(
      `_Codex is retiring this model and recommends ${successor}._  \n`
    );
  }
  // A model Codex keeps out of its own picker, or one the user pinned
  // by slug. Known to the bridge, so no badge, but worth a line since
  // Codex's own picker will not show it.
  if (isUnlistedCodexModel(modelId)) {
    md.appendMarkdown(`_Codex keeps this model out of its own picker._  \n`);
  }
}

/** Effort label that goes after the model name, dot-separated between
 * the model and the context window.
 *
 * Both providers record the effort each turn ran at in the session
 * file itself, and that recorded level always wins: it describes THIS
 * session, where every other source describes a setting.
 *
 * Codex before its first turn: the bridge session's pinned effort, then
 * the model's own default from the catalog, so the user sees what
 * Codex will actually run.
 *
 * Claude with no recorded effort (a model without effort levels, an
 * older Claude Code): "Thinking" when the recent turns emitted
 * `thinking` blocks, since on/off is the only signal left.
 *
 * Returns null when there is nothing useful to display. */
function resolveEffortLabel(
  provider: "Claude" | "Codex",
  modelId: string,
  effort: string | null,
  codexEffort: CodexEffortOverride | undefined,
  claudeTurnInfo: ClaudeTurnInfo | undefined
): string | null {
  const effective =
    effort ??
    (provider === "Codex"
      ? codexEffort ?? getCodexModelInfo(modelId)?.defaultEffort ?? null
      : null);
  if (effective !== null) {
    return effective.charAt(0).toUpperCase() + effective.slice(1);
  }
  if (provider === "Claude" && claudeTurnInfo?.hasThinkingRecent === true) {
    return "Thinking";
  }
  return null;
}
