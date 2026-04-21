import * as vscode from "vscode";
import type { AppEvents, EventHub } from "./eventHub";
import {
  showInAppNotification,
  showSystemNotification,
} from "./notificationPlatforms";
import { SETTING } from "./settingsKeys";

/** Optional probe injected from bootstrap so the toast notifier can
 * skip Codex toasts while the Epic Handshake bridge is dispatching.
 * The engine never imports from a tool; this callback crosses that
 * boundary in the correct direction (bootstrap wires tool state in). */
let bridgeActiveProbe: (() => boolean) | null = null;

export function setBridgeActiveProbe(fn: (() => boolean) | null): void {
  bridgeActiveProbe = fn;
}

function isEpicHandshakeBridgeActive(): boolean {
  return bridgeActiveProbe?.() === true;
}

/** Optional consume-on-read probe. The dispatcher writes a one-shot
 * suppress-codex-toast sentinel on successful turn completion; this
 * consumer reads it once. Returning true means "the most recent Codex
 * activity was bridge-driven, suppress." Covers the gap where Codex's
 * transcript fires `responseComplete` more than 5s after the bridge's
 * `returning` flag has cleared (so `isEpicHandshakeBridgeActive` would
 * return false). */
let recentCodexCompletionConsumer: (() => boolean) | null = null;

export function setRecentCodexCompletionConsumer(
  fn: (() => boolean) | null
): void {
  recentCodexCompletionConsumer = fn;
}

function consumeRecentBridgeCompletion(): boolean {
  return recentCodexCompletionConsumer?.() === true;
}

function isCodexToastSuppressionEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.epicHandshakeSuppressCodexToasts, true);
}

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
 *     Requires a registered AppUserModelID. Resolved in-process by
 *     the warm PowerShell bootstrap via `Get-StartApps` keyed on
 *     `vscode.env.appName` that extension.ts hands in at activation.
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
  | "suppressed-unknown-mode"
  | "suppressed-epic-handshake";

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
  // Epic Handshake bridge suppression: when a prompt is in flight or
  // just completed, Codex's transcript updates trigger its normal
  // "response complete" toast at roughly the same moment Claude's tool
  // result flows back and fires its own toast. The user only wanted
  // the Claude toast in that case - two toasts about the same event
  // is noise. Two suppression sources, in priority order:
  //   1. Bridge currently active (in-flight or 5s returning latch).
  //   2. Recent bridge completion sentinel - one-shot, consume-on-read,
  //      30s freshness window. Covers slow Codex transcript writes that
  //      land after the returning latch has cleared.
  // Claude toasts are never suppressed, and Codex toasts fire normally
  // when the user is working in Codex independently of the bridge.
  if (
    payload.provider === "codex" &&
    isCodexToastSuppressionEnabled() &&
    (isEpicHandshakeBridgeActive() || consumeRecentBridgeCompletion())
  ) {
    record({ ...baseDiag, outcome: "suppressed-epic-handshake" });
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
