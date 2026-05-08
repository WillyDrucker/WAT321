import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../shared/wat321Paths";
import * as vscode from "vscode";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  CONFIG_PATH,
  LAST_USED_PATH,
  MODEL_BRIDGE_DIR,
  USAGE_PATH,
} from "./constants";
import type { OpenCodeRoutesLogger } from "./outputChannel";
import { showOpenCodeRoutesMenu, showOpenCodeRoutesSessions } from "./statusBarMenu";
import { formatPct } from "../shared/ui/tokenFormatters";
import {
  BridgeSessionTokensPoller,
  type BridgeTarget,
} from "./sessionTokensPoller";

/** Read the unified bridge's active alias for the given target. The
 * alias map persists `S1` / `S2` / etc. keyed by target ("opencode" /
 * "local") and tracks which one is currently active per target. The
 * OpenCode Routes widget surfaces this S# so the tooltip reads parallel to the
 * Claude / Codex session-token tooltips. Returns null on missing
 * file / parse error / no active alias. */
const BRIDGE_ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");
function readActiveBridgeAlias(target: "opencode" | "local"): string | null {
  if (!existsSync(BRIDGE_ALIAS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_ALIAS_PATH, "utf8")) as {
      activeAliases?: { opencode?: string | null; local?: string | null };
    };
    const active = parsed.activeAliases?.[target];
    return typeof active === "string" && active.length > 0 ? active : null;
  } catch {
    return null;
  }
}

/** OpenCode Routes heartbeat path. The per-client state dir already
 * partitions per workspace via wsId (or "default" wsId for folderless
 * windows), so the heartbeat file carries no further suffix. */
function heartbeatPath(): string {
  return join(MODEL_BRIDGE_DIR, "heartbeat.json");
}

/**
 * OpenCode Routes status bar widget. Renders to the right of the Codex
 * Session Tokens slot. States:
 *
 *   hidden    - bridge disabled or no enabled instances
 *   idle      - `$(wat321-square) {alias}` + last-turn tooltip
 *   in-flight - `$(wat321-square-info) {alias} {phase} {rate}` with
 *               phase-trace tooltip; pulses square <-> square-info at
 *               1 Hz
 *   stale     - heartbeat older than 1.5x timeout, falls back to idle
 *
 * Heartbeat at `clients/<wsId>/model-bridge/heartbeat.json` is the
 * single source of truth for live state. Active instance + retention
 * come from the same dir's `config.json` (written by the extension's
 * settings + secrets watchers). Both reads are cheap
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

export interface PhaseEntry {
  phase: string;
  elapsedMs: number;
  summary?: string;
}

export interface Heartbeat {
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
  /** Managed OpenCode subprocess URL. Empty when the bridge is
   * disabled or the manager has not spawned the subprocess yet. */
  openCodeServerUrl?: string;
  instances: Array<{
    id: string;
    alias: string;
    kind: "local" | "remote";
    dataRetention: "local" | "retained";
    /** Resolved endpoint URL. Local: the user's `wat321.localEndpoint`
     * (llama-server). Zen: opencode.ai/zen/v1. Used by the session-
     * tokens poller to probe `/props` for local n_ctx. */
    endpoint?: string;
    apiKeyMissing?: boolean;
    model?: string;
    /** Model context window in tokens. Local instances may have this
     * overridden by a runtime `/props.n_ctx` probe. */
    contextWindow?: number;
  }>;
}

function readHeartbeat(): Heartbeat | null {
  const path = heartbeatPath();
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
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
    // Defensive defaults for legacy flat-config.json files. Without
    // these, reading a stale config from a prior install throws on
    // the first refresh tick and aborts activation.
    return {
      enabled: parsed.enabled === true,
      activeInstanceId:
        typeof parsed.activeInstanceId === "string" ? parsed.activeInstanceId : "",
      openCodeServerUrl:
        typeof parsed.openCodeServerUrl === "string" ? parsed.openCodeServerUrl : "",
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

/** Pick the bridge target ("opencode" or "local") for the displayed
 * instance so the active S# can be looked up in the alias map. Local
 * LLM maps to "local"; every Zen route (Big Pickle and friends) maps
 * to "opencode". Returns null when no instance is selected (the
 * empty-catalog edge case). */
function targetForInstance(
  instance: ConfigSnapshot["instances"][number] | null
): "opencode" | "local" | null {
  if (!instance) return null;
  return instance.kind === "local" ? "local" : "opencode";
}

// Tooltip composition lives in `./tooltip.ts`.
import { buildOpenCodeRoutesTooltip } from "./tooltip";

export function createOpenCodeRoutesStatusBarItem(
  context: vscode.ExtensionContext,
  logger: OpenCodeRoutesLogger
): { dispose: () => void } {
  const item = vscode.window.createStatusBarItem(
    "wat321.modelBridge",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.modelBridge)
  );
  item.name = "OpenCode Routes";
  item.hide();

  // Tooltip-only widget. All session/instance management lives on
  // the Epic Handshake dropdown (Manage OpenCode Sessions / Manage
  // Local LLM Sessions). The legacy click-menu stays registered as a
  // command-palette entry only ('WAT321: OpenCode Routes - Menu
  // (legacy)') for the rare user who wants the old shape; the widget
  // itself never sets `item.command`.
  const legacyMenuCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.legacyMenu",
    async () => {
      await showOpenCodeRoutesMenu(context, logger);
    }
  );
  // Cross-tier hook: Epic Handshake dispatches to this command from
  // its "Manage OpenCode Sessions" row so users can reach bridge
  // session management without leaving the EH dropdown.
  const sessionsCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.manageSessions",
    async () => {
      await showOpenCodeRoutesSessions();
    }
  );
  // Keep the legacy `wat321.modelBridge.show` so settings descriptions
  // and external integrations that still reference it keep working.
  const showCommand = vscode.commands.registerCommand(
    "wat321.modelBridge.show",
    () => logger.show()
  );

  // Background poller that hydrates per-session token totals from
  // OpenCode's message log so the widget can render `S1 12K 31%` style
  // figures parallel to Claude / Codex session tokens. Lookups are
  // closures over the merged config so the poller stays decoupled
  // from the config-file path; refreshes every 3s and caches by
  // sessionId.
  const sessionTokensPoller = new BridgeSessionTokensPoller({
    serveUrl: () => readConfigSnapshot()?.openCodeServerUrl ?? "",
    localEndpoint: () => {
      const snap = readConfigSnapshot();
      const local = snap?.instances.find((i) => i.kind === "local");
      return local?.endpoint ?? "";
    },
    catalogContextWindow: (target: BridgeTarget) => {
      const snap = readConfigSnapshot();
      if (!snap) return null;
      const inst = snap.instances.find((i) =>
        target === "local" ? i.kind === "local" : i.kind === "remote"
      );
      return inst?.contextWindow ?? null;
    },
  });
  sessionTokensPoller.start();

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

    const idleAlias = active.alias || active.id || "OpenCode";
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

    // Active bridge alias (S1 / S2 / etc.) for the displayed
    // instance's target bucket. Local LLM uses the "local" target
    // bucket; every Zen route shares the "opencode" bucket. Used
    // by the tooltip + as the cache key for the session-tokens
    // poller. Status-bar text intentionally omits the S# - the
    // tokens-used + percentage already carries enough signal.
    const activeBridgeTarget = targetForInstance(active);
    const activeBridgeAlias = activeBridgeTarget
      ? readActiveBridgeAlias(activeBridgeTarget)
      : null;

    // Per-session context-used + percentage from the OpenCode
    // message log. Replaces the older lifetime-counter suffix when a
    // session is bound and has at least one assistant turn with
    // output > 0. Falls back to the legacy lifetime counter when no
    // session snapshot is available so a fresh-instance widget still
    // shows something useful at idle.
    const sessionTokens = activeBridgeTarget
      ? sessionTokensPoller.snapshot(activeBridgeTarget)
      : null;
    let sessionTokensSuffix = "";
    if (sessionTokens) {
      const pctSuffix =
        sessionTokens.contextWindow !== null && sessionTokens.contextWindow > 0
          ? ` ${formatPct(
              Math.min(
                100,
                Math.round((sessionTokens.contextUsed / sessionTokens.contextWindow) * 100)
              )
            )}`
          : "";
      sessionTokensSuffix = ` ${formatTokens(sessionTokens.contextUsed)}${pctSuffix}`;
    } else {
      // Fallback: cumulative lifetime tokens from the per-instance
      // usage tracker. Less precise than per-session context-used,
      // but shows something instead of a bare alias when the poller
      // has no data yet (cold launch before the first /session
      // /message poll lands, or no active alias at all).
      const activeUsage = usage?.instances[active.id];
      const activeTotalTokens =
        typeof activeUsage?.input === "number" && typeof activeUsage?.output === "number"
          ? activeUsage.input + activeUsage.output
          : 0;
      sessionTokensSuffix =
        activeTotalTokens > 0 ? ` ${formatTokens(activeTotalTokens)}` : "";
    }

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
        text = `${idleIcon} ${idleAlias}${sessionTokensSuffix}`;
        tooltipSig = `idle:${idleAlias}:${needsKey}:${usageSig}:${activeBridgeAlias ?? ""}:${sessionTokens?.contextUsed ?? 0}:${sessionTokens?.contextWindow ?? 0}:${sessionTokens?.autoCompactTokens ?? 0}`;
        tooltip = buildOpenCodeRoutesTooltip({
          hb: null,
          catalogAlias: idleAlias,
          catalogContextWindow: active.contextWindow ?? null,
          retention,
          needsKey,
          sessionTokens,
          target: activeBridgeTarget,
          activeBridgeAlias,
        });
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
        // In-flight status text. Resolution order:
        //   1. Cumulative session tokens + percentage (matches the
        //      idle vocabulary AND the tooltip's 📁 line). Used when
        //      the session has any prior assistant turn with output -
        //      the poller has populated the snapshot.
        //   2. Live per-turn token count from the heartbeat. Used on
        //      fresh sessions before the first turn lands or when the
        //      session-tokens poller has not yet cached a value. The
        //      char-count proxy from the SSE tap gives the user a
        //      moving number rather than a static elapsed-seconds
        //      counter while the model generates.
        //   3. Elapsed seconds fallback. Used when neither token
        //      source has produced a number yet (very early in a
        //      cold-session dispatch).
        const liveTokens =
          typeof heartbeat.tokens === "number" ? heartbeat.tokens : 0;
        const rate =
          typeof heartbeat.tokensPerSec === "number" ? heartbeat.tokensPerSec : 0;
        const tpsEnabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableTokensPerSecondCounters", false);
        const tpsLiveSuffix = tpsEnabled && rate > 0 ? ` @ ${rate}/s` : "";
        let stat: string;
        if (sessionTokensSuffix.length > 0) {
          stat = `${sessionTokensSuffix.trim()}${tpsLiveSuffix}`;
        } else if (liveTokens > 0) {
          stat = `${liveTokens}t${tpsLiveSuffix}`;
        } else {
          stat = `${elapsedSec}s`;
        }
        text = `${icon} ${alias} ${stat}`;
        tooltipSig = `live:${heartbeat.currentPhase || "DISPATCH"}:${(heartbeat.phaseTrace || []).length}:${usageSig}:${activeBridgeAlias ?? ""}:${sessionTokens?.contextUsed ?? 0}:${sessionTokens?.contextWindow ?? 0}:${sessionTokens?.autoCompactTokens ?? 0}`;
        tooltip = buildOpenCodeRoutesTooltip({
          hb: heartbeat,
          catalogAlias: alias,
          catalogContextWindow: active.contextWindow ?? null,
          retention: heartbeat.dataRetention ?? retention,
          needsKey: false,
          sessionTokens,
          target: activeBridgeTarget,
          activeBridgeAlias,
        });
      }
    } else {
      const badge = needsKey ? " $(wat321-square-alert)" : "";
      text = `${idleIcon} ${idleAlias}${sessionTokensSuffix}${badge}`;
      tooltipSig = `idle:${idleAlias}:${needsKey}:${usageSig}:${activeBridgeAlias ?? ""}:${sessionTokens?.contextUsed ?? 0}:${sessionTokens?.contextWindow ?? 0}:${sessionTokens?.autoCompactTokens ?? 0}`;
      tooltip = buildOpenCodeRoutesTooltip({
        hb: null,
        catalogAlias: idleAlias,
        catalogContextWindow: active.contextWindow ?? null,
        retention,
        needsKey,
        sessionTokens,
        target: activeBridgeTarget,
        activeBridgeAlias,
      });
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
      sessionTokensPoller.dispose();
      item.dispose();
    },
  };
}
