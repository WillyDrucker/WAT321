import * as vscode from "vscode";

/**
 * The VS Code output-channel logger every tier logs through. One
 * channel per tier, named "WAT321: <tier>" so the Output panel
 * dropdown groups them. Hidden by default: a user opens it from the
 * dropdown, or a diagnostic path calls `show()`, when a tier needs
 * looking into. Nothing else in WAT321 logs anywhere.
 */

export interface OutputChannelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
  dispose(): void;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function createOutputChannelLogger(channelName: string): OutputChannelLogger {
  const channel = vscode.window.createOutputChannel(channelName);
  return {
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
}
