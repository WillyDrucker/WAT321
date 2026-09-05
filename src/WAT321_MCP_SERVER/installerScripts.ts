import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import { atomicCopy } from "../engine/fs/atomicCopy";

/**
 * On-disk layout for the unified bridge plus the script-extraction
 * step. Owns the path constants (`BRIDGE_DIR`, `BIN_DIR`) that both
 * the install orchestrator and the Claude-CLI helpers depend on, so
 * the dependency direction stays one way (orchestrator + cli ->
 * scripts) with no circular import. The MCP entry name lives here for
 * the same reason.
 *
 * The bridge runtime ships as separate .mjs files (not bundled) so
 * the source remains editable JavaScript with per-concern boundaries:
 * `channel.mjs` is the MCP entry, `codex/` and `opencode/` hold the
 * per-target handlers, and `docs/` ships the markdown that loads on
 * demand as MCP resources (`bridge://docs/*`). Extraction mirrors the
 * whole `bin/` tree, so adding a runtime module needs no list edit
 * here or in `package.json`.
 */

export const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
export const BIN_DIR = join(BRIDGE_DIR, "bin");
export const UNIFIED_MCP_NAME = "wat321";
const ENTRY_SCRIPT = "channel.mjs";
const SHIPPED_EXTENSIONS = [".mjs", ".md"];
/** Folders the walk never enters. `bin/node_modules` holds the MCP SDK
 * the installer fetches separately, and its packages ship their own
 * `.mjs` and `.md` files that the stale-file sweep must not touch. */
const UNWALKED_DIRS = new Set(["node_modules"]);

function isShipped(name: string): boolean {
  return SHIPPED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Every shipped file under `root`, as paths relative to it. */
function listShipped(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (UNWALKED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listShipped(root, full, out);
    else if (isShipped(name)) out.push(relative(root, full));
  }
  return out;
}

/** The bundled `bin/` tree: `out/` on an installed build, `src/` when
 * running from source. */
function bundledBinDir(context: vscode.ExtensionContext): string {
  for (const subdir of ["out", "src"]) {
    const candidate = join(context.extensionPath, subdir, "WAT321_MCP_SERVER", "bin");
    if (existsSync(join(candidate, ENTRY_SCRIPT))) return candidate;
  }
  throw new Error("unified bridge scripts not found in extension bundle");
}

/** Extract the bridge runtime from the extension bundle to
 * `~/.wat321/bridge/bin/`, mirroring subdirectories. Atomic per file
 * via `atomicCopy` so a Claude Code spawn racing the overwrite cannot
 * read torn bytes. Files from an earlier layout that no longer ship
 * are removed, so a stale module can never be mistaken for a live one
 * while debugging. Returns the absolute path of the entry script. */
export function extractUnifiedScripts(
  context: vscode.ExtensionContext
): string {
  const source = bundledBinDir(context);
  const shipped = listShipped(source);
  for (const rel of shipped) {
    const dest = join(BIN_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    atomicCopy(join(source, rel), dest);
  }
  const keep = new Set(shipped);
  for (const rel of listShipped(BIN_DIR)) {
    if (keep.has(rel)) continue;
    try {
      unlinkSync(join(BIN_DIR, rel));
    } catch {
      // best-effort
    }
  }
  return join(BIN_DIR, ENTRY_SCRIPT);
}
