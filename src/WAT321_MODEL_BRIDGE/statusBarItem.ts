import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import { CONFIG_PATH, HEARTBEAT_PATH, LAST_USED_PATH, USAGE_PATH } from "./constants";
import type { ModelBridgeLogger } from "./outputChannel";
import { showModelBridgeMenu, showModelBridgeSessions } from "./statusBarMenu";

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

/** Read the unified bridge's last-used sidecar. Returns the recorded
 * instance id when a successful dispatch has happened this session;
 * `null` otherwise. Best-effort - missing or malformed files fall
 * through silently and the widget reverts to the user's
 * activeInstanceId preference. */
function readLastUsedInstanceId(): string | null {
  try {
    if (!existsSync(LAST_USED_PATH)) return null;
    const raw = readFileSync(LAST_USED_PATH, "utf8");
    const parsed = JSON.parse(raw) as { instanceId?: unknown };
    return typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
      ? parsed.instanceId
      : null;
  } catch {
    return null;
  }
}

function activeInstanceFrom(snap: ConfigSnapshot): ConfigSnapshot["instances"][number] | null {
  // Last-used takes priority over activeInstanceId for DISPLAY so
  // the widget reflects the most recent dispatch (e.g. user just
  // ran Big Pickle, widget shows Big Pickle even if their default
  // routing is local-llm). Routing decisions still consult
  // activeInstanceId - this only affects what label/stats render.
  const lastUsedId = readLastUsedInstanceId();
  if (lastUsedId) {
    const lastUsed = snap.instances.find((i) => i.id === lastUsedId);
    if (lastUsed) return lastUsed;
  }
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
  md.appendMarkdown(`*Click for menu (Active Instance, Phased Protocol, Manage OpenCode Sessions, ...).*`);
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
  item.hide();

  // Tooltip-only widget. All session/instance management lives on
  // the Epic Handshake dropdown (Manage OpenCode Sessions / Manage
  // Local LLM Sessions). The legacy click-menu stays
  // registered as a command-palette entry only ('WAT321: Model
  // Bridge - Menu (legacy)') for the rare user who wants the old
  // shape; the widget itself never sets `item.command`.
  const legacyMenuCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.legacyMenu",
    async () => {
      await showModelBridgeMenu(context, logger);
    }
  );
  // Cross-tier hook: Epic Handshake dispatches to this command from
  // its "Manage OpenCode Sessions" row so users can reach bridge
  // session management without leaving the EH dropdown.
  const sessionsCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.manageSessions",
    async () => {
      await showModelBridgeSessions();
    }
  );
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
    // Idle icon: llama for Local LLM, opencode square for remote
    // (Big Pickle / Zen / etc.). Widget is tooltip-only across all
    // backends - all session/instance management routes through the
    // Epic Handshake dropdown.
    const isLocal = active.kind === "local";
    const idleIcon = isLocal ? "$(wat321-llama)" : "$(wat321-opencode)";
    const usage = readUsageSnapshot();
    const usageSig = usage
      ? Object.entries(usage.instances)
          .map(([id, u]) => `${id}:${u.input}:${u.output}:${u.calls}`)
          .join("|")
      : "";

    // Cumulative session tokens for the active instance. Surfaced
    // inline in the idle label so the user sees "what has this
    // instance cost me" at a glance, parallel to how Claude / Codex
    // session-token widgets show their running totals. Carries across
    // resume because usage.json accumulates per-instance lifetime
    // counts; reset via the click-menu's Reset Session Totals row.
    const activeUsage = usage?.instances[active.id];
    const activeTotalTokens =
      typeof activeUsage?.input === "number" && typeof activeUsage?.output === "number"
        ? activeUsage.input + activeUsage.output
        : 0;
    const activeTokensSuffix =
      activeTotalTokens > 0 ? ` ${formatTokens(activeTotalTokens)}` : "";

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
        text = `${idleIcon} ${idleAlias}${activeTokensSuffix}`;
        tooltipSig = `idle:${idleAlias}:${needsKey}:${usageSig}`;
        tooltip = buildIdleTooltip(idleAlias, retention, needsKey, snap, usage);
      } else {
        const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
        // Active "thinking" frames mirror the Claude/Codex session-
        // tokens widgets: $(comment) <-> $(comment-discussion-quote)
        // alternating at 1Hz. Same cadence + same glyphs across all
        // four backends so the user reads "in progress" consistently
        // regardless of which provider is currently active.
        const oneHz = Math.floor(Date.now() / 1000) % 2 === 0;
        const icon = oneHz ? "$(comment)" : "$(comment-discussion-quote)";
        const alias = heartbeat.alias || idleAlias;
        const tokens = typeof heartbeat.tokens === "number" ? heartbeat.tokens : 0;
        const rate =
          typeof heartbeat.tokensPerSec === "number" ? heartbeat.tokensPerSec : 0;
        const stat = tokens > 0 ? `${tokens}t @ ${rate}/s` : `${elapsedSec}s`;
        // Phase tags (DISPATCH/RECEIPT/STARTED/HALFWAY/COMPLETING/TASK)
        // are intentionally omitted from the widget text - users only
        // want tokens + tps at a glance. The full phase trace remains
        // available in the tooltip for diagnostics.
        text = `${icon} ${alias} ${stat}`;
        tooltipSig = `live:${heartbeat.currentPhase || "DISPATCH"}:${(heartbeat.phaseTrace || []).length}:${usageSig}`;
        tooltip = buildLiveTooltip(heartbeat, idleAlias, heartbeat.dataRetention ?? retention, snap, usage);
      }
    } else {
      const badge = needsKey ? " $(wat321-square-alert)" : "";
      text = `${idleIcon} ${idleAlias}${activeTokensSuffix}${badge}`;
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

  context.subscriptions.push(
    legacyMenuCommand,
    sessionsCommand,
    showCommand,
    item
  );

  return {
    dispose: (): void => {
      clearInterval(timer);
      item.dispose();
    },
  };
}
