/**
 * The caller's `timeout_sec` on `wat321_ask`, resolved the same way
 * for every target: a finite number wins, otherwise the default, and
 * the millisecond form never drops below the floor so a typo like
 * `timeout_sec: 0` cannot turn into an instant timeout.
 */

const DEFAULT_TIMEOUT_SEC = 120;
export const MIN_TIMEOUT_MS = 5_000;

export function requestedTimeoutSec(args, defaultSec = DEFAULT_TIMEOUT_SEC) {
  return typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
    ? args.timeout_sec
    : defaultSec;
}

export function timeoutMsFor(timeoutSec) {
  return Math.max(MIN_TIMEOUT_MS, timeoutSec * 1000);
}
