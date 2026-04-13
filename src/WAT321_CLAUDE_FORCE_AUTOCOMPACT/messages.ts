import type { DisarmReason } from "./service";

/**
 * User-facing message strings for Claude Force Auto-Compact. Pulled
 * out of the widget file so the widget can stay focused on state
 * dispatch. `arm()` refusal messages now come directly from the
 * preflight gate (`preflightGate.ts`) so they can include dynamic
 * "try again in ~Ns" hints - this module no longer hand-rolls
 * arm-error strings.
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
