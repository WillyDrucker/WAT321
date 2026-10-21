import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { EPIC_HANDSHAKE_DIR } from "../engine/wat321Paths";
import type { EpicHandshakeLogger } from "./epicHandshakeLogger";

/**
 * Stage whatever image is on the OS clipboard into a file under
 * `~/.wat321/epic-handshake/attachments/clipboard/` so the user can
 * reference it in a Claude-to-Codex prompt via `file_paths` on the
 * MCP tool. The image bytes never enter Claude's token budget - they
 * go clipboard -> extension -> disk, and only the path string rides
 * the conversation.
 *
 * Platform matrix:
 *   - Windows: PowerShell + System.Windows.Forms.Clipboard.GetImage
 *   - macOS:   osascript with «class PNGf» clipboard flavor
 *   - Linux:   wl-paste (Wayland) or xclip (X11), installed separately
 *
 * Failure modes are all toast-only: no image on clipboard, platform
 * not supported, tool missing. The command never throws.
 */

const CLIPBOARD_STAGING_DIR = join(
  EPIC_HANDSHAKE_DIR,
  "attachments",
  "clipboard"
);
/** TTL for staged images. Tight 5-minute window matches the stage
 * helper script and the channel.mjs per-dispatch sweep, so staged
 * images never accumulate beyond the immediate "stage and use"
 * window. Sweeps run on tier activate, on every bridge dispatch
 * (channel.mjs), and on every new stage helper invocation. Reset
 * WAT321 wipes the dir entirely. */
const STAGING_TTL_MS = 5 * 60 * 1000;

/** Purge clipboard-staged images older than the TTL. Called once at
 * tier activate. Best-effort - individual unlink failures are ignored. */
export function sweepStaleClipboardStages(logger: EpicHandshakeLogger): void {
  if (!existsSync(CLIPBOARD_STAGING_DIR)) return;
  const cutoff = Date.now() - STAGING_TTL_MS;
  let removed = 0;
  try {
    for (const name of readdirSync(CLIPBOARD_STAGING_DIR)) {
      const full = join(CLIPBOARD_STAGING_DIR, name);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
  if (removed > 0) {
    logger.info(`[clipboard-stage] swept ${removed} stale staged image(s)`);
  }
}

/** Remove the clipboard staging dir on Reset WAT321. */
export function clearClipboardStaging(): void {
  if (!existsSync(CLIPBOARD_STAGING_DIR)) return;
  try {
    for (const name of readdirSync(CLIPBOARD_STAGING_DIR)) {
      try {
        unlinkSync(join(CLIPBOARD_STAGING_DIR, name));
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

function targetPath(): string {
  if (!existsSync(CLIPBOARD_STAGING_DIR)) {
    mkdirSync(CLIPBOARD_STAGING_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(CLIPBOARD_STAGING_DIR, `clipboard-${ts}.png`);
}

/** Spawn a helper process that writes the clipboard image to `out`.
 * Resolves true on success, false on any failure (no image, tool
 * missing, platform unsupported). Logs the platform branch taken. */
function extractClipboardImage(
  out: string,
  logger: EpicHandshakeLogger
): Promise<boolean> {
  return new Promise((resolve) => {
    // Use the shell's %s-style placeholders via argv to avoid path
    // quoting headaches. Each branch below resolves with `true` only
    // when the output file exists and has a non-zero size.
    if (process.platform === "win32") {
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { exit 1 }
$image.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`.trim();
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true }
      );
      ps.on("error", (err) => {
        logger.warn(`[clipboard-stage] powershell spawn failed: ${err.message}`);
        resolve(false);
      });
      ps.on("exit", (code) => {
        resolve(code === 0 && existsSync(out) && statSync(out).size > 0);
      });
      return;
    }
    if (process.platform === "darwin") {
      // AppleScript reads «class PNGf» flavor and writes to disk.
      const script = `
on run
  try
    set pngData to the clipboard as «class PNGf»
    set f to open for access POSIX file "${out.replace(/"/g, '\\"')}" with write permission
    write pngData to f
    close access f
  on error
    error number -128
  end try
end run
`.trim();
      const os = spawn("osascript", ["-e", script]);
      os.on("error", (err) => {
        logger.warn(`[clipboard-stage] osascript spawn failed: ${err.message}`);
        resolve(false);
      });
      os.on("exit", (code) => {
        resolve(code === 0 && existsSync(out) && statSync(out).size > 0);
      });
      return;
    }
    if (process.platform === "linux") {
      // wl-paste covers Wayland and xclip covers X11. Presence alone
      // cannot tell them apart (wl-clipboard installs on X11 too), so a
      // failed wl-paste falls through to xclip, the same chain as
      // `WAT321_EPIC_HANDSHAKE/bin/stage-clipboard.mjs`.
      const target = `"${out.replace(/"/g, '\\"')}"`;
      const lx = spawn("sh", [
        "-c",
        `{ command -v wl-paste >/dev/null 2>&1 && wl-paste --type image/png > ${target}; } || xclip -selection clipboard -t image/png -o > ${target}`,
      ]);
      lx.on("error", (err) => {
        logger.warn(`[clipboard-stage] clipboard tool spawn failed: ${err.message}`);
        resolve(false);
      });
      lx.on("exit", (code) => {
        resolve(code === 0 && existsSync(out) && statSync(out).size > 0);
      });
      return;
    }
    logger.warn(`[clipboard-stage] platform ${process.platform} not supported`);
    resolve(false);
  });
}

/** Command handler: stage the current clipboard image and surface the
 * resulting path via a toast with a "Copy Path" action. Also writes
 * the path into the VS Code clipboard so the user can paste it
 * directly into their next Claude prompt without re-typing. */
export async function stageClipboardImageCommand(
  logger: EpicHandshakeLogger
): Promise<void> {
  const out = targetPath();
  const ok = await extractClipboardImage(out, logger);
  if (!ok) {
    // Clean up any zero-byte remnants so they do not accumulate.
    try {
      if (existsSync(out) && statSync(out).size === 0) unlinkSync(out);
    } catch {
      // best-effort
    }
    void vscode.window.showWarningMessage(
      "WAT321: no image found on the clipboard (or the platform's clipboard tool is missing). Copy a screenshot first, then run this command again."
    );
    return;
  }
  logger.info(`[clipboard-stage] wrote ${out}`);
  // Put the path on the system clipboard for easy paste.
  await vscode.env.clipboard.writeText(out);
  const choice = await vscode.window.showInformationMessage(
    `WAT321: clipboard image staged. Path copied to clipboard - reference it in your next Claude-to-Codex prompt.`,
    "Show File",
    "Dismiss"
  );
  if (choice === "Show File") {
    try {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(out));
    } catch {
      // fall back to an info toast with the raw path if OS reveal fails
      void vscode.window.showInformationMessage(`Path: ${out}`);
    }
  }
}
