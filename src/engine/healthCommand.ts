import { join } from "node:path";
import * as vscode from "vscode";
import type { ProviderKey } from "./contracts";
import type { EngineContext } from "./engineContext";
import { readRecentTransitions } from "../shared/polling/transitionLog";
import { isPidAlive } from "../shared/ui/sessionTokenHelpers";
import { getNotificationDiagnostics } from "./toastNotifier";
import { clientStateDir } from "../shared/wat321Paths";
import { getAppUserModelID } from "./windowsToastProcess";

/** Appended callbacks for tool-owned health sections (Epic Handshake
 * etc.). Tools register via `registerHealthSection` during activate;
 * the command iterates the list when the panel is rendered. Keeps
 * the engine from importing tool modules directly. */
type HealthSectionFn = (lines: string[]) => void;
const healthSections: HealthSectionFn[] = [];

export function registerHealthSection(fn: HealthSectionFn): vscode.Disposable {
  healthSections.push(fn);
  return {
    dispose: () => {
      const i = healthSections.indexOf(fn);
      if (i >= 0) healthSections.splice(i, 1);
    },
  };
}

/**
 * Diagnostic command exposed in the palette as
 * `WAT321: Show Provider Health`. Opens a read-only output panel
 * summarizing the current state of every provider and recent
 * delivery decisions.
 *
 * Surfaces:
 *   - Provider lifecycle (registered / activated / connected)
 *   - Usage service state + kickstart escalation + rate-limit park
 *   - Active transcript paths per provider
 *   - Windows host AUMID diagnostics
 *   - Recent provider transitions (ring buffer)
 *   - Recent notification deliveries (ring buffer)
 *
 * All data is read-only from existing service accessors. Nothing
 * here can alter behavior.
 */

const COMMAND_ID = "wat321.showProviderHealth";
const TRANSITION_RING_SIZE = 20;

interface Transition {
  at: number;
  event: string;
  provider?: ProviderKey;
}

const transitions: Transition[] = [];

function recordTransition(entry: Transition): void {
  transitions.push(entry);
  if (transitions.length > TRANSITION_RING_SIZE) {
    transitions.splice(0, transitions.length - TRANSITION_RING_SIZE);
  }
}

function formatEpoch(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function formatDuration(ms: number): string {
  if (ms < 0) return `${ms}ms`;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
}

function renderProvider(ctx: EngineContext, key: ProviderKey, lines: string[]): void {
  const descriptor = ctx.providers.getDescriptor(key);
  const displayName = descriptor?.displayName ?? key;
  lines.push(`[${displayName}]`);

  const group = ctx.providers.getGroup(key);
  if (!group) {
    lines.push(`  status: not activated`);
    return;
  }

  const usageState = group.usageService.getState();
  const tokenState = group.tokenService.getState();
  const diag = group.usageService.getDiagnostics();

  lines.push(`  usage:   ${usageState.status}`);
  lines.push(`  tokens:  ${tokenState.status}`);

  if (diag.consecutiveFailedKickstarts > 0 || diag.postWakeStrikesRemaining > 0) {
    lines.push(`  kickstart: failed=${diag.consecutiveFailedKickstarts} strikesRemaining=${diag.postWakeStrikesRemaining}`);
  }
  if (diag.consecutiveColdStartAbsorbs > 0) {
    lines.push(`  absorbs:  ${diag.consecutiveColdStartAbsorbs} cold-poll 429s absorbed in a row (resets on next ok)`);
  }

  if (diag.rateLimitedAt !== null && diag.retryAfterMs !== null) {
    const parkedFor = Date.now() - diag.rateLimitedAt;
    const remaining = diag.retryAfterMs - parkedFor;
    lines.push(`  parked:  ${formatDuration(parkedFor)} in, ${formatDuration(Math.max(0, remaining))} remaining`);
  }

  const transcriptPath = group.tokenService.getActiveTranscriptPath();
  if (transcriptPath) {
    lines.push(`  tail:    ${transcriptPath}`);
  }
  const sessionDiag = group.tokenService.getActiveSessionDiagnostics();
  if (sessionDiag.source !== null) {
    // `source` is the primary cross-workspace contamination diagnostic.
    // A `tail:` path that does not belong to your workspace plus
    // `source: lastKnown` is the signature of the bug fixed in v1.5.9:
    // getProjectKey encoding mismatch falling to Stage 2 global scan.
    // After the fix, lastKnown should appear only when (a) no live
    // session matches the workspace cwd or (b) the live transcript
    // file has not been created yet.
    const pidPart =
      sessionDiag.pid !== null
        ? ` (pid ${sessionDiag.pid}, ${isPidAlive(sessionDiag.pid) ? "alive" : "dead"})`
        : "";
    lines.push(`  source:  ${sessionDiag.source}${pidPart}`);
  }

  // Claude-only: compact state machine snapshot. Only fires when the
  // provider implements the optional contract method.
  const compactDiag = group.tokenService.getCompactDiagnostics?.();
  if (compactDiag) {
    const estimate = formatDuration(compactDiag.estimatedDurationMs);
    const historyPart =
      compactDiag.recentDurationsMs.length > 0
        ? ` (avg of ${compactDiag.recentDurationsMs.length} recent: ${compactDiag.recentDurationsMs.map((d) => formatDuration(d)).join(", ")})`
        : " (no history yet, using 120s default)";
    if (compactDiag.state === "in-flight" && compactDiag.startedAt !== null) {
      const elapsed = formatDuration(Date.now() - compactDiag.startedAt);
      lines.push(`  compact: in-flight, ${elapsed} elapsed, estimate ${estimate}${historyPart}`);
    } else {
      lines.push(`  compact: idle, next estimate ${estimate}${historyPart}`);
    }
  }

  renderTransitionLog(key, lines);
}

function renderTransitionLog(key: ProviderKey, lines: string[]): void {
  const path = join(clientStateDir(), `${key}-usage-transitions.jsonl`);
  const recent = readRecentTransitions(path, 25);
  if (recent.length === 0) return;
  lines.push(`  recent transitions (last ${recent.length}, oldest first):`);
  for (const r of recent) {
    const at = new Date(r.at).toLocaleTimeString();
    const tag = r.from === r.to ? r.reason : `${r.from} -> ${r.to} (${r.reason})`;
    const detail: string[] = [];
    if (typeof r.idleForMs === "number") {
      detail.push(`idle=${formatDuration(r.idleForMs)}`);
    } else if (r.idleForMs === null) {
      detail.push("idle=no-probe");
    }
    if (r.isColdStart === true) detail.push("cold-start");
    if (typeof r.consecutiveColdStartAbsorbs === "number" && r.consecutiveColdStartAbsorbs > 0) {
      detail.push(`absorbs=${r.consecutiveColdStartAbsorbs}`);
    }
    if (
      typeof r.consecutiveFailedKickstarts === "number" &&
      r.consecutiveFailedKickstarts > 0
    ) {
      detail.push(`failedKicks=${r.consecutiveFailedKickstarts}`);
    }
    if (typeof r.pollIntervalMs === "number") {
      detail.push(`poll=${formatDuration(r.pollIntervalMs)}`);
    }
    if (typeof r.cacheAgeMs === "number") {
      detail.push(`cacheAge=${formatDuration(r.cacheAgeMs)}`);
    }
    if (typeof r.retryAfterMs === "number") {
      detail.push(`retryAfter=${formatDuration(r.retryAfterMs)}`);
    }
    if (r.serverMessage) detail.push(`msg="${r.serverMessage}"`);
    const detailStr = detail.length > 0 ? `  [${detail.join(", ")}]` : "";
    lines.push(`    ${at}  ${tag}${detailStr}`);
  }
}

function renderTransitions(lines: string[]): void {
  lines.push("Recent lifecycle transitions");
  lines.push("-".repeat(30));
  if (transitions.length === 0) {
    lines.push("(none yet this session)");
    return;
  }
  for (const t of transitions) {
    const who = t.provider ? ` ${t.provider}` : "";
    lines.push(`  ${formatEpoch(t.at)}  ${t.event}${who}`);
  }
}

function renderNotifications(lines: string[]): void {
  lines.push("Recent notification decisions");
  lines.push("-".repeat(30));
  const diag = getNotificationDiagnostics();
  if (diag.length === 0) {
    lines.push("(none yet this session)");
    return;
  }
  for (const d of diag) {
    const focus = d.focused ? "focused" : "unfocused";
    lines.push(`  ${formatEpoch(d.at)}  ${d.provider.padEnd(7)} mode=${d.mode.padEnd(20)} ${d.outcome} (${focus})`);
  }
}

export function registerHealthCommand(
  context: vscode.ExtensionContext,
  getCtx: () => EngineContext | null
): void {
  // Subscribe to lifecycle and connectivity events once the engine
  // context becomes available. Events are emitted from extension.ts
  // and bootstrap.ts; we just record them.
  const ctxOnInit = getCtx();
  if (ctxOnInit) {
    const { events } = ctxOnInit;
    context.subscriptions.push(
      events.on("provider.activated", (p) => recordTransition({ at: Date.now(), event: "activated", provider: p.provider })),
      events.on("provider.deactivated", (p) => recordTransition({ at: Date.now(), event: "deactivated", provider: p.provider })),
      events.on("provider.connected", (p) => recordTransition({ at: Date.now(), event: "connected", provider: p.provider })),
      events.on("provider.disconnected", (p) => recordTransition({ at: Date.now(), event: "disconnected", provider: p.provider })),
      events.on("engine.reset", () => recordTransition({ at: Date.now(), event: "engine.reset" })),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, () => {
      const ctx = getCtx();
      if (!ctx) {
        void vscode.window.showWarningMessage("WAT321 engine not initialized.");
        return;
      }

      const lines: string[] = [
        "WAT321 Provider Health",
        "=".repeat(30),
        "",
        `Activated provider groups: ${ctx.providers.activeCount()}`,
      ];

      if (process.platform === "win32") {
        // Mismatched AUMID is the most common silent-drop cause for
        // Windows toasts on VS Code forks. Surface it prominently so
        // a user seeing no notifications can spot a failed host
        // resolution without reading source. AUMID is discovered
        // inside the warm PowerShell process at first spawn; until
        // then this reads `(pending)`.
        const aumid = getAppUserModelID() || "(pending - no toast fired yet)";
        lines.push(`Host appName:    ${vscode.env.appName}`);
        lines.push(`Host uriScheme:  ${vscode.env.uriScheme}`);
        lines.push(`Toast AUMID:     ${aumid}`);
      }

      lines.push("");

      for (const key of ctx.providers.keys()) {
        renderProvider(ctx, key, lines);
        lines.push("");
      }

      renderTransitions(lines);
      lines.push("");
      renderNotifications(lines);
      lines.push("");
      for (const fn of healthSections) {
        try {
          fn(lines);
        } catch {
          lines.push("  (health section errored)");
        }
      }
      lines.push("");
      lines.push(`Timestamp: ${new Date().toLocaleString()}`);

      const panel = vscode.window.createOutputChannel("WAT321 Health");
      panel.clear();
      for (const line of lines) panel.appendLine(line);
      panel.show();
    })
  );
}
