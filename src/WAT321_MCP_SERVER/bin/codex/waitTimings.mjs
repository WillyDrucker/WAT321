/**
 * Timing constants for Codex reply waits. Adaptive considers a turn
 * alive while the dispatcher's turn heartbeat is fresher than
 * ADAPTIVE_STALE_MS and aborts cleanly once the gap exceeds that,
 * much earlier than a flat timeout when Codex has genuinely hung. The
 * hard ceiling protects against pathological loops where the
 * dispatcher keeps emitting progress forever.
 */

export const POLL_INTERVAL_MS = 500;
export const ADAPTIVE_STALE_MS = 120_000;
export const ADAPTIVE_HARD_CEILING_MS = 30 * 60_000;
export const ADAPTIVE_DEFAULT_CEILING_MS = 10 * 60_000;

/** Fire-and-forget safety cap. The happy path returns sub-100ms
 * (envelope write + immediate return). This race exists as a
 * defensive belt against any future regression that lets the FF
 * branch fall through to a wait. Adaptive and standard dispatches are
 * intentionally not capped here, since long waits there are expected
 * and bounded by `timeout_sec`.
 *
 * Limitation: the dispatch I/O is sync (`writeFileSync`, `renameSync`,
 * `existsSync`). A truly pathological FS hang would block the whole
 * event loop and prevent the timer from firing anyway, so the race is
 * structural insurance against future code shape changes, not a
 * defense against current sync-FS blocking. */
export const FF_SAFETY_CAP_MS = 60_000;
