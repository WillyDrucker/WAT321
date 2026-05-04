import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import { CONFIG_PATH, HEARTBEAT_PATH, USAGE_PATH } from "./constants";
import type { ModelBridgeLogger } from "./outputChannel";
import { showModelBridgeMenu } from "./statusBarMenu";

/**
 * Model Bridge status bar widget. Renders to the right of the Codex
 * Session Tokens slot. States:
 *
 *   hidden    - bridge disabled or no enabled instances
 *   idle      - `$(wat321-square) {alias}` + last-turn tooltip
 *   in-flight - `$(wat321-square-info) {alias} {phase} {rate}` with
 *               phase-trace tooltip; pulses square <-> square-info at
 *               1 Hz
 *   stale     - heartbeat older than 1.5x timeout, falls back to idle
 *
 * Heartbeat at `~/.wat321/model-bridge/heartbeat.json` is the single
 * source of truth for live state. Active instance + retention come
 * from `~/.wat321/model-bridge/config.json` (written by the
 * extension's settings + secrets watchers). Both reads are cheap
 * synchronous JSON parses, so the 1Hz refresh loop stays in the main
 * event tick.
 *
 * Tooltip is updated only on phase-signature changes (not every tick)
 * because VS Code reshows the hover overlay on every `tooltip`
 * reassignment - flicker on phase transitions is acceptable, flicker
 * on every-second token counts is not.
 */

const COMMAND_ID = "wat321.modelBridge.menu";
const REFRESH_INTERVAL_MS = 1000;
const STALE_HEARTBEAT_MULTIPLIER = 1.5;

interface PhaseEntry {
  phase: string;
  elapsedMs: number;
  summary?: string;
}

interface Heartbeat {
  phase: "calling";
  requestId?: string;
  startedAt: string;
  alias: string;
  instanceId?: string;
  dataRetention?: "local" | "retained";
  model: string;
  timeoutMs: number;
  tokens?: number;
  tokensPerSec?: number;
  currentPhase?: string;
  phaseTrace?: PhaseEntry[];
}

interface ConfigSnapshot {
  enabled: boolean;
  activeInstanceId: string;
  instances: Array<{
    id: string;
    alias: string;
    kind: "local" | "remote";
    dataRetention: "local" | "retained";
    apiKeyMissing?: boolean;
    model?: string;
  }>;
}

function readHeartbeat(): Heartbeat | null {
  if (!existsSync(HEARTBEAT_PATH)) return null;
  try {
    const raw = readFileSync(HEARTBEAT_PATH, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Heartbeat;
    if (typeof parsed?.startedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readConfigSnapshot(): ConfigSnapshot | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigSnapshot>;
    // Defensive defaults for legacy config.json files written by an
    // older WAT321_MODEL_BRIDGE shape (pre-multi-instance). Without
    // this, reading a stale flat-config file throws on the first
    // refresh tick and aborts the extension's activate flow.
    return {
      enabled: parsed.enabled === true,
      activeInstanceId:
        typeof parsed.activeInstanceId === "string" ? parsed.activeInstanceId : "",
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    };
  } catch {
    return null;
  }
}

interface UsageSnapshot {
  sinceMs: number;
  instances: Record<string, { input: number; output: number; calls: number; lastTs?: string }>;
}

function readUsageSnapshot(): UsageSnapshot | null {
  if (!existsSync(USAGE_PATH)) return null;
  try {
    const raw = readFileSync(USAGE_PATH, "utf8");
    return JSON.parse(raw) as UsageSnapshot;
  } catch {
    return null;
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function appendUsageBlock(
  md: vscode.MarkdownString,
  snap: ConfigSnapshot,
  usage: UsageSnapshot | null
): void {
  if (!usage) return;
  const entries = Object.entries(usage.instances);
  if (entries.length === 0) return;
  const aliasFor = (id: string): string =>
    snap.instances.find((i) => i.id === id)?.alias ?? id;
  md.appendMarkdown(`**Session usage** (since ${formatDuration(Date.now() - usage.sinceMs)})\n\n`);
  for (const [id, u] of entries) {
    md.appendMarkdown(
      `- ${aliasFor(id)}: ${formatTokens(u.input)} in / ${formatTokens(u.output)} out · ${u.calls} call${u.calls === 1 ? "" : "s"}\n`
    );
  }
  md.appendMarkdown(`\n`);
}

function activeInstanceFrom(snap: ConfigSnapshot): ConfigSnapshot["instances"][number] | null {
  const found = snap.instances.find((i) => i.id === snap.activeInstanceId);
  if (found) return found;
  return snap.instances[0] ?? null;
}

function retentionPhrase(retention?: "local" | "retained"): string {
  if (retention === "retained") return "may be logged or used to train upstream";
  return "stays on your network";
}

function buildLiveTooltip(
  hb: Heartbeat,
  idleAlias: string,
  retention: "local" | "retained" | undefined,
  snap: ConfigSnapshot,
  usage: UsageSnapshot | null
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  const alias = hb.alias || idleAlias;
  md.appendMarkdown(`**${alias}** - calling\n\n`);
  if (retention) md.appendMarkdown(`Retention: ${retentionPhrase(retention)}\n\n`);
  if (hb.model) md.appendMarkdown(`Model: \`${hb.model}\`\n\n`);
  const phaseTrace = hb.phaseTrace || [];
  if (phaseTrace.length > 0) {
    md.appendMarkdown(`**Phase trace**\n\n`);
    for (const p of phaseTrace) {
      const elapsed = `${(p.elapsedMs / 1000).toFixed(1)}s`;
      const summary = p.summary ? ` - *${p.summary.replace(/\*/g, "")}*` : "";
      md.appendMarkdown(`- \`${p.phase.padEnd(11)}\` ${elapsed}${summary}\n`);
    }
    md.appendMarkdown(`\n`);
  }
  if (typeof hb.tokens === "number" && hb.tokens > 0) {
    md.appendMarkdown(
      `Generation: ${hb.tokens} tokens at ${hb.tokensPerSec ?? 0} tok/s\n\n`
    );
  }
  appendUsageBlock(md, snap, usage);
  md.appendMarkdown(`*Click for menu (Active Instance, Test Connection, Manage Threads, ...).*`);
  return md;
}

function buildIdleTooltip(
  idleAlias: string,
  retention: "local" | "retained" | undefined,
  needsKey: boolean,
  snap: ConfigSnapshot,
  usage: UsageSnapshot | null
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${idleAlias}** - idle\n\n`);
  if (needsKey) {
    md.appendMarkdown(`Needs API key. Click for menu -> OpenCode Zen API Key.\n\n`);
  }
  if (retention) md.appendMarkdown(`Retention: ${retentionPhrase(retention)}\n\n`);
  appendUsageBlock(md, snap, usage);
  md.appendMarkdown(`Click for menu (Active Instance, Test Connection, Manage Threads, ...).`);
  return md;
}

export function createModelBridgeStatusBarItem(
  context: vscode.ExtensionContext,
  logger: ModelBridgeLogger
): { dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    "wat321.modelBridge",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.modelBridge)
  );
  item.name = "Model Bridge";
  item.command = COMMAND_ID;
  item.hide();

  const menuCommand = vscode.commands.registerCommand(COMMAND_ID, async () => {
    await showModelBridgeMenu(context, logger);
  });
  // Keep the legacy `wat321.modelBridge.show` so settings descriptions
  // and external integrations that still reference it keep working.
  const showCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.show",
    () => logger.show()
  );

  let lastText: string | undefined;
  let lastTooltipSig: string | undefined;

  function refresh(): void {
    const snap = readConfigSnapshot();
    if (!snap?.enabled || snap.instances.length === 0) {
      if (lastText !== undefined) {
        item.hide();
        lastText = undefined;
        lastTooltipSig = undefined;
      }
      return;
    }
    const active = activeInstanceFrom(snap);
    if (!active) {
      if (lastText !== undefined) {
        item.hide();
        lastText = undefined;
        lastTooltipSig = undefined;
      }
      return;
    }

    const idleAlias = active.alias || active.id || "Model Bridge";
    const retention = active.dataRetention;
    const needsKey = active.apiKeyMissing === true;
    const usage = readUsageSnapshot();
    const usageSig = usage
      ? Object.entries(usage.instances)
          .map(([id, u]) => `${id}:${u.input}:${u.output}:${u.calls}`)
          .join("|")
      : "";

    const heartbeat = readHeartbeat();
    let text: string;
    let tooltipSig: string;
    let tooltip: vscode.MarkdownString;
    if (heartbeat) {
      const startedMs = new Date(heartbeat.startedAt).getTime();
      const elapsedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
      const stale =
        Number.isFinite(startedMs) &&
        elapsedMs > heartbeat.timeoutMs * STALE_HEARTBEAT_MULTIPLIER;
      if (stale) {
        text = `$(wat321-square) ${idleAlias}`;
        tooltipSig = `idle:${idleAlias}:${needsKey}:${usageSig}`;
        tooltip = buildIdleTooltip(idleAlias, retention, needsKey, snap, usage);
      } else {
        const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
        const oneHz = Math.floor(Date.now() / 1000) % 2 === 0;
        const icon = oneHz ? "$(wat321-square-info)" : "$(wat321-square)";
        const alias = heartbeat.alias || idleAlias;
        const tokens = typeof heartbeat.tokens === "number" ? heartbeat.tokens : 0;
        const rate =
          typeof heartbeat.tokensPerSec === "number" ? heartbeat.tokensPerSec : 0;
        const stat = tokens > 0 ? `${tokens}t @ ${rate}/s` : `${elapsedSec}s`;
        const phaseTag =
          heartbeat.currentPhase && heartbeat.currentPhase !== "DISPATCH"
            ? ` ${heartbeat.currentPhase}`
            : "";
        text = `${icon} ${alias}${phaseTag} ${stat}`;
        tooltipSig = `live:${heartbeat.currentPhase || "DISPATCH"}:${(heartbeat.phaseTrace || []).length}:${usageSig}`;
        tooltip = buildLiveTooltip(heartbeat, idleAlias, heartbeat.dataRetention ?? retention, snap, usage);
      }
    } else {
      const badge = needsKey ? " $(wat321-square-alert)" : "";
      text = `$(wat321-square) ${idleAlias}${badge}`;
      tooltipSig = `idle:${idleAlias}:${needsKey}:${usageSig}`;
      tooltip = buildIdleTooltip(idleAlias, retention, needsKey, snap, usage);
    }

    if (text !== lastText) {
      item.text = text;
      lastText = text;
    }
    if (tooltipSig !== lastTooltipSig) {
      item.tooltip = tooltip;
      lastTooltipSig = tooltipSig;
    }
    item.show();
  }

  refresh();
  const timer = setInterval(refresh, REFRESH_INTERVAL_MS);

  context.subscriptions.push(menuCommand, showCommand, item);

  return {
    dispose: (): void => {
      clearInterval(timer);
      item.dispose();
    },
  };
}
