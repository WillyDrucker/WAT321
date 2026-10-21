import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOutputChannelLogger } from "../engine/outputChannelLogger";
import { bridgeStateDir } from "../engine/wat321Paths";

/**
 * Logger for the Epic Handshake tier: the interface the JSON-RPC
 * client, dispatcher, and installer log through, and the output-
 * channel implementation behind it with an error tee to disk. Callers
 * depend on the interface only, so a test can inject a double. A
 * child process plus event stream is materially harder to debug than
 * the pure-pull usage widgets, so this tier logs more than the rest.
 *
 * Logged: spawn and exit of `codex app-server`, `initialize` success
 * or failure, thread start, resume, and recovery paths, dispatch
 * start, complete, and fail (never bodies), mailbox parse failures,
 * channel install and uninstall. Never logged: message bodies,
 * streaming item deltas, attachment contents, auth details.
 */
export interface EpicHandshakeLogger {
  /** Lifecycle / state transition events. */
  info(message: string): void;
  /** Expected recoverable conditions (retry, crash-and-respawn). */
  warn(message: string): void;
  /** Unexpected failures that need attention. */
  error(message: string): void;
  /** Reveal the output channel. Diagnostic UI paths (Delete All
   * "(0) - View details", Repair picker Force Repair) use it to
   * surface the scan breakdown a user just logged. */
  show(): void;
}

const CHANNEL_NAME = "WAT321: Epic Handshake";

/** Error-level lines also land in `errors.log` under the bridge state
 * dir so a post-mortem can recover the lower-layer cause after the
 * output channel is gone. Append-only, truncated from the head past
 * the byte cap so a runaway error loop stays bounded. Raw
 * `writeFileSync` is the right tool here: an atomic tmp+rename would
 * clobber the whole prior log on every append, while `{ flag: "a" }`
 * lets sibling windows interleave at line boundaries. */
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

/** Swallows everything. Used before activate and after dispose so
 * `epicHandshakeLogger()` never hands back null. */
const SILENT: EpicHandshakeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

let active: EpicHandshakeLogger | null = null;

/** Create the tier logger on a VS Code output channel. Returns the
 * logger and a `dispose` so the caller releases the channel on
 * deactivate without holding the raw channel. */
export function createEpicHandshakeLogger(): {
  logger: EpicHandshakeLogger;
  dispose: () => void;
} {
  const channel = createOutputChannelLogger(CHANNEL_NAME);
  const logger: EpicHandshakeLogger = {
    info: (message) => channel.info(message),
    warn: (message) => channel.warn(message),
    error(message: string): void {
      channel.error(message);
      // ISO timestamp up front so a grep across the file lines up with
      // the inbox file mtimes in the bridge state dir.
      appendErrorToDisk(`[${new Date().toISOString()}] ${message}\n`);
    },
    show: () => channel.show(),
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

/** The live logger, for the few call sites too deep in the menu chain
 * to have one threaded to them (the Codex Defaults picker, which may
 * populate the model catalog when it opens). Not a general escape
 * hatch: prefer an injected logger wherever the wiring already reaches. */
export function epicHandshakeLogger(): EpicHandshakeLogger {
  return active ?? SILENT;
}
