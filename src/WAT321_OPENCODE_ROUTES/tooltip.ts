import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { bridgeStateDir } from "../shared/wat321Paths";
import { formatPct, formatTokens, makeTokenBar } from "../shared/ui/tokenFormatters";
import { wrapAndTruncateTitle } from "../shared/ui/sessionTokens/sessionTokenTooltip";
import type { BridgeSessionTokens } from "./sessionTokensPoller";
import type { Heartbeat } from "./statusBarItem";

/**
 * Tooltip composition for the OpenCode Routes widget. Layout matches
 * the Claude / Codex session-token tooltips: bold provider header,
 * wrapped session title, model line, 📁 used/window block, bar,
 * (optional) in-flight stage line + phase trace + generation line,
 * RETENTION (cloud-routed only), Auto-Compact pinned to the bottom.
 */

const FOLDER_ICON = "\u{1F4C1}";
const CLAMP_ICON = "\u{1F5DC}\u{FE0F}";
const BRIDGE_CONFIG_PATH = join(bridgeStateDir(), "config.json");

/** Bridge config's `projectName` for the wrapped session title and the
 * 📁-line label. "Workspace" fallback when the bridge config is
 * absent (Epic Handshake never activated) or unreadable. */
function readBridgeProjectName(): string {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const parsed = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8")) as {
      projectName?: unknown;
    };
    if (typeof parsed.projectName === "string" && parsed.projectName.trim().length > 0) {
      return parsed.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Provider header label that matches the Claude / Codex tooltip
 * vocabulary. Big Pickle and GPT 5 Nano both render "OpenCode session
 * token context" so users see one consistent header per service
 * regardless of which specific Zen route is active. */
function providerHeaderLabel(target: "opencode" | "local" | null): string {
  if (target === "local") return "Local LLM";
  return "OpenCode";
}

/** Canonical session display name the EH menus use:
 * `${projectName} Epic Handshake Claude-to-${OpenCode|Local} S${n}`.
 * Returns null when no alias is bound so the title line skips
 * entirely instead of rendering an awkward partial name. */
function composeSessionTitle(
  target: "opencode" | "local" | null,
  alias: string | null
): string | null {
  if (!target || !alias) return null;
  const projectName = readBridgeProjectName();
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${projectName} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

/** Map heartbeat `currentPhase` to the 5-stage display vocabulary the
 * Claude / Codex tooltips use. Best-effort: phases that don't map
 * cleanly fall through to null and the stage line is suppressed. */
function mapPhaseToStage(currentPhase: string | undefined): {
  fraction: string;
  label: string;
} | null {
  switch ((currentPhase || "").toUpperCase()) {
    case "DISPATCH":
      return { fraction: "1/5", label: "dispatched" };
    case "RECEIPT":
      return { fraction: "2/5", label: "received" };
    case "STARTED":
    case "HALFWAY":
      return { fraction: "3/5", label: "working" };
    case "COMPLETING":
      return { fraction: "4/5", label: "writing" };
    case "TASK":
      return { fraction: "5/5", label: "complete" };
    default:
      return null;
  }
}

/** `Model: name (window context)` formatter. Local LLM uses the probed
 * `model_alias` when available; remote uses the catalog alias. Window
 * suffix omitted when unknown. */
function formatModelLine(
  catalogAlias: string,
  contextWindow: number | null,
  localModelDisplayName: string | null
): string {
  const name = localModelDisplayName ?? catalogAlias;
  const windowSuffix =
    contextWindow !== null && contextWindow > 0
      ? ` (${formatTokens(contextWindow)} context)`
      : "";
  return `Model: ${name}${windowSuffix}`;
}

export function buildOpenCodeRoutesTooltip(opts: {
  hb: Heartbeat | null;
  catalogAlias: string;
  catalogContextWindow: number | null;
  retention: "local" | "retained" | undefined;
  needsKey: boolean;
  sessionTokens: BridgeSessionTokens | null;
  target: "opencode" | "local" | null;
  activeBridgeAlias: string | null;
}): vscode.MarkdownString {
  const {
    hb,
    catalogAlias,
    catalogContextWindow,
    retention,
    needsKey,
    sessionTokens,
    target,
    activeBridgeAlias,
  } = opts;
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;

  // Header: provider service name, not the catalog alias.
  md.appendMarkdown(`**${providerHeaderLabel(target)} session token context**  \n`);

  // Wrapped session title in quotes. Two-line max with ellipsis on
  // overflow. Two trailing spaces + newline = MarkdownString hard
  // line break so wrap-line-2 lands on its own row.
  const fullTitle = composeSessionTitle(target, activeBridgeAlias);
  if (fullTitle) {
    const wrapped = wrapAndTruncateTitle(fullTitle).replace(/\n/g, '"  \n"');
    md.appendMarkdown(`"${wrapped}"  \n`);
  }

  // Window comes from the session-tokens snapshot (probe-authoritative
  // for local) when present, falls back to catalog when the snapshot
  // is missing or zero.
  const window = sessionTokens?.contextWindow ?? catalogContextWindow;
  const modelLine = formatModelLine(
    catalogAlias,
    window,
    sessionTokens?.modelDisplayName ?? null
  );
  md.appendMarkdown(`${modelLine}  \n`);

  // API-key warning sits under the model line so it lands visible
  // before the user scans the rest. Own paragraph - no window-trailing
  // space.
  if (needsKey) {
    md.appendMarkdown(`\n_Needs API key. Click for menu -> OpenCode Zen API Key._\n`);
  }

  // 📁 used / window block + bar. Skipped entirely when no
  // session-tokens snapshot exists yet (pre-first-turn sessions or
  // empty alias).
  if (sessionTokens) {
    const projectName = readBridgeProjectName();
    if (window !== null && window > 0) {
      const pct = Math.min(
        100,
        Math.round((sessionTokens.contextUsed / window) * 100)
      );
      md.appendMarkdown(
        `\n${FOLDER_ICON} ${projectName} ${formatTokens(sessionTokens.contextUsed)} / ${formatTokens(window)}\n\n`
      );
      md.appendMarkdown(`${makeTokenBar(pct)} ${formatPct(pct)} used\n`);
    } else {
      md.appendMarkdown(
        `\n${FOLDER_ICON} ${projectName} ${formatTokens(sessionTokens.contextUsed)}\n`
      );
    }
  }

  // In-flight stage block: stage-line + phase trace + generation line.
  if (hb) {
    const stage = mapPhaseToStage(hb.currentPhase);
    if (stage) {
      md.appendMarkdown(
        `\n${providerHeaderLabel(target)}: ${stage.fraction} ${stage.label}\n`
      );
    }
    const phaseTrace = hb.phaseTrace || [];
    if (phaseTrace.length > 0) {
      md.appendMarkdown(`\n**Phase trace**\n\n`);
      for (const p of phaseTrace) {
        const elapsed = `${(p.elapsedMs / 1000).toFixed(1)}s`;
        const summary = p.summary ? ` - *${p.summary.replace(/\*/g, "")}*` : "";
        md.appendMarkdown(`- \`${p.phase.padEnd(11)}\` ${elapsed}${summary}\n`);
      }
    }
    if (typeof hb.tokens === "number" && hb.tokens > 0) {
      const tpsEnabled = vscode.workspace
        .getConfiguration("wat321")
        .get<boolean>(SETTING.enableTokensPerSecondCounters, false);
      const rateSuffix = tpsEnabled ? ` at ${hb.tokensPerSec ?? 0} tok/s` : "";
      md.appendMarkdown(`\nGeneration: ${hb.tokens} tokens${rateSuffix}\n`);
    }
  }

  // RETENTION above Auto-Compact for cloud-routed instances. Local
  // instances skip - their data does not leave the network.
  if (retention === "retained") {
    md.appendMarkdown(`\nRETENTION: Prompts may be used to train model\n`);
  }

  // Auto-Compact pinned to the bottom of every session-token tooltip.
  // Sanity gate: hide when the derived threshold sits below half the
  // window. The fallback formula (window minus reserved buffer)
  // breaks for small windows and for models whose `maxOutputTokens`
  // differs from OpenCode's `COMPACTION_BUFFER`.
  if (
    sessionTokens &&
    sessionTokens.contextWindow !== null &&
    sessionTokens.contextWindow > 0 &&
    sessionTokens.autoCompactTokens !== null &&
    sessionTokens.autoCompactTokens > sessionTokens.contextWindow * 0.5
  ) {
    md.appendMarkdown(
      `\n${CLAMP_ICON} Auto-Compact at ~${formatTokens(sessionTokens.autoCompactTokens)}\n`
    );
  }
  return md;
}
