import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";

/**
 * Copy the runtime (non-dev) packages from the extension's
 * `node_modules` into a bridge's `bin/node_modules/` so the MCP
 * server subprocess can resolve its deps without dragging in the
 * dev-only footprint (eslint / typescript / etc.).
 *
 * Reads `out/prod-modules.json` emitted at build time from
 * `package-lock.json`. Both bridges (Epic Handshake and Model Bridge)
 * need an identical SDK copy, so the manifest lives at the shared
 * `out/` root rather than under either tier.
 *
 * Logger type is structural - any object with `info` / `warn` / `error`
 * methods works, so the helper does not couple the two bridges to a
 * single logger surface.
 */

interface MinimalLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const MANIFEST_RELATIVE_PATH = join("out", "prod-modules.json");

export function copyProdModules(
  context: vscode.ExtensionContext,
  targetBinDir: string,
  logger: MinimalLogger
): void {
  const manifestPath = join(context.extensionPath, MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath)) {
    logger.warn(
      `prod-modules.json not found at ${manifestPath}; bridge channel may fail to import`
    );
    return;
  }
  let prodKeys: string[];
  try {
    prodKeys = JSON.parse(readFileSync(manifestPath, "utf8")) as string[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`prod-modules.json parse failed: ${msg}`);
    return;
  }

  let copied = 0;
  for (const key of prodKeys) {
    const srcPath = join(context.extensionPath, key);
    const dstPath = join(targetBinDir, key);
    if (!existsSync(srcPath)) continue;
    try {
      mkdirSync(dirname(dstPath), { recursive: true });
      cpSync(srcPath, dstPath, { recursive: true, force: true });
      copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`copy failed for ${key}: ${msg}`);
    }
  }
  logger.info(`node_modules copy complete: ${copied} prod packages copied`);
}
