import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { atomicCopy } from "../shared/fs/atomicCopy";

/**
 * On-disk layout for the unified bridge plus the script-extraction
 * step. Lives in its own file because it owns the path constants
 * (`BRIDGE_DIR`, `BIN_DIR`) that both the install orchestrator and
 * the Claude-CLI helpers depend on - keeping the constants here
 * gives the dependency direction one way (orchestrator + cli ->
 * scripts) and avoids a circular import. The MCP entry name lives
 * here too for the same reason: the CLI sweep helpers need it and
 * the orchestrator passes it to the CLI, so the cleanest home is
 * the file every caller already depends on.
 *
 * The bridge scripts are kept as separate .mjs files (not bundled
 * into one) so the source remains editable JavaScript with per-
 * concern boundaries (`channel.mjs` for the JSON-RPC plumbing,
 * `codex.mjs` for the Codex dispatcher, `replyDecorator.mjs` for
 * stage-aware reply text, etc). The docs subdirectory ships markdown
 * files that load on demand as MCP resources (`bridge://docs/*`),
 * keeping per-turn tool-description budget lean.
 */

export const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
export const BIN_DIR = join(BRIDGE_DIR, "bin");
export const UNIFIED_MCP_NAME = "wat321";

const TOP_LEVEL_SCRIPTS = [
  "bridgeInbox.mjs",
  "channel.mjs",
  "codex.mjs",
  "paths.mjs",
  "replyDecorator.mjs",
  "resources.mjs",
] as const;
const OPENCODE_SUBDIR_SCRIPTS = [
  "common.mjs",
  "aliases.mjs",
  "config.mjs",
  "heartbeat.mjs",
  "sse.mjs",
  "sessions.mjs",
  "dispatch.mjs",
  "index.mjs",
] as const;
const DOCS_SUBDIR_FILES = [
  "dispatch.md",
  "dispatch-errors.md",
  "dispatch-routing.md",
  "dispatch-judgement.md",
  "inbox.md",
] as const;

/** Extract the unified bridge scripts from the extension bundle to
 * `~/.wat321/bridge/bin/`. Atomic via `atomicCopy` so a Claude Code
 * spawn racing the overwrite cannot read torn bytes. Returns the
 * absolute path of the entry script (`channel.mjs`). */
export function extractUnifiedScripts(
  context: vscode.ExtensionContext
): string {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
  const opencodeBinDir = join(BIN_DIR, "opencode");
  if (!existsSync(opencodeBinDir)) mkdirSync(opencodeBinDir, { recursive: true });
  const docsBinDir = join(BIN_DIR, "docs");
  if (!existsSync(docsBinDir)) mkdirSync(docsBinDir, { recursive: true });

  const subdirs = ["out", "src"] as const;
  const copyOne = (relParts: string[], fileName: string, destDir: string) => {
    let source: string | null = null;
    for (const subdir of subdirs) {
      const candidate = join(
        context.extensionPath,
        subdir,
        "WAT321_MCP_SERVER",
        "bin",
        ...relParts,
        fileName
      );
      if (existsSync(candidate)) {
        source = candidate;
        break;
      }
    }
    if (source === null) {
      throw new Error(
        `unified bridge script ${[...relParts, fileName].join("/")} not found in extension bundle`
      );
    }
    atomicCopy(source, join(destDir, fileName));
  };

  for (const fileName of TOP_LEVEL_SCRIPTS) copyOne([], fileName, BIN_DIR);
  for (const fileName of OPENCODE_SUBDIR_SCRIPTS) {
    copyOne(["opencode"], fileName, opencodeBinDir);
  }
  for (const fileName of DOCS_SUBDIR_FILES) {
    copyOne(["docs"], fileName, docsBinDir);
  }
  return join(BIN_DIR, "channel.mjs");
}
