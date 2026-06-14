import { resolveClaudeCli } from "../shared/providers/claude/cliResolver";
import { resolveCodexCli } from "../shared/providers/codex/cliResolver";
import { resolveOpenCodeCli } from "../shared/providers/opencode/cliResolver";

/**
 * CLI presence probes for the Epic Handshake enable-flow gate. EH
 * needs Claude plus at least one of (Codex, OpenCode) - we resolve
 * each binary via the shared resolver (PATH plus bundled-extension
 * fallback) and refuse activation when nothing is reachable.
 */

export async function isClaudeAvailable(): Promise<boolean> {
  return (await resolveClaudeCli()) !== null;
}

export async function isCodexAvailable(): Promise<boolean> {
  return (await resolveCodexCli()) !== null;
}

export async function isOpenCodeAvailable(): Promise<boolean> {
  return (await resolveOpenCodeCli()) !== null;
}
