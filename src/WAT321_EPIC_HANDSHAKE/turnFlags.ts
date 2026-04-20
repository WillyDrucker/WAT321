import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import {
  IN_FLIGHT_FLAG_PATH,
  PROCESSING_FLAG_PATH,
  RETURNING_FLAG_PATH,
} from "./constants";

/**
 * Flag files the dispatcher writes during a Codex turn so the status
 * bar (a different process boundary concern: extension window vs
 * background dispatcher) can render the right animation without
 * needing a direct event channel.
 *
 *   in-flight.flag   - present from turn dispatch start until clear
 *   processing.flag  - present once Codex emits its first streaming
 *                      delta; cleared on turn completion/failure
 *   returning.flag   - written on success; auto-cleared 5000ms later
 *
 * All flags are best-effort. A missed write only costs a missed
 * animation frame; never block the turn on flag I/O.
 */

export function writeInFlightFlag(): void {
  try {
    writeFileSync(IN_FLIGHT_FLAG_PATH, new Date().toISOString(), "utf8");
  } catch {
    // best-effort; status bar will just miss the in-flight signal
  }
}

export function clearInFlightFlag(): void {
  try {
    if (existsSync(IN_FLIGHT_FLAG_PATH)) unlinkSync(IN_FLIGHT_FLAG_PATH);
  } catch {
    // best-effort
  }
}

export function writeProcessingFlag(): void {
  try {
    writeFileSync(PROCESSING_FLAG_PATH, new Date().toISOString(), "utf8");
  } catch {
    // best-effort
  }
}

export function clearProcessingFlag(): void {
  try {
    if (existsSync(PROCESSING_FLAG_PATH)) unlinkSync(PROCESSING_FLAG_PATH);
  } catch {
    // best-effort
  }
}

/** Write the returning flag and schedule its cleanup 5000ms later.
 * The unref'd timer lets the dispatcher shut down without waiting.
 * 5s visibility makes the arrow-circle-left animation easy to
 * notice - the physical reply transfer is sub-500ms, and a shorter
 * latch was easy to miss when glancing away during a long turn. */
export function writeReturningFlag(): void {
  try {
    writeFileSync(RETURNING_FLAG_PATH, new Date().toISOString(), "utf8");
    const t = setTimeout(() => {
      try {
        if (existsSync(RETURNING_FLAG_PATH)) unlinkSync(RETURNING_FLAG_PATH);
      } catch {
        // best-effort
      }
    }, 5_000);
    t.unref?.();
  } catch {
    // best-effort
  }
}
