#!/usr/bin/env node
// WAT321 Epic Handshake - Stage Clipboard Image (cross-platform)
//
// Writes whatever image is on the OS clipboard to a PNG under
// ~/.wat321/epic-handshake/attachments/clipboard/ and prints the
// absolute path to stdout (exit 1 with a stderr message when the
// clipboard has no image or the platform tool is missing). Claude runs
// it once, only when about to send a bridge prompt that references the
// image, and puts the printed path in the prompt body so Codex reads
// the file from disk and the bytes never enter Claude's token budget.
//
// Usage: node ~/.wat321/epic-handshake/bin/stage-clipboard.mjs [out.png]
// Platform tools: PowerShell (Windows), osascript (macOS), wl-paste or
// xclip (Linux, installed separately). Anything in the staging dir
// older than the TTL is unlinked before the new file lands, which with
// the channel handler's per-dispatch sweep and Reset WAT321's wipe
// covers the "5min or once cleared" cleanup contract.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STAGING_TTL_MS = 5 * 60 * 1000;
const STAGING_DIR = join(
  homedir(),
  ".wat321",
  "epic-handshake",
  "attachments",
  "clipboard"
);

function sweepStale() {
  if (!existsSync(STAGING_DIR)) return;
  const cutoff = Date.now() - STAGING_TTL_MS;
  let entries;
  try {
    entries = readdirSync(STAGING_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(STAGING_DIR, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // best-effort
    }
  }
}

function defaultOutPath() {
  if (!existsSync(STAGING_DIR)) {
    mkdirSync(STAGING_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(STAGING_DIR, `clipboard-${ts}.png`);
}

function fail(message) {
  process.stderr.write(`stage-clipboard: ${message}\n`);
  process.exit(1);
}

function stageWindows(outPath) {
  // PowerShell + System.Windows.Forms.Clipboard.GetImage. Returns null
  // when the clipboard has no image flavor, and we surface that as a
  // user-friendly stderr line rather than a stack trace.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  [Console]::Error.WriteLine("stage-clipboard: no image on the clipboard")
  exit 1
}
$image.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
`.trim();
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  return res.status === 0;
}

function stageMac(outPath) {
  // AppleScript reads «class PNGf» clipboard flavor. Errors out if
  // the clipboard contains text-only or an image flavor we can't read.
  const script = `
on run
  try
    set pngData to the clipboard as «class PNGf»
    set f to open for access POSIX file "${outPath.replace(/"/g, '\\"')}" with write permission
    write pngData to f
    close access f
  on error
    error number -128
  end try
end run
`.trim();
  const res = spawnSync("osascript", ["-e", script], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return res.status === 0;
}

function stageLinux(outPath) {
  // wl-paste covers Wayland and xclip covers X11. Presence alone cannot
  // tell them apart (wl-clipboard installs on X11 too), so every tool
  // present runs in turn and the first capture that succeeds wins.
  const which = (cmd) => {
    const res = spawnSync("sh", ["-c", `command -v ${cmd}`]);
    return res.status === 0;
  };
  const target = `"${outPath.replace(/"/g, '\\"')}"`;
  const attempts = [];
  if (which("wl-paste")) attempts.push(`wl-paste --type image/png > ${target}`);
  if (which("xclip")) attempts.push(`xclip -selection clipboard -t image/png -o > ${target}`);
  if (attempts.length === 0) {
    fail("install xclip or wl-clipboard to extract clipboard images");
    return false;
  }
  const res = spawnSync("sh", ["-c", attempts.join(" || ")], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return res.status === 0;
}

function main() {
  sweepStale();

  const outPath = process.argv[2] || defaultOutPath();

  let ok = false;
  if (process.platform === "win32") {
    ok = stageWindows(outPath);
  } else if (process.platform === "darwin") {
    ok = stageMac(outPath);
  } else if (process.platform === "linux") {
    ok = stageLinux(outPath);
  } else {
    fail(`unsupported platform ${process.platform}`);
  }

  if (!ok || !existsSync(outPath) || statSync(outPath).size === 0) {
    try {
      if (existsSync(outPath) && statSync(outPath).size === 0) {
        rmSync(outPath, { force: true });
      }
    } catch {
      // best-effort
    }
    fail("no image on the clipboard");
  }

  process.stdout.write(`${outPath}\n`);
}

main();
