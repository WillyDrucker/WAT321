import {
  CompactFlashMachine,
  type CompactFlashSnapshot,
} from "../shared/polling/compactFlashMachine";
import { parseRecentCompactBoundaries } from "./turnInfoParser";

/**
 * Claude-tier adapter over the shared `CompactFlashMachine`.
 *
 * Architecture constraint. Claude Code buffers the `<command-name>/
 * compact</command-name>` user entry until the compact completes.
 * Auto-compact never writes any pre-completion entry at all. The only
 * observable signal is the structured `type:"system",
 * subtype:"compact_boundary"` entry at the end of the operation, so the
 * display is end-only: on a fresh boundary, fire a brief completion
 * flash - otherwise idle. Live in-flight detection would require
 * writing into `~/.claude/`, outside WAT321's contract.
 *
 * This adapter owns the Claude-specific parsing: it reads the boundary
 * entries from the tail, maps `trigger` to the flash hold (manual is
 * held longer than auto since the user is actively watching after
 * typing `/compact`), and supplies the real `durationMs` history for
 * the health-command estimate. All state transition + dedupe + session-
 * attach logic lives in the shared machine.
 */

/** How many recent compact durations to average for the health
 * command's diagnostic. */
const HISTORICAL_WINDOW = 3;
/** Flash hold for trigger:"auto" boundaries. Auto-compact lands
 * without warning - a brief beat is enough acknowledgment. */
const AUTO_COMPACT_FLASH_MS = 1_500;
/** Flash hold for trigger:"manual" boundaries. Manual is user-typed -
 * they're actively watching, so hold a little longer. */
const MANUAL_COMPACT_FLASH_MS = 2_500;

export class CompactStateMachine {
  private readonly core = new CompactFlashMachine();

  /** Parse the Claude tail into a normalized observation and fold it
   * into the shared machine. Public signature matches what the
   * service / widget call, so neither needs edits. */
  sync(args: { tail: string; sessionId: string; now: number }): CompactFlashSnapshot {
    const { tail, sessionId, now } = args;
    const recent = parseRecentCompactBoundaries(tail, HISTORICAL_WINDOW);
    const newest = recent.length > 0 ? recent[recent.length - 1] : null;
    return this.core.sync({
      sessionId,
      now,
      observation: {
        newestBoundaryAt: newest ? newest.at : null,
        flashDurationMs:
          newest && newest.trigger === "manual"
            ? MANUAL_COMPACT_FLASH_MS
            : AUTO_COMPACT_FLASH_MS,
        recentDurationsMs: recent.map((b) => b.durationMs),
      },
    });
  }

  reset(): void {
    this.core.reset();
  }

  getDiagnostics(): ReturnType<CompactFlashMachine["getDiagnostics"]> {
    return this.core.getDiagnostics();
  }
}
