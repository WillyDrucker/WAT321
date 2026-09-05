import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type * as vscode from "vscode";
import { atomicCopy } from "../engine/fs/atomicCopy";
import { BIN_DIR, EPIC_HANDSHAKE_DIR } from "./epicHandshakePaths";

/**
 * Extracts `stage-clipboard.mjs` into `~/.wat321/epic-handshake/bin/`
 * so Claude can invoke it from Bash by absolute path when staging
 * clipboard images for bridge prompts. Runs on every Epic Handshake
 * activate so the helper stays fresh after vsix upgrades.
 *
 * MCP server registration is owned by `WAT321_MCP_SERVER/installer.ts` -
 * this file is for the clipboard helper only.
 */

const HELPER_SCRIPT_NAME = "stage-clipboard.mjs";

export function extractStageClipboardScript(
  context: vscode.ExtensionContext
): void {
  if (!existsSync(EPIC_HANDSHAKE_DIR)) {
    mkdirSync(EPIC_HANDSHAKE_DIR, { recursive: true });
  }
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }
  // The script lives in src/WAT321_EPIC_HANDSHAKE/bin/ and gets
  // packaged to out/WAT321_EPIC_HANDSHAKE/bin/ via the copy-assets
  // step. In dev (F5) it may also be at src/... via the extension
  // context path. Try both.
  const candidates = [
    join(context.extensionPath, "out", "WAT321_EPIC_HANDSHAKE", "bin", HELPER_SCRIPT_NAME),
    join(context.extensionPath, "src", "WAT321_EPIC_HANDSHAKE", "bin", HELPER_SCRIPT_NAME),
  ];
  const source = candidates.find((c) => existsSync(c));
  if (source === undefined) return;
  atomicCopy(source, join(BIN_DIR, HELPER_SCRIPT_NAME));
}
