import { spawn, type ChildProcess } from "node:child_process";

/**
 * Warm PowerShell / WinRT process for near-instant Windows toast
 * notifications.
 *
 * One long-lived `powershell.exe` spawned on first toast. Bootstrap
 * loads the WinRT assemblies, resolves the host's registered
 * AppUserModelID (AUMID) via `Get-StartApps`, echoes the resolved
 * value to stdout for the health command, then enters a ReadLine
 * loop. Each subsequent toast is a one-line expression piped via
 * stdin; the session variable `$aumid` is reused so we do not
 * interpolate the AUMID per toast.
 *
 * AUMID matters because Windows silently discards a toast whose
 * `CreateToastNotifier(<aumid>)` argument is not registered to a
 * Start-menu shortcut. Zero logging, zero user-visible signal. VS
 * Code family forks (Insiders, VSCodium, Cursor, Windsurf) each
 * register their own AUMID via Squirrel at install. `Get-StartApps`
 * enumerates these; we match by `vscode.env.appName` passed in at
 * spawn time. Final fallback is the `powershell` AUMID which is
 * always registered - the toast delivers, but the origin chip reads
 * "Windows PowerShell" instead of the host name.
 *
 * Encoding: `[Console]::InputEncoding = UTF8` matches Node's stdin
 * write encoding so non-ASCII content (em dashes, smart quotes,
 * emoji, curly-quote title wrappers) is not mangled. OutputEncoding
 * is likewise UTF-8 so Node reads the AUMID echo cleanly.
 *
 * Windows only. Imported unconditionally from `extension.ts` (for
 * `setHostAppName`, `dispose`) and `toastNotifier.ts` (for
 * `showToast`), but the actual PowerShell spawn is gated on
 * `process.platform === "win32"` at the toast call site. Non-Windows
 * platforms never spawn.
 */

let hostAppName = "";
let discoveredAumid = "";
let stdoutBuffer = "";
let proc: ChildProcess | null = null;

/** Set the host app name used at warm-process bootstrap for
 * `Get-StartApps` matching. Call from `extension.ts activate()` with
 * `vscode.env.appName`. Idempotent; takes effect on the next warm-
 * process spawn. */
export function setHostAppName(name: string): void {
  if (typeof name === "string") hostAppName = name;
}

/** Effective AUMID resolved at warm-process bootstrap, or `""` if
 * not yet discovered (process not spawned, discovery in flight, or
 * non-Windows). Surfaced by the health command for diagnostics. */
export function getAppUserModelID(): string {
  return discoveredAumid;
}

/** Escape for a PowerShell single-quoted string literal: double any
 * embedded single quotes. `appName` is user-controllable only in the
 * sense that a forked host can set it to arbitrary text; still
 * escape defensively. */
function escapePowershellSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

/** Bootstrap script runs once per spawn. Forces UTF-8 I/O, loads
 * WinRT assemblies, resolves the AUMID via `Get-StartApps` keyed on
 * the host app name, echoes the resolved AUMID to stdout as a single
 * `AUMID:<value>` line for Node to cache, then enters the ReadLine
 * loop. Session variable `$aumid` survives for all subsequent toast
 * commands.
 *
 * Failure modes are all absorbed by the try/catch around the lookup:
 *   - `Get-StartApps` cmdlet missing (odd Windows editions)
 *   - No Start-menu match for the appName
 *   - appName empty (non-Windows caller or host detection failed)
 * Any failure leaves `$aumid = 'powershell'` which is always
 * registered and always delivers. */
function buildBootstrapScript(appName: string): string {
  const safe = escapePowershellSingleQuoted(appName);
  return [
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
    "$aumid = 'powershell'",
    `try { if ('${safe}'.Length -gt 0) { $m = Get-StartApps | Where-Object { $_.Name -eq '${safe}' } | Select-Object -First 1; if ($m) { $aumid = $m.AppID } } } catch {}`,
    'Write-Output ("AUMID:" + $aumid)',
    "[Console]::Out.Flush()",
    'while ($line = [Console]::In.ReadLine()) { try { Invoke-Expression $line } catch {} }',
  ].join("; ");
}

/** Build the one-line toast expression. References session variable
 * `$aumid` set by the bootstrap - no per-toast AUMID interpolation. */
function buildToastCommand(
  header: string,
  sessionLine: string,
  previewLine: string
): string {
  const h = escapeXml(header);
  const s = escapeXml(sessionLine);
  const p = escapeXml(previewLine);
  return [
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${h}</text><text>${s}</text><text>${p}</text></binding></visual></toast>')`,
    "$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)",
    "$t = New-Object Windows.UI.Notifications.ToastNotification($x)",
    "$n.Show($t)",
  ].join("; ");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Accumulate stdout until we see the `AUMID:<value>\n` line from
 * the bootstrap, then cache it. Subsequent stdout (toast commands
 * never write to stdout, but be defensive) is drained to prevent
 * pipe backpressure. */
function onStdoutChunk(chunk: Buffer): void {
  if (discoveredAumid) return;
  stdoutBuffer += chunk.toString("utf8");
  const nl = stdoutBuffer.indexOf("\n");
  if (nl === -1) return;
  const firstLine = stdoutBuffer.slice(0, nl).trim();
  stdoutBuffer = "";
  if (firstLine.startsWith("AUMID:")) {
    discoveredAumid = firstLine.slice("AUMID:".length).trim();
  }
}

function ensureProcess(): ChildProcess | null {
  if (proc && !proc.killed && proc.stdin?.writable) return proc;

  if (proc) {
    try { proc.kill(); } catch { /* best-effort */ }
    proc = null;
  }

  discoveredAumid = "";
  stdoutBuffer = "";

  try {
    proc = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildBootstrapScript(hostAppName),
    ], {
      // stdout piped so we can read the bootstrap's AUMID echo.
      // stderr ignored - PowerShell writes a lot of red chatter on
      // the smallest unexpected state and we treat delivery success
      // as stdin-write success, not stderr-quiet.
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

    proc.on("error", () => {
      proc = null;
    });
    proc.on("exit", () => {
      proc = null;
    });

    proc.stdout?.on("data", onStdoutChunk);

    // First spawn pays ~500ms for WinRT assembly loads plus ~200-
    // 500ms for Get-StartApps. PowerShell buffers stdin during
    // bootstrap so toast commands queue cleanly; only the first
    // toast feels any delay, and it is still faster than a cold
    // spawn per notification.
    return proc;
  } catch {
    proc = null;
    return null;
  }
}

/** Fire a 3-line Windows toast via the warm PowerShell process.
 * Returns `true` on successful stdin write, `false` on spawn or
 * write failure. No silent mode switch on failure; the caller
 * records the outcome for diagnostics and a user who picked System
 * Notifications gets System Notifications or nothing. */
export function showToast(
  header: string,
  sessionLine: string,
  previewLine: string
): boolean {
  const p = ensureProcess();
  if (!p?.stdin?.writable) return false;

  const cmd = buildToastCommand(header, sessionLine, previewLine);
  try {
    p.stdin.write(`${cmd}\n`);
    return true;
  } catch {
    proc = null;
    return false;
  }
}

/** Kill the warm process. Called from extension deactivate. */
export function dispose(): void {
  if (proc) {
    try {
      proc.stdin?.end();
      proc.kill();
    } catch {
      // best-effort
    }
    proc = null;
  }
}
