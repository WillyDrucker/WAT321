import { renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./wat321Paths.mjs";

/**
 * Tmp-then-rename write so a reader racing the writer (the extension
 * host's fs watchers, a sibling MCP process) never sees a torn file.
 * MJS counterpart to `src/engine/fs/atomicWrite.ts`. The tmp name
 * carries the pid so two runtime processes writing the same target
 * cannot collide on the temp file.
 */
export function writeFileAtomic(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
