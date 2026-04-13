import type { DisarmReason } from "./service";

/**
 * User-facing message strings for Claude Force Auto-Compact. Pulled
 * out of the widget file so the widget can stay focused on state
 * dispatch.
 */

/** Notification text for each automatic disarm reason. Returns `null`
 * for reasons that should not surface a notification (e.g. user-cancel
 * where the user already knows). */
export function formatDisarmMessage(reason: DisarmReason | null): string | null {
  switch (reason) {
    case "compact-detected":
      return "Auto-compact fired. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
    case "timeout":
      return "Claude Force Auto-Compact timed out. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored - no compact fired.";
    case "session-ended":
      return "Target Claude session ended before compact fired. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
    case "session-switched":
      return "Claude session switched while Claude Force Auto-Compact was armed. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
    default:
      return null;
  }
}

/** Error notification for each `arm()` refusal reason. */
export function formatArmErrorMessage(reason: string): string {
  switch (reason) {
    case "sentinel-exists":
      return "A Claude Force Auto-Compact sentinel already exists at ~/.wat321/claude-force-auto-compact-sentinel.json. Another WAT321 instance may have armed it, or a previous run left it behind. Wait for the other instance, or check the file manually.";
    case "already-armed-value":
      return 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is already set to 1 in ~/.claude/settings.json. WAT321 refuses to treat 1 as the original value. Run "WAT321: Reset All Settings" (or reload the extension) - the built-in failsafe will restore the override to Claude\'s default, then you can try again.';
    case "settings-missing":
      return "~/.claude/settings.json does not exist. Claude Force Auto-Compact needs an existing Claude settings file to back up and restore.";
    default:
      return "Failed to arm Claude Force Auto-Compact. Check that ~/.claude/settings.json exists and is writable.";
  }
}
