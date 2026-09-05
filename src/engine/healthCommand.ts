import * as vscode from "vscode";
import type { ProviderKey } from "./contracts";
import type { EngineContext } from "./engineContext";
import {
  formatEpoch,
  renderNotifications,
  renderProvider,
  renderRuntimeProbes,
} from "./healthReportSections";
import { getAppUserModelID } from "./windowsToastProcess";

/**
 * [WAT-DEBUG] Diagnostic command exposed in the palette as
 * `WAT321: Show Provider Health`. Opens a read-only output panel
 * summarizing every provider, recent lifecycle transitions, recent
 * notification decisions, Windows toast identity, and runtime versions.
 * Section renderers live in `healthReportSections.ts`. This is the
 * canonical instrumentation entry point: `grep -rn "\[WAT-DEBUG\]" src/`
 * pulls every diagnostic surface for review or wholesale removal.
 */

const COMMAND_ID = "wat321.showProviderHealth";
const TRANSITION_RING_SIZE = 20;

/** Appended callbacks for tool-owned health sections (Epic Handshake
 * etc.). Tools register via `registerHealthSection` during activate and
 * the command iterates the list when the panel renders, which keeps the
 * engine from importing tool modules directly. */
type HealthSectionFn = (lines: string[]) => void;
const healthSections: HealthSectionFn[] = [];

export function registerHealthSection(fn: HealthSectionFn): vscode.Disposable {
  healthSections.push(fn);
  return {
    dispose: () => {
      const i = healthSections.indexOf(fn);
      if (i >= 0) healthSections.splice(i, 1);
    },
  };
}

interface Transition {
  at: number;
  event: string;
  provider?: ProviderKey;
}

const transitions: Transition[] = [];

function recordTransition(entry: Transition): void {
  transitions.push(entry);
  if (transitions.length > TRANSITION_RING_SIZE) {
    transitions.splice(0, transitions.length - TRANSITION_RING_SIZE);
  }
}

function renderTransitions(lines: string[]): void {
  lines.push("Recent lifecycle transitions");
  lines.push("-".repeat(30));
  if (transitions.length === 0) {
    lines.push("(none yet this session)");
    return;
  }
  for (const t of transitions) {
    const who = t.provider ? ` ${t.provider}` : "";
    lines.push(`  ${formatEpoch(t.at)}  ${t.event}${who}`);
  }
}

function renderHealthReport(ctx: EngineContext): string[] {
  const lines: string[] = [
    "WAT321 Provider Health",
    "=".repeat(30),
    "",
    `Activated provider groups: ${ctx.providers.activeCount()}`,
  ];

  if (process.platform === "win32") {
    // A mismatched AUMID is the most common silent-drop cause for Windows
    // toasts on VS Code forks, so it sits near the top. AUMID is
    // discovered inside the warm PowerShell process at first spawn and
    // reads `(pending)` until then.
    const aumid = getAppUserModelID() || "(pending - no toast fired yet)";
    lines.push(`Host appName:    ${vscode.env.appName}`);
    lines.push(`Host uriScheme:  ${vscode.env.uriScheme}`);
    lines.push(`Toast AUMID:     ${aumid}`);
  }

  lines.push("");
  renderRuntimeProbes(lines);
  lines.push("");
  for (const key of ctx.providers.keys()) {
    renderProvider(ctx, key, lines);
    lines.push("");
  }
  renderTransitions(lines);
  lines.push("");
  renderNotifications(lines);
  lines.push("");
  for (const fn of healthSections) {
    try {
      fn(lines);
    } catch {
      lines.push("  (health section errored)");
    }
  }
  lines.push("");
  lines.push(`Timestamp: ${new Date().toLocaleString()}`);
  return lines;
}

export function registerHealthCommand(
  context: vscode.ExtensionContext,
  getCtx: () => EngineContext | null
): void {
  // Lifecycle events are emitted from extension.ts and recorded here.
  const ctxOnInit = getCtx();
  if (ctxOnInit) {
    const { events } = ctxOnInit;
    context.subscriptions.push(
      events.on("provider.activated", (p) => recordTransition({ at: Date.now(), event: "activated", provider: p.provider })),
      events.on("provider.deactivated", (p) => recordTransition({ at: Date.now(), event: "deactivated", provider: p.provider })),
      events.on("provider.connected", (p) => recordTransition({ at: Date.now(), event: "connected", provider: p.provider })),
      events.on("provider.disconnected", (p) => recordTransition({ at: Date.now(), event: "disconnected", provider: p.provider })),
      events.on("engine.reset", () => recordTransition({ at: Date.now(), event: "engine.reset" })),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, () => {
      const ctx = getCtx();
      if (!ctx) {
        void vscode.window.showWarningMessage("WAT321 engine not initialized.");
        return;
      }
      const panel = vscode.window.createOutputChannel("WAT321 Health");
      panel.clear();
      for (const line of renderHealthReport(ctx)) panel.appendLine(line);
      panel.show();
    })
  );
}
