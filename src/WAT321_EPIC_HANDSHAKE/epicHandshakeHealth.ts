import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { peekResolvedClaudeCli } from "../shared/providers/claude/cliResolver";
import { peekResolvedCodexCli } from "../shared/providers/codex/cliResolver";
import { peekResolvedOpenCodeCli } from "../shared/providers/opencode/cliResolver";
import type { ResolvedCli } from "../shared/providers/cliResolver";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import type { BridgeThreadRecord } from "./threadPersistence";

/**
 * Health command surface for the Epic Handshake tier. Renders enabled
 * state, resolved CLI binaries with semver tags, and per-workspace
 * bridge-thread records into the diagnostic output channel. Cached CLI
 * version probes keep repeat health invocations free.
 */

/** Cached CLI version lookups so a single health command invocation
 * spends ~1ms per provider rather than re-running `--version` every
 * time. Keyed by command path - one spawn per binary across the entire
 * VS Code lifetime. */
const cliVersionCache = new Map<string, string | null>();

function probeCliVersion(resolved: ResolvedCli): string | null {
  const key = resolved.command;
  if (cliVersionCache.has(key)) return cliVersionCache.get(key) ?? null;
  let version: string | null = null;
  try {
    const r = spawnSync(resolved.command, ["--version"], {
      encoding: "utf8",
      timeout: 500,
      windowsHide: true,
      shell: resolved.needsShell,
    });
    if (r.status === 0 && typeof r.stdout === "string") {
      const first = r.stdout.split(/\r?\n/)[0]?.trim() ?? "";
      // CLIs vary: "1.14.39", "claude-code 2.1.128", "codex 0.124.0".
      // Strip leading words to leave just the semver-ish suffix.
      const match = first.match(/(\d+\.\d+\.\d+[\w.+-]*)/);
      version = match ? match[1] : (first.length > 0 ? first.slice(0, 30) : null);
    }
  } catch {
    // best-effort
  }
  cliVersionCache.set(key, version);
  return version;
}

export function appendEpicHandshakeHealth(lines: string[]): void {
  const enabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.epicHandshakeEnabled, false);
  lines.push("");
  lines.push("Epic Handshake");
  lines.push("-".repeat(30));
  lines.push(`  enabled: ${enabled}`);
  lines.push("  architecture: sync MCP bridge (Claude -> Codex forward direction)");

  // CLI binary resolution surface. Helps the user diagnose "where is
  // my claude/codex coming from?" - especially relevant now that the
  // bridge can fall back to the marketplace extension's bundled binary
  // when nothing is on PATH. peek* returns undefined when no probe has
  // run yet (rare in practice - isClaudeAvailable runs at activate).
  const claude = peekResolvedClaudeCli();
  const codex = peekResolvedCodexCli();
  const opencode = peekResolvedOpenCodeCli();
  const renderResolved = (label: string, r: ResolvedCli | null | undefined): string => {
    if (r === undefined) return `  ${label}: not yet probed`;
    if (r === null) return `  ${label}: not found (install Marketplace extension or standalone CLI)`;
    const version = probeCliVersion(r);
    const versionTag = version ? ` v${version}` : "";
    return `  ${label}: ${r.source}${versionTag} (${r.command})`;
  };
  lines.push(renderResolved("claude CLI  ", claude));
  lines.push(renderResolved("codex CLI   ", codex));
  lines.push(renderResolved("opencode CLI", opencode));

  if (!enabled) return;

  // Scan bridge-thread records for all workspaces on this machine.
  if (!existsSync(EPIC_HANDSHAKE_DIR)) {
    lines.push("  state: no on-disk state yet (nothing dispatched)");
    return;
  }

  let files: string[];
  try {
    files = readdirSync(EPIC_HANDSHAKE_DIR).filter(
      (f) => f.startsWith("bridge-thread.") && f.endsWith(".json")
    );
  } catch {
    lines.push("  state: unreadable");
    return;
  }

  if (files.length === 0) {
    lines.push("  state: no bridge threads yet");
    return;
  }

  for (const f of files) {
    try {
      const raw = readFileSync(join(EPIC_HANDSHAKE_DIR, f), "utf8");
      const rec = JSON.parse(raw) as BridgeThreadRecord;
      lines.push(`  workspace:     ${rec.workspacePath}`);
      lines.push(`    session:     S${rec.sessionCounter}${rec.threadId !== null ? ` (${rec.threadId.slice(0, 8)}...)` : " (null - fresh on next prompt)"}`);
      if (rec.lastSuccessAt) {
        lines.push(`    lastSuccess: ${new Date(rec.lastSuccessAt).toLocaleString()}`);
      }
      if ((rec.consecutiveFailures ?? 0) > 0) {
        lines.push(`    failures:    ${rec.consecutiveFailures} consecutive`);
        lines.push(`    lastError:   ${rec.lastError ?? "(unknown)"}`);
      }
      if (rec.lastResetAt) {
        lines.push(`    lastReset:   ${new Date(rec.lastResetAt).toLocaleString()}`);
      }
    } catch {
      lines.push(`  workspace: ${f} unreadable`);
    }
  }
}
