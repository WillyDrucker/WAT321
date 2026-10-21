import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";

/**
 * Copy a file via tmp + rename so an in-flight reader (e.g. Claude
 * Code spawning `node <target>` while we overwrite) cannot observe a
 * torn copy. Same atomic-write contract as `writeFileAtomic`, scoped
 * to a copy operation.
 *
 * Used by the stage-clipboard installer and the MCP server installer
 * when extracting bundled scripts from the .vsix into `~/.wat321/`.
 * Without atomic semantics,
 * upgrading the extension while Claude Code is mid-spawn could parse-
 * fail on a half-written script and the bridge would silently lose
 * its tool registration until Claude Code restarted.
 */
export function atomicCopy(source: string, target: string): void {
  const tmp = `${target}.tmp`;
  copyFileSync(source, tmp);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
}
