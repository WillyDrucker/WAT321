import { createHash } from "node:crypto";
import { normalizePath } from "../shared/fs/pathUtils";

/**
 * Stable short hash for a workspace path. Used as a filename-safe
 * identifier so per-workspace state (bridge thread id, carry-over
 * summaries) can coexist without colliding.
 *
 * 16 hex chars of SHA-256 = 64 bits of entropy. Zero realistic
 * collision risk for the scale of open workspaces a user ever has.
 * Not cryptographic-strength - just a deterministic short id.
 */
export function workspaceHash(workspacePath: string): string {
  const normalized = normalizePath(workspacePath);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}
