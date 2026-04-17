import { spawn, type ChildProcess } from "node:child_process";

/**
 * Warm PowerShell process for near-instant Windows toast notifications.
 *
 * Spawns a single `powershell.exe` at first use with the WinRT
 * assemblies pre-loaded, then keeps it alive for the lifetime of
 * the extension. Toast commands are piped via stdin as one-line
 * PowerShell expressions, avoiding the ~1-2s cold-start cost of
 * spawning a new process per notification.
 *
 * Windows only - module is imported unconditionally from
 * `extension.ts` (for `dispose()`) and `toastNotifier.ts` (for
 * `showToast()`), but the actual PowerShell spawn is gated on
 * `process.platform === "win32"` at the toast call site. On non-Windows
 * platforms `showToast()` is never reached, so no process is ever
 * spawned.
 *
 * Lifecycle:
 *   - First `showToast()` call spawns the process and queues the toast
 *   - Subsequent calls pipe directly to the warm stdin
 *   - If the process dies, the next `showToast()` respawns it
 *   - On stdin write failure, returns `false` so the caller can fall
 *     back to an in-app notification
 *   - `dispose()` kills the process on extension deactivate
 */

/** PowerShell bootstrap script that loads WinRT assemblies once,
 * then enters a read-eval loop on stdin. Each input line is a
 * PowerShell expression that fires a toast. The loop exits when
 * stdin closes (extension deactivate). */
const BOOTSTRAP_SCRIPT = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
  'while ($line = [Console]::In.ReadLine()) { try { Invoke-Expression $line } catch {} }',
].join("; ");

/** Build the one-line PowerShell expression that fires a 3-line toast.
 * All user content is XML-escaped before interpolation. */
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
    '$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.VisualStudioCode")',
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

let proc: ChildProcess | null = null;

function ensureProcess(): ChildProcess | null {
  if (proc && !proc.killed && proc.stdin?.writable) return proc;

  // Clean up dead process
  if (proc) {
    try { proc.kill(); } catch { /* best-effort */ }
    proc = null;
  }

  try {
    proc = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      BOOTSTRAP_SCRIPT,
    ], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    proc.on("error", () => {
      proc = null;
    });
    proc.on("exit", () => {
      proc = null;
    });

    // The WinRT assembly loads take ~500ms on first spawn. The
    // process is usable immediately for queuing commands (PowerShell
    // buffers stdin while loading), but the first toast may still
    // have a slight delay. Every toast after that is near-instant.
    return proc;
  } catch {
    proc = null;
    return null;
  }
}

/** Fire a 3-line Windows toast via the warm PowerShell process.
 * Spawns the process on first call; subsequent calls are near-instant.
 * Returns `true` on successful stdin write, `false` if the process
 * could not be spawned or the write failed. The caller should treat
 * `false` as "Windows delivery failed" and fall back to an in-app
 * notification so the user still sees the event. */
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
    // stdin closed or process died - next call will respawn
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
