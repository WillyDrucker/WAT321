import * as vscode from "vscode";

/**
 * Logger for the unified WAT321 Bridge tier. Mirrors the per-tier
 * loggers in WAT321_EPIC_HANDSHAKE and WAT321_OPENCODE_ROUTES so the
 * "WAT321: ..." entries in the Output panel dropdown feel consistent.
 * Hidden by default; surfaced manually when diagnosing the unified
 * MCP server's install / dispatch behavior.
 */

export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
  dispose(): void;
}

const stamp = (): string => {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
};

export function createBridgeLogger(): {
  logger: BridgeLogger;
  channel: vscode.OutputChannel;
} {
  const channel = vscode.window.createOutputChannel("WAT321: Bridge");
  const logger: BridgeLogger = {
    info(message: string): void {
      channel.appendLine(`${stamp()} [info ] ${message}`);
    },
    warn(message: string): void {
      channel.appendLine(`${stamp()} [warn ] ${message}`);
    },
    error(message: string): void {
      channel.appendLine(`${stamp()} [error] ${message}`);
    },
    show(): void {
      channel.show(true);
    },
    dispose(): void {
      channel.dispose();
    },
  };
  return { logger, channel };
}
