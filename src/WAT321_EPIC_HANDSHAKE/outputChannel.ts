import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { bridgeStateDir } from "../shared/wat321Paths";
import type { EpicHandshakeLogger } from "./types";

/**
 * VS Code output-channel-backed implementation of
 * `EpicHandshakeLogger`. The one place in WAT321 where debug logging
 * is allowed - never `console.log` or any other side path.
 *
 * A JSON-RPC child process + event stream is harder to debug than
 * the pure-pull usage widgets, so we need a focused output channel.
 * Kept tiny on purpose and call sites strictly limited.
 *
 * What is logged:
 *   - spawn / exit of `codex app-server`
 *   - `initialize` success / failure
 *   - thread/start / resume transitions and recovery paths
 *   - message dispatch start / complete / fail (never bodies)
 *   - parse failures on mailbox files
 *   - channel install / uninstall actions
 *
 * What is NEVER logged: message bodies, streaming item deltas,
 * attachment contents, auth details.
 *
 * Error-level lines also tee to disk under `bridgeStateDir()` as
 * `errors.log` so a post-mortem can recover the lower-layer failure
 * cause after the output channel is disposed. info / warn stay
 * channel-only to keep noise down on the persistent surface.
 */

const CHANNEL_NAME = "WAT321 Epic Handshake";

/** Disk tee for error-level entries. Bounded rolling log: every
 * append is followed by a size check that truncates from the head
 * when the cap is exceeded so disk usage stays bounded even under
 * a runaway error loop. Mirrors the pattern in
 * `src/WAT321_MCP_SERVER/bin/channel.mjs`.
 *
 * Raw `writeFileSync` is intentional here, not a miss against the
 * `shared/fs/atomicWrite.ts:writeFileAtomic` invariant: this is an
 * append-only log. `writeFileAtomic` writes a tmp file and renames
 * over the target, which would clobber the entire prior log on every
 * single append. The append path uses `{ flag: "a" }` so concurrent
 * writers in sibling VS Code windows interleave cleanly at the line
 * boundary instead of stomping each other. The head-truncate rewrite
 * is deliberately non-atomic too: a partial rewrite at most loses a
 * tail of bounded length, never the whole file's worth of context. */
const ERROR_LOG_MAX_BYTES = 1_000_000;
function appendErrorToDisk(line: string): void {
  try {
    const path = join(bridgeStateDir(), "errors.log");
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, line, { flag: "a" });
    try {
      const stat = readFileSync(path, "utf8");
      if (stat.length > ERROR_LOG_MAX_BYTES) {
        writeFileSync(path, stat.slice(-ERROR_LOG_MAX_BYTES));
      }
    } catch {
      // best-effort
    }
  } catch {
    // best-effort - a missed disk write is not worth disrupting the
    // foreground logger surface
  }
}

/** Create an `EpicHandshakeLogger` backed by a VS Code
 * `OutputChannel`. Returns the logger and a `dispose` helper so the
 * caller can release the channel on extension deactivate without
 * handing out the raw channel object. */
export function createOutputChannelLogger(): {
  logger: EpicHandshakeLogger;
  dispose: () => void;
} {
  const channel = vscode.window.createOutputChannel(CHANNEL_NAME);

  const stamp = (): string => {
    const now = new Date();
    const pad = (n: number): string => n.toString().padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
      now.getSeconds()
    )}.${now.getMilliseconds().toString().padStart(3, "0")}`;
  };

  const logger: EpicHandshakeLogger = {
    info(message: string): void {
      channel.appendLine(`${stamp()} [info ] ${message}`);
    },
    warn(message: string): void {
      channel.appendLine(`${stamp()} [warn ] ${message}`);
    },
    error(message: string): void {
      const line = `${stamp()} [error] ${message}`;
      channel.appendLine(line);
      // Tee error-level lines to disk so post-mortems on a wedge or
      // a lost-reply chain can recover the lower-layer cause from
      // disk after the output channel is closed. ISO timestamp up
      // front so a grep across the file lines up with the inbox file
      // mtimes in the bridge state dir.
      appendErrorToDisk(`[${new Date().toISOString()}] ${message}\n`);
    },
    show(): void {
      channel.show(true);
    },
  };

  active = logger;
  return {
    logger,
    dispose: () => {
      active = null;
      channel.dispose();
    },
  };
}

/** Swallows everything. Used before activate and after dispose so
 * `epicHandshakeLogger()` never hands back null. */
const SILENT: EpicHandshakeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

let active: EpicHandshakeLogger | null = null;

/** The live logger, for the few call sites too deep in the menu chain
 * to have one threaded to them (the Codex Defaults picker, which may
 * populate the model catalog when it opens). Not a general escape
 * hatch: prefer an injected logger wherever the wiring already reaches. */
export function epicHandshakeLogger(): EpicHandshakeLogger {
  return active ?? SILENT;
}
