import { basename } from "node:path";

/** The per-session UUID a transcript or rollout path carries. Every
 * session-id consumer derives it here so the notification log, the
 * response bridge, and the Codex widgets agree on one spelling.
 *
 *  - Claude: `~/.claude/projects/<projectKey>/<UUID>.jsonl`, the
 *    filename without extension.
 *  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl`
 *    where `<ts>` is `YYYY-MM-DDThh-mm-ss`, six dash-separated parts,
 *    so the UUID is everything after the sixth dash. A rollout name
 *    without the timestamp falls back to the whole basename. */
export function sessionIdFromPath(
  provider: "claude" | "codex",
  path: string
): string {
  const file = basename(path, ".jsonl");
  if (provider === "claude") return file;
  const parts = file.split("-");
  return parts.length > 6 ? parts.slice(6).join("-") : file;
}
