import { readCodexSandboxOverride } from "../codexSettings/codexRuntimeOverrides";
import { readSessionPin } from "../codexSettings/codexSessionSettings";
import type { Envelope } from "./envelope";
import type { TurnStartParams } from "../appServer/protocol";

/**
 * The `turn/start` request body, rebuilt on every turn so the Codex
 * Model Settings picker takes effect on the next prompt without a
 * thread reset. Sandbox is workspace-scoped, model and effort belong
 * to the session. Approval policy stays pinned to `never` because the
 * bridge has no UI to relay Codex's approval prompts back mid-turn.
 *
 * Sending model on every turn is what makes the pin real. Codex fixes
 * a thread's model at `thread/start` and then forgets it: resumed
 * cold, it reports the config.toml model instead. Re-asserting per
 * turn means a resumed session runs what the user last chose, not
 * what a machine-wide Codex preference happens to say.
 */
export function buildTurnStartParams(
  threadId: string,
  env: Envelope,
  workspacePath: string,
  wsHash: string
): TurnStartParams {
  const sandboxPolicy =
    readCodexSandboxOverride(wsHash) === "full-access"
      ? ({ type: "dangerFullAccess" } as const)
      : ({ type: "readOnly" } as const);
  const pin = readSessionPin(workspacePath);
  return {
    threadId,
    input: [{ type: "text", text: env.body }],
    sandboxPolicy,
    approvalPolicy: "never",
    model: pin.model,
    effort: pin.effort,
  };
}
