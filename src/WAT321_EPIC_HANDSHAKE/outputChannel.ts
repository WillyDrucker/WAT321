import * as vscode from "vscode";
import type { EpicHandshakeLogger } from "./types";

/**
 * VS Code output-channel-backed implementation of
 * `EpicHandshakeLogger`. The one place in WAT321 where debug logging
 * is allowed; never `console.log` or any other side path.
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
 */

const CHANNEL_NAME = "WAT321 Epic Handshake";

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
      channel.appendLine(`${stamp()} [error] ${message}`);
    },
  };

  return {
    logger,
    dispose: () => channel.dispose(),
  };
}
