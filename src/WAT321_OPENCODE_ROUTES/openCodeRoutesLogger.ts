import * as vscode from "vscode";

/**
 * Logger for the OpenCode Routes tier. Mirrors the
 * `WAT321_EPIC_HANDSHAKE/epicHandshakeLogger.ts` shape so the per-tier
 * "WAT321: ..." entries in the Output panel dropdown feel consistent.
 * Hidden by default - users open it from the dropdown when diagnosing
 * connection issues.
 */

export interface OpenCodeRoutesLogger {
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

export function createOpenCodeRoutesLogger(): {
  logger: OpenCodeRoutesLogger;
  channel: vscode.OutputChannel;
} {
  const channel = vscode.window.createOutputChannel("WAT321: OpenCode Routes");
  const logger: OpenCodeRoutesLogger = {
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
