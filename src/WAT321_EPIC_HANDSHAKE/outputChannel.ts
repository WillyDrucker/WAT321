import * as vscode from "vscode";
import type { EpicHandshakeLogger } from "./types";

/**
 * VS Code output-channel-backed implementation of
 * `EpicHandshakeLogger`. This is **the one place** in WAT321 where
 * debug logging is allowed. Every log line goes through this
 * channel, never through `console.log` or any other side path.
 *
 * Rationale (Section 14 risk #5 in the plan): a JSON-RPC child
 * process + event stream is inherently harder to debug than the
 * pure-pull usage widgets. A single focused output channel lets us
 * diagnose live issues without spilling into the main OUTPUT
 * panel's provider tabs. The channel is deliberately tiny and the
 * call sites are strictly limited.
 *
 * What is logged:
 *
 *   - spawn / exit of the `codex app-server` child
 *   - `initialize` success / failure
 *   - thread/start / resume / read transitions and recovery paths
 *   - message dispatch start / complete / fail (not bodies)
 *   - parse failures on mailbox files
 *   - explicit recovery paths taken
 *   - hook installer write / uninstall / verify actions
 *
 * What is NEVER logged:
 *
 *   - full message bodies
 *   - streaming item delta chunks (item.agentMessage.delta etc.)
 *   - attachment contents
 *   - auth details
 *
 * Call sites must stay in that allowlist. If you find yourself
 * wanting to log something that is not on it, stop and think again.
 */

const CHANNEL_NAME = "WAT321 Epic Handshake";

/** Create an `EpicHandshakeLogger` backed by a VS Code
 * `OutputChannel`. Returns both the logger and a `dispose` helper
 * so the caller can release the channel on extension deactivate. */
export function createOutputChannelLogger(): {
  logger: EpicHandshakeLogger;
  channel: vscode.OutputChannel;
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

  return { logger, channel };
}
