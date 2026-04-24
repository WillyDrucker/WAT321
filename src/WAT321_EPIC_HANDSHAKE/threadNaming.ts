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

/** Scan Codex's `~/.codex/session_index.jsonl` for any existing
 * threads whose `thread_name` matches our bridge naming pattern
 * for this workspace. Returns the max `S<N>` seen, or 0 if none.
 *
 * Used to pick a collision-free counter even when the user has
 * deleted sessions externally (which doesn't touch our state) or
 * manually renamed things. Read-only - we never modify Codex's
 * own state files. */
export function maxExistingSessionCounter(workspacePath: string): number {
  const pattern = bridgeThreadNamePattern(workspacePath);
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(indexPath)) return 0;

  let maxSeen = 0;
  try {
    const raw = readFileSync(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { thread_name?: string };
        const m = pattern.exec(entry.thread_name ?? "");
        if (m !== null) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > maxSeen) maxSeen = n;
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // read error - fall through with maxSeen=0
  }
  return maxSeen;
}

/** Pick the next collision-free session counter for this workspace.
 * Returns max(our current counter, maxExistingSessionCounter + 1).
 * Guarantees no name collision in the Codex TUI even if the user
 * has deleted sessions externally without using our Reset command. */
export function nextCollisionFreeCounter(
  workspacePath: string,
  currentCounter: number
): number {
  const maxSeen = maxExistingSessionCounter(workspacePath);
  return Math.max(currentCounter, maxSeen + 1);
}
