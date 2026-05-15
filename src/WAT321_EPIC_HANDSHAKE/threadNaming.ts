import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Naming + counter policy for bridge threads. The display name is the
 * single source of truth Codex sees in its TUI session picker, and is
 * also the regex anchor we use to find existing bridge sessions in
 * Codex's `session_index.jsonl`.
 *
 * Workspace identity is basename-scoped in this file: two workspaces
 * named `foo` in different parent paths share the same regex pattern.
 * Callers that cannot tolerate false positives (bulk delete, recovery)
 * must confirm ownership by reading `session_meta.cwd` from each
 * candidate rollout - see `readRolloutCwd` in sessionRecovery.ts.
 */

/** Build the Codex thread display name. Shown in the Codex TUI's
 * session picker so the user can inspect what the bridge is doing.
 * Format: "<Project> Epic Handshake Claude-to-Codex S<N>" */
export function bridgeThreadDisplayName(
  workspacePath: string,
  sessionCounter: number
): string {
  const project = basename(workspacePath) || "Workspace";
  return `${project} Epic Handshake Claude-to-Codex S${sessionCounter}`;
}

/** Regex matching every bridge thread name for this workspace.
 * Capture group 1 is the session counter as a decimal string. */
export function bridgeThreadNamePattern(workspacePath: string): RegExp {
  const project = basename(workspacePath) || "Workspace";
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped} Epic Handshake Claude-to-Codex S(\\d+)$`);
}

/** Scan Codex's `~/.codex/session_index.jsonl` for every existing
 * thread whose `thread_name` matches our bridge naming pattern for
 * this workspace and return the set of session-counter integers
 * currently in use. Read-only - we never modify Codex's state files.
 *
 * Used by `nextCollisionFreeCounter` to gap-fill freed numbers. If
 * Codex hasn't created its index yet (first-ever launch) or the file
 * is unreadable, returns an empty set so the counter starts at 1. */
export function collectExistingSessionCounters(
  workspacePath: string
): Set<number> {
  const pattern = bridgeThreadNamePattern(workspacePath);
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  const taken = new Set<number>();
  if (!existsSync(indexPath)) return taken;

  try {
    const raw = readFileSync(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { thread_name?: string };
        const m = pattern.exec(entry.thread_name ?? "");
        if (m !== null) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > 0) taken.add(n);
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // read error - fall through with empty set
  }
  return taken;
}

/** Pick the next collision-free session counter for this workspace.
 * Gap-fills: returns the lowest positive integer NOT currently in
 * the workspace's set of existing thread names. Matches the policy
 * the OpenCode alias path uses (`aliases.mjs:nextAlias`), so deleting
 * threads in Codex's TUI naturally recycles S1, S2, ... rather than
 * climbing monotonically forever.
 *
 * `currentCounter` is kept on the call signature for back-compat but
 * ignored - the canonical source is now Codex's session_index. The
 * stored counter on `bridge-thread.<wsHash>.json` is a hint only;
 * this function trusts what's actually present in the TUI. */
export function nextCollisionFreeCounter(
  workspacePath: string,
  _currentCounter: number
): number {
  const taken = collectExistingSessionCounters(workspacePath);
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}
