import * as vscode from "vscode";
import { logNotifEvent } from "../shared/diag/notifEventLog";
import { tryClaimNotification } from "../shared/notification/multiWindowDedup";
import type { ProviderKey } from "./contracts";
import type { AppEvents, EventHub } from "./eventHub";
import {
  showInAppNotification,
  showSystemNotification,
} from "./notificationPlatforms";
import { SETTING } from "./settingsKeys";

/**
 * Toast notification delivery.
 *
 * Settings under `wat321.notifications.*`:
 *   mode   - "Off" | "Auto" | "System Notifications" | "In-App"
 *   claude - per-provider filter (default true)
 *   codex  - per-provider filter (default true)
 *
 * Mode dispatch is literal. "System Notifications" always uses the OS
 * path - "In-App" always uses the editor's notification bar. Auto picks
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
 *     KDE systems - `notify-send` not present -> delivery fails and is
 *     recorded as `system-failed`).
 *   - In-App (all platforms): `vscode.window.showInformationMessage`
 *     renders VS Code's own bottom-right toast UI. It is NOT routed
 *     to the OS notification center on any platform.
 *
 * No silent mode-switch fallback. If the chosen system path fails, the
 * failure is recorded in the diagnostic ring buffer (visible in the
 * health command) and the event is not delivered through a different
 * path. A user who picked "System Notifications" and sees no toast
 * should run the health command - causes include unregistered AUMID
 * on Windows, Focus Assist / Do Not Disturb, OS-level notification
 * permission disabled, or `notify-send` missing on Linux.
 *
 * Per-(provider, sessionId) 10s cooldown so distinct sessions can fire
 * concurrent toasts - the same session repeating within 10s collapses.
 */

const NOTIFICATION_COOLDOWN_MS = 10_000;
const MAX_SESSION_TITLE_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 200;
const DIAGNOSTIC_RING_SIZE = 20;

const lastNotificationTime = new Map<string, number>();

function cooldownKey(provider: string, sessionId: string): string {
  return `${provider}::${sessionId}`;
}

export type NotificationOutcome =
  | "system"
  | "in-app"
  | "system-failed"
  | "suppressed-cooldown"
  | "suppressed-provider"
  | "suppressed-off"
  | "suppressed-unknown-mode"
  | "suppressed-multi-window";

export interface NotificationDiagnostic {
  at: number;
  provider: ProviderKey;
  mode: string;
  outcome: NotificationOutcome;
  focused: boolean;
  /** Per-session UUID of the response being delivered. Empty when
   * the dispatch context has no session id (defensive - every
   * current call site populates this from the payload). */
  sessionId: string;
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
  // Mirror to disk so a post-mortem after a VS Code restart still
  // sees the decision. The in-memory ring above survives only until
  // the extension reloads, while the JSONL log persists across
  // reloads and is the load-bearing surface for "the notification
  // didn't fire two hours ago, what happened" debugging.
  logNotifEvent({
    at: entry.at,
    kind: "notifier-decision",
    provider: entry.provider,
    sessionId: entry.sessionId,
    mode: entry.mode,
    outcome: entry.outcome,
    focused: entry.focused,
  });
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
  const baseDiag = {
    at: now,
    provider: payload.provider,
    mode,
    focused,
    sessionId: payload.sessionId,
  };

  if (mode === "Off") {
    record({ ...baseDiag, outcome: "suppressed-off" });
    return;
  }
  if (!isProviderEnabled(payload.provider)) {
    record({ ...baseDiag, outcome: "suppressed-provider" });
    return;
  }
  const ckey = cooldownKey(payload.provider, payload.sessionId);
  const lastTime = lastNotificationTime.get(ckey) ?? 0;
  if (now - lastTime < NOTIFICATION_COOLDOWN_MS) {
    record({ ...baseDiag, outcome: "suppressed-cooldown" });
    return;
  }

  // Cross-window dedup. Two VS Code windows on the same workspace
  // both watch the same transcripts and both bridges fire
  // responseComplete for the same completion. The dedup tag lets
  // exactly one window deliver the toast - bucketed completionMs
  // plus sessionId scope the claim to the right event, and `wx`
  // create guarantees one winner across windows. The single-window
  // case still wins the claim and proceeds normally.
  const dedup = tryClaimNotification(payload.sessionId, payload.completionMs);
  logNotifEvent({
    at: now,
    kind: "dedup-decision",
    provider: payload.provider,
    sessionId: payload.sessionId,
    completionBucket: dedup.bucket,
    claimed: dedup.claimed,
  });
  if (!dedup.claimed) {
    record({ ...baseDiag, outcome: "suppressed-multi-window" });
    return;
  }
  // Stamp cooldown only after winning the dedup race so a losing
  // window does not pollute its own cooldown map with a delivery it
  // never made.
  lastNotificationTime.set(ckey, now);

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
