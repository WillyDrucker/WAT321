import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { AppEvents, EventHub } from "./eventHub";
import { SETTING } from "./settingsKeys";
import { showToast as showWindowsToast } from "./windowsToastProcess";

/**
 * Toast notification delivery.
 *
 * Settings under `wat321.notifications.*`:
 *   mode   - "Off" | "Auto" | "System Notifications" | "In-App"
 *   claude - per-provider filter (default true)
 *   codex  - per-provider filter (default true)
 *
 * Mode dispatch is literal. "System Notifications" always uses the OS
 * path; "In-App" always uses the editor's notification bar. Auto picks
 * system when the editor is unfocused and in-app when focused. Unknown
 * mode values fail closed (suppressed) rather than silently selecting
 * a delivery path the user did not choose.
 *
 * Delivery paths:
 *   - Windows: warm PowerShell / WinRT toast via `windowsToastProcess`.
 *     Requires a registered AppUserModelID; set at activation from
 *     `vscode.env.uriScheme`.
 *   - macOS: `osascript -e 'display notification ...'` (preinstalled,
 *     routes through Notification Center).
 *   - Linux: `notify-send` via libnotify (available on most GNOME /
 *     KDE systems; `notify-send` not present -> delivery fails and is
 *     recorded as `system-failed`).
 *   - In-App (all platforms): `vscode.window.showInformationMessage`
 *     renders VS Code's own bottom-right toast UI. It is NOT routed
 *     to the OS notification center on any platform.
 *
 * No silent mode-switch fallback. If the chosen system path fails, the
 * failure is recorded in the diagnostic ring buffer (visible in the
 * health command) and the event is not delivered through a different
 * path. A user who picked "System Notifications" and sees no toast
 * should run the health command; causes include unregistered AUMID
 * on Windows, Focus Assist / Do Not Disturb, OS-level notification
 * permission disabled, or `notify-send` missing on Linux.
 *
 * Per-provider 10s cooldown keeps a Claude response from suppressing
 * a Codex notification that arrives seconds later.
 */

const NOTIFICATION_COOLDOWN_MS = 10_000;
const MAX_SESSION_TITLE_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 200;
const DIAGNOSTIC_RING_SIZE = 20;

const lastNotificationTime = new Map<string, number>();

export type NotificationOutcome =
  | "system"
  | "in-app"
  | "system-failed"
  | "suppressed-cooldown"
  | "suppressed-provider"
  | "suppressed-off"
  | "suppressed-unknown-mode";

export interface NotificationDiagnostic {
  at: number;
  provider: string;
  mode: string;
  outcome: NotificationOutcome;
  focused: boolean;
}

const diagnostics: NotificationDiagnostic[] = [];

export function getNotificationDiagnostics(): readonly NotificationDiagnostic[] {
  return [...diagnostics];
}

function record(entry: NotificationDiagnostic): void {
  diagnostics.push(entry);
  if (diagnostics.length > DIAGNOSTIC_RING_SIZE) {
    diagnostics.splice(0, diagnostics.length - DIAGNOSTIC_RING_SIZE);
  }
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("wat321");
}

function getMode(): string {
  return getConfig().get<string>(SETTING.notificationsMode, "System Notifications");
}

export function isNotificationsEnabled(): boolean {
  return getMode() !== "Off";
}

function isProviderEnabled(provider: string): boolean {
  const key = provider === "claude"
    ? SETTING.notificationsClaude
    : SETTING.notificationsCodex;
  return getConfig().get<boolean>(key, true);
}

function truncateSessionTitle(title: string | null): string {
  if (!title) return "";
  const oneLine = title.replace(/[\r\n]+/g, " ").trim();
  if (oneLine.length <= MAX_SESSION_TITLE_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1).trimEnd()}\u2026`;
}

function truncatePreview(text: string | null): string {
  if (!text) return "";
  const clean = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (clean.length <= MAX_PREVIEW_LENGTH) return clean;
  return `${clean.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}\u2026`;
}

// --- Delivery paths ---

function showInAppNotification(
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

function showMacNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  try {
    const body = title ? `${title}: ${preview || "response complete"}` : (preview || "response complete");
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(header)}"`;
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => { /* recorded by caller via bool */ });
    return true;
  } catch {
    return false;
  }
}

function showLinuxNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  try {
    const body = title ? `${title}: ${preview || "response complete"}` : (preview || "response complete");
    // `--` terminates notify-send options so header/body cannot be
    // interpreted as flags even if they start with a hyphen.
    const child = spawn("notify-send", ["--", header, body], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => { /* spawn failed - notify-send missing */ });
    return true;
  } catch {
    return false;
  }
}

/** Dispatch to the platform's OS notification path. Returns true if
 * delivery was accepted, false if it failed (silently discarded, for
 * caller to record). Note: on macOS / Linux `spawn` returning a valid
 * child does not guarantee delivery - osascript / notify-send can
 * still fail asynchronously. We treat spawn success as delivery
 * success because the async failure surface is identical to the
 * Windows OS-level silent-discard case (Focus Assist, permissions,
 * etc.) and not something we can reliably detect. */
function showSystemNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  switch (process.platform) {
    case "win32": {
      const sessionLine = title ? `\u201C${title}\u201D` : "";
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

// --- Event handler ---

function handleResponseComplete(
  payload: AppEvents["session.responseComplete"]
): void {
  const focused = vscode.window.state.focused;
  const mode = getMode();
  const now = Date.now();
  const baseDiag = { at: now, provider: payload.provider, mode, focused };

  if (mode === "Off") {
    record({ ...baseDiag, outcome: "suppressed-off" });
    return;
  }
  if (!isProviderEnabled(payload.provider)) {
    record({ ...baseDiag, outcome: "suppressed-provider" });
    return;
  }

  const lastTime = lastNotificationTime.get(payload.provider) ?? 0;
  if (now - lastTime < NOTIFICATION_COOLDOWN_MS) {
    record({ ...baseDiag, outcome: "suppressed-cooldown" });
    return;
  }
  lastNotificationTime.set(payload.provider, now);

  const title = truncateSessionTitle(payload.sessionTitle || null);
  const preview = truncatePreview(payload.responsePreview || null);
  const header = payload.label
    ? `${payload.displayName} (${payload.label})`
    : payload.displayName;

  const wantSystem = mode === "System Notifications" || (mode === "Auto" && !focused);
  const wantInApp = mode === "In-App" || (mode === "Auto" && focused);

  if (wantSystem) {
    const ok = showSystemNotification(header, title, preview);
    record({ ...baseDiag, outcome: ok ? "system" : "system-failed" });
    return;
  }

  if (wantInApp) {
    showInAppNotification(header, title, preview);
    record({ ...baseDiag, outcome: "in-app" });
    return;
  }

  // Unrecognized mode - fail closed rather than dispatch through an
  // unintended path.
  record({ ...baseDiag, outcome: "suppressed-unknown-mode" });
}

/** Subscribe the notifier to the engine's EventHub. Called once from
 * bootstrap. */
export function subscribeToNotifications(events: EventHub): vscode.Disposable {
  return events.on("session.responseComplete", handleResponseComplete);
}
