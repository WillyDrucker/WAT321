import { join } from "node:path";
import type { ProviderKey } from "./contracts";
import { formatDuration } from "./durationFormat";
import type { EngineContext } from "./engineContext";
import { isPidAlive } from "./pidLiveness";
import { getNotificationDiagnostics } from "./toastNotifier";
import { readRecentTransitions } from "./usageTransitionLog";
import { clientStateDir } from "./wat321Paths";

/**
 * The provider, runtime, and notification sections of the health panel.
 * Every line is read from existing service accessors, so nothing here
 * can alter behavior. `healthCommand.ts` owns the command, the section
 * registry, and the lifecycle ring buffer, and calls these renderers in
 * panel order.
 */

export function formatEpoch(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function renderProvider(ctx: EngineContext, key: ProviderKey, lines: string[]): void {
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
    // `source` is the cross-workspace contamination diagnostic. A `tail:`
    // path outside the current workspace plus `source: lastKnown` is the
    // signature of a project-key encoding mismatch falling through to the
    // global scan. Under normal operation `lastKnown` appears only when no
    // live session matches the workspace cwd or the live transcript file
    // has not been created yet.
    const pidPart =
      sessionDiag.pid !== null
        ? ` (pid ${sessionDiag.pid}, ${isPidAlive(sessionDiag.pid) ? "alive" : "dead"})`
        : "";
    lines.push(`  source:  ${sessionDiag.source}${pidPart}`);
  }

  // Compact-flash snapshot (Claude + Codex). Only fires when the
  // provider implements the optional contract method.
  const compactDiag = group.tokenService.getCompactDiagnostics?.();
  if (compactDiag) {
    const estimate = formatDuration(compactDiag.estimatedDurationMs);
    const historyPart =
      compactDiag.recentDurationsMs.length > 0
        ? ` (avg of ${compactDiag.recentDurationsMs.length} recent: ${compactDiag.recentDurationsMs.map((d) => formatDuration(d)).join(", ")})`
        : " (no history yet, using 120s default)";
    if (compactDiag.state === "flashing-completion") {
      lines.push(`  compact: just completed, flashing${historyPart}`);
    } else {
      lines.push(`  compact: idle, typical duration ${estimate}${historyPart}`);
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

export function renderRuntimeProbes(lines: string[]): void {
  lines.push("Runtime probes");
  lines.push("-".repeat(30));
  lines.push(`  node:    ${process.versions.node}`);
  lines.push(`  electron: ${process.versions.electron ?? "(not electron)"}`);
  lines.push(`  v8:      ${process.versions.v8}`);
}

export function renderNotifications(lines: string[]): void {
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
