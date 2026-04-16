import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { AppEvents, EventHub } from "./eventHub";
import { SETTING } from "./settingsKeys";

/**
 * Toast notification system with configurable delivery modes.
 *
 * Settings (all under `wat321.notifications.*`):
 *   mode   - "Off" | "Auto" | "System Notifications" | "In-App"
 *   claude - per-provider filter (default true)
 *   codex  - per-provider filter (default true)
 *
 * Modes:
 *   Off                  - no notifications, no cycles consumed
 *   Auto                 - system when editor unfocused, in-app when focused
 *   System Notifications - always native OS notifications
 *   In-App               - always in-editor notification bar
 *
 * On Windows, system notifications use the WinRT API via
 * PowerShell with a 3-line layout (provider header, session
 * title, response preview). On macOS / Linux, system mode uses
 * `showInformationMessage` which routes through the OS
 * notification center automatically.
 */

// Cooldown is keyed by provider so Claude finishing doesn't
// suppress a Codex notification that arrives seconds later.
const lastNotificationTime = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 10_000;
const MAX_SESSION_TITLE_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 200;

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("wat321");
}

function getMode(): string {
  return getConfig().get<string>(SETTING.notificationsMode, "Auto");
}

/** True when the mode is anything other than Off. Used by the
 * notification handler and the bootstrap bridge to skip response
 * preview parsing when notifications are disabled. */
export function isNotificationsEnabled(): boolean {
  return getMode() !== "Off";
}

function isProviderEnabled(provider: string): boolean {
  const key = provider === "claude"
    ? SETTING.notificationsClaude
    : SETTING.notificationsCodex;
  return getConfig().get<boolean>(key, true);
}

/** Truncate a session title for the toast header. */
function truncateSessionTitle(title: string | null): string {
  if (!title) return "";
  const oneLine = title.replace(/[\r\n]+/g, " ").trim();
  if (oneLine.length <= MAX_SESSION_TITLE_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1).trimEnd()}\u2026`;
}

/** Clean and truncate response text for the toast body. Collapses
 * whitespace runs and caps at a length that fits comfortably in
 * a Windows toast (~4 visible lines). */
function truncatePreview(text: string | null): string {
  if (!text) return "";
  const clean = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (clean.length <= MAX_PREVIEW_LENGTH) return clean;
  return `${clean.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}\u2026`;
}

// --- Windows native toast via WinRT ---

/** Escape the five XML predefined entities. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Fire a 3-line Windows system toast. Uses PowerShell's
 * `-EncodedCommand` to avoid shell-escaping issues with user
 * content. Fire-and-forget with a 5-second timeout. */
function showWindowsToast(
  headerLine: string,
  sessionLine: string,
  previewLine: string
): void {
  const h = escapeXml(headerLine);
  const s = escapeXml(sessionLine);
  const p = escapeXml(previewLine);

  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${h}</text><text>${s}</text><text>${p}</text></binding></visual></toast>')`,
    '$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.VisualStudioCode")',
    "$t = New-Object Windows.UI.Notifications.ToastNotification($x)",
    "$n.Show($t)",
  ].join("\n");

  // Base64-encode as UTF-16LE for PowerShell's -EncodedCommand.
  // This avoids all shell-escaping hazards with user-generated
  // content (session titles, response text) that could contain
  // quotes, dollar signs, or other PowerShell metacharacters.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { timeout: 5000 },
    () => {} // fire-and-forget, errors silently ignored
  );
}

// --- Delivery logic ---

/** Show via the editor's in-app notification bar. */
function showInAppNotification(
  header: string,
  title: string,
  preview: string
): void {
  const message = title
    ? `${header} "${title}": ${preview || "response complete"}`
    : `${header}: ${preview || "response complete"}`;
  vscode.window.showInformationMessage(message);
}

/** Show via OS-level system notification. On Windows uses WinRT
 * for a rich 3-line toast. On macOS / Linux falls back to
 * `showInformationMessage` which routes through the OS
 * notification center natively. */
function showSystemNotification(
  header: string,
  title: string,
  preview: string
): void {
  if (process.platform === "win32") {
    // Windows gets the rich 3-line toast: bold header, session
    // title in curly quotes, response preview body.
    const sessionLine = title ? `\u201C${title}\u201D` : "";
    showWindowsToast(header, sessionLine, preview || "response complete");
  } else {
    // macOS / Linux: showInformationMessage routes through the
    // OS notification center when VS Code is unfocused.
    showInAppNotification(header, title, preview);
  }
}

// --- Public API ---

/** Handle a single `session.responseComplete` event. All gating
 * (master switch, per-provider filter, cooldown) lives here so
 * the emitter is completely notification-unaware. */
function handleResponseComplete(
  payload: AppEvents["session.responseComplete"]
): void {
  if (!isNotificationsEnabled()) return;
  if (!isProviderEnabled(payload.provider)) return;

  const now = Date.now();
  const lastTime = lastNotificationTime.get(payload.provider) ?? 0;
  if (now - lastTime < NOTIFICATION_COOLDOWN_MS) return;
  lastNotificationTime.set(payload.provider, now);

  const displayName = payload.displayName;
  const title = truncateSessionTitle(payload.sessionTitle || null);
  const preview = truncatePreview(payload.responsePreview || null);
  const header = payload.label
    ? `${displayName} (${payload.label})`
    : displayName;

  const mode = getMode();
  if (mode === "In-App") {
    showInAppNotification(header, title, preview);
  } else if (mode === "System Notifications") {
    showSystemNotification(header, title, preview);
  } else {
    // Auto: system when unfocused, in-app when focused
    if (vscode.window.state.focused) {
      showInAppNotification(header, title, preview);
    } else {
      showSystemNotification(header, title, preview);
    }
  }
}

/** Subscribe the toast notifier to the engine's EventHub.
 * Returns a Disposable for cleanup. Called once from bootstrap. */
export function subscribeToNotifications(events: EventHub): vscode.Disposable {
  return events.on("session.responseComplete", handleResponseComplete);
}
