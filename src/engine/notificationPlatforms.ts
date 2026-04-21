import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { showToast as showWindowsToast } from "./windowsToastProcess";

/**
 * Platform-specific notification delivery paths split out of
 * `toastNotifier.ts` so the dispatch logic (cooldown, mode, provider
 * gating, suppression) stays readable end-to-end. No state lives
 * here - each function takes a header/title/preview and returns a
 * delivery success bool.
 *
 * Windows: warm PowerShell / WinRT toast via `windowsToastProcess`.
 * macOS: `osascript -e 'display notification ...'` (preinstalled).
 * Linux: `notify-send` via libnotify.
 * In-App (any platform): `vscode.window.showInformationMessage`.
 *
 * `showSystemNotification` returns false when the OS path failed to
 * even spawn; on macOS/Linux a spawn-success does not guarantee user
 * visibility (Focus Assist, missing notify-send, permissions) - the
 * notifier records the outcome the same way regardless.
 */

export function showInAppNotification(
  header: string,
  title: string,
  preview: string
): void {
  const message = title
    ? `${header} "${title}": ${preview || "response complete"}`
    : `${header}: ${preview || "response complete"}`;
  void vscode.window.showInformationMessage(message);
}

/** Escape for an AppleScript double-quoted string. AppleScript uses
 * `\"` for quote and `\\` for backslash inside `"..."`. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Tracks recent async spawn failures by binary name so the next
 * synchronous `showSystemNotification` call returns `false` honestly
 * after we have observed the OS path is broken. Without this the
 * caller records `system` for every fire-and-forget `notify-send`
 * even when the binary is missing - the bool return is synchronous
 * but the spawn `'error'` event arrives asynchronously. The first
 * call still over-reports; every call after that records correctly.
 * Map cleared by manual reset only; in practice the user installs
 * `notify-send` (or fixes Mac permissions) once and the entry stays
 * stale, which is fine - a real fix path on the user side does not
 * regress the next-call accuracy. */
const asyncSpawnFailures = new Set<string>();

function showMacNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  if (asyncSpawnFailures.has("osascript")) return false;
  try {
    const body = title ? `${title}: ${preview || "response complete"}` : (preview || "response complete");
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(header)}"`;
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    // Async error path - osascript missing or unavailable surfaces
    // here, not as a sync throw. Mark the binary failed so the next
    // call reports `system-failed` instead of a phantom `system`.
    child.on("error", () => {
      asyncSpawnFailures.add("osascript");
    });
    return true;
  } catch {
    asyncSpawnFailures.add("osascript");
    return false;
  }
}

function showLinuxNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  if (asyncSpawnFailures.has("notify-send")) return false;
  try {
    const body = title ? `${title}: ${preview || "response complete"}` : (preview || "response complete");
    // `--` terminates notify-send options so header/body cannot be
    // interpreted as flags even if they start with a hyphen.
    const child = spawn("notify-send", ["--", header, body], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    // Async error path - `notify-send` missing on this system
    // surfaces here. Mark failed so the next call records correctly
    // instead of over-reporting `system` for a binary that is not
    // installed.
    child.on("error", () => {
      asyncSpawnFailures.add("notify-send");
    });
    return true;
  } catch {
    asyncSpawnFailures.add("notify-send");
    return false;
  }
}

export function showSystemNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  switch (process.platform) {
    case "win32": {
      const sessionLine = title ? `“${title}”` : "";
      return showWindowsToast(header, sessionLine, preview || "response complete");
    }
    case "darwin":
      return showMacNotification(header, title, preview);
    case "linux":
      return showLinuxNotification(header, title, preview);
    default:
      return false;
  }
}
