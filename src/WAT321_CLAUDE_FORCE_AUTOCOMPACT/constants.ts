/**
 * Centralized policy values for the Claude Force Auto-Compact
 * tool. Every timing window, threshold, and cooldown lives here
 * so a future reader can scan one file to learn what knobs the
 * tool exposes. Implementation files import from this module
 * rather than defining their own private constants.
 *
 * Protocol values that are not policy knobs (e.g. the literal
 * "1" override value, the JSONL tail scan size) stay with their
 * owning module because they are tied to the format, not to a
 * tunable behavior.
 */

/** Fast poll interval for active states (armed, cooldown watcher).
 * Must be short so we catch the compact marker within the timeout
 * window and react to stray compacts promptly. */
export const ACTIVE_POLL_INTERVAL_MS = 2_000;

/** Slow poll interval for idle states (ready, unavailable). The
 * widget also gets effective ~5 s refresh rate for free via the
 * session token service piggyback (widget calls
 * `snapCheckAvailability` on every Claude token update). This
 * slower interval is the background safety net for cases where
 * the session token service is not running. */
export const IDLE_POLL_INTERVAL_MS = 15_000;

/** Armed-state failsafe. 30 seconds is the unified safety net
 * for every "nothing happened" scenario: user armed by mistake,
 * user switched sessions, user walked away, Claude was mid-tool-call
 * and the user armed by accident, etc. If no compact marker appears
 * within this window, we restore regardless of the reason. Also
 * documented as "Automatically disarms in 30 seconds of no activity"
 * in the arm confirm dialog. */
export const TIMEOUT_MS = 30_000;

/** How long the widget shows the transient "restored" flash before
 * auto-returning to ready. Cosmetic only. */
export const RESTORED_DISPLAY_MS = 3_000;

/** How long to keep watching after a successful compact-detected
 * disarm. Long enough to see a second compact fire on the next
 * Claude turn, short enough that we are not holding the fast poll
 * cadence open indefinitely. */
export const POST_DISARM_COOLDOWN_MS = 30_000;

/** Backoff between automatic heal attempts for
 * `settings-stuck-at-armed`. First detection auto-heals
 * immediately; if something overwrites our safe value inside this
 * window, we do NOT auto-heal again. Click-to-repair bypasses
 * this cooldown. */
export const HEAL_RETRY_COOLDOWN_MS = 5 * 60_000;

/** Minimum context usage (as a fraction of the user's auto-compact
 * ceiling) required to arm. Below this the button grays out with
 * a `below-useful-threshold` tooltip explaining where the user is
 * and where the activation point sits. */
export const USEFUL_CONTEXT_FRACTION = 0.20;

/** Window used by the secondary loop-detection backup. When 2+
 * compact markers are visible in the tail AND the file mtime is
 * within this window, treat it as "clustered in time" and refuse
 * arm. Loose signal; the primary context gate does the real work. */
export const LOOP_WINDOW_MS = 2 * 60_000;

/** Window used by the `claude-busy` gate. If the transcript was
 * written within this window AND the last JSONL entry is a user
 * message or an assistant with unresolved tool_use, treat Claude
 * as mid-turn and refuse to arm. A dormant session whose last
 * entry happens to be a stale user message from long ago does
 * NOT block arming. Auto-clears the moment the tail flips to
 * `assistant-done`. */
export const CLAUDE_BUSY_WINDOW_MS = 60_000;
