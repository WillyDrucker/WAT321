import * as vscode from "vscode";
import type { AppEvents, EventHub } from "./eventHub";
import { SETTING } from "./settingsKeys";
import { showToast as showWindowsToast } from "./windowsToastProcess";

/**
 * Toast notification delivery with configurable mode.
 *
 * Settings (under `wat321.notifications.*`):
 *   mode   - "Off" | "Auto" | "System Notifications" | "In-App"
 *   claude - per-provider filter (default true)
 *   codex  - per-provider filter (default true)
 *
 * Modes:
 *   Off                  - no delivery, no cycles
 *   Auto                 - system when editor unfocused, in-app when focused
 *   System Notifications - always native OS notifications
 *   In-App               - always in-editor notification bar
 *
 * Windows: system mode uses a warm PowerShell / WinRT toast (3-line
 * layout). On delivery failure (process died, stdin closed) the
 * notifier falls back to in-app so the user still sees the event.
 *
 * macOS / Linux: system mode delegates to
 * `vscode.window.showInformationMessage` which the OS notification
 * center routes natively when the editor is unfocused.
 *
 * Cooldown is per-provider so a Claude response does not suppress
 * a Codex notification that arrives seconds later. All recent
 * delivery decisions are retained in a ring buffer for the health
 * command.
 */

const NOTIFICATION_COOLDOWN_MS = 10_000;
const MAX_SESSION_TITLE_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 200;
const DIAGNOSTIC_RING_SIZE = 20;

const lastNotificationTime = new Map<string, number>();

export interface NotificationDiagnostic {
  at: number;
  provider: string;
  mode: string;
  delivered: "system" | "in-app" | "suppressed-cooldown" | "suppressed-provider" | "suppressed-off" | "windows-failed-fallback";
  focused: boolean;
}

const diagnostics: NotificationDiagnostic[] = [];

/** Snapshot of the last N delivery decisions for the health command. */
export function getNotificationDiagnostics(): readonly NotificationDiagnostic[] {
  return [...diagnostics];
}

function recordDiagnostic(entry: NotificationDiagnostic): void {
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

/** Deliver via the OS notification center. On Windows this is the
 * warm PowerShell / WinRT path. Returns true when the OS path
 * accepted the delivery, false on Windows stdin failure so the
 * caller can fall back. macOS / Linux always return true because
 * `showInformationMessage` routes through the OS automatically. */
function showSystemNotification(
  header: string,
  title: string,
  preview: string
): boolean {
  if (process.platform === "win32") {
    const sessionLine = title ? `\u201C${title}\u201D` : "";
    return showWindowsToast(header, sessionLine, preview || "response complete");
  }
  showInAppNotification(header, title, preview);
  return true;
}

function handleResponseComplete(
  payload: AppEvents["session.responseComplete"]
): void {
  const focused = vscode.window.state.focused;
  const mode = getMode();

  if (mode === "Off") {
    recordDiagnostic({ at: Date.now(), provider: payload.provider, mode, delivered: "suppressed-off", focused });
    return;
  }
  if (!isProviderEnabled(payload.provider)) {
    recordDiagnostic({ at: Date.now(), provider: payload.provider, mode, delivered: "suppressed-provider", focused });
    return;
  }

  const now = Date.now();
  const lastTime = lastNotificationTime.get(payload.provider) ?? 0;
  if (now - lastTime < NOTIFICATION_COOLDOWN_MS) {
    recordDiagnostic({ at: now, provider: payload.provider, mode, delivered: "suppressed-cooldown", focused });
    return;
  }
  lastNotificationTime.set(payload.provider, now);

  const title = truncateSessionTitle(payload.sessionTitle || null);
  const preview = truncatePreview(payload.responsePreview || null);
  const header = payload.label
    ? `${payload.displayName} (${payload.label})`
    : payload.displayName;

  // Resolve delivery path from the mode literally. The previous
  // behavior - where any unrecognized mode fell through to Auto -
  // masked stale workspace-scoped values (e.g. "Auto" left over from
  // the pre-v1.1.2 default) as random deliveries. Workspace-scope
  // heal is the durable fix; this literal branch keeps the surface
  // predictable even if a value slips through.
  const wantSystem =
    mode === "System Notifications" ||
    (mode === "Auto" && !focused);
  const wantInApp =
    mode === "In-App" ||
    (mode === "Auto" && focused);

  if (wantSystem) {
    const ok = showSystemNotification(header, title, preview);
    if (ok) {
      recordDiagnostic({ at: now, provider: payload.provider, mode, delivered: "system", focused });
      return;
    }
    // Windows path failed - fall back to in-app so the user still
    // sees the event instead of a silent drop.
    showInAppNotification(header, title, preview);
    recordDiagnostic({ at: now, provider: payload.provider, mode, delivered: "windows-failed-fallback", focused });
    return;
  }

  if (wantInApp) {
    showInAppNotification(header, title, preview);
    recordDiagnostic({ at: now, provider: payload.provider, mode, delivered: "in-app", focused });
    return;
  }

  // Unknown mode value. Treat as Off so we fail closed rather than
  // deliver through an unintended path.
  recordDiagnostic({ at: now, provider: payload.provider, mode, delivered: "suppressed-off", focused });
}

/** Subscribe the toast notifier to the engine's EventHub. Returns
 * a Disposable for cleanup. Called once from bootstrap. */
export function subscribeToNotifications(events: EventHub): vscode.Disposable {
  return events.on("session.responseComplete", handleResponseComplete);
}
