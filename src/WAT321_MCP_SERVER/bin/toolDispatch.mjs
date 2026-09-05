import { existsSync } from "node:fs";
import { resolveAskTarget } from "./askRouter.mjs";
import { dispatchBridgeDrain } from "./bridgeDrain.mjs";
import * as codexDispatch from "./codex/dispatch.mjs";
import { FIRE_AND_FORGET_FLAG_PATH } from "./epicHandshakePaths.mjs";
import { errorResult } from "./mcpResults.mjs";
import { dispatchFireAndForget } from "./nonCodexMailbox.mjs";
import * as openCodeDispatch from "./opencode/dispatch.mjs";
import { handleSession } from "./opencode/sessions.mjs";
import { decorateAskResult } from "./replyDecorator.mjs";

/**
 * Routes a tool call to the right per-target handler. `wat321_ask`
 * goes through the alias router and the wait-mode gate, `wat321_bridge`
 * drains every inbox, `wat321_session` is a thin pass-through for
 * opencode/local lifecycle mutations.
 */

export async function dispatchCall(name, args, enabled) {
  if (name === "wat321_ask") return dispatchAsk(args, enabled);

  if (name === "wat321_bridge") {
    const anyEnabled =
      enabled.codex === true ||
      enabled.opencode === true ||
      enabled.local === true;
    if (!anyEnabled) {
      return errorResult(
        "wat321_bridge requires at least one backend to be enabled. Turn on Epic Handshake or OpenCode in WAT321 settings and reload."
      );
    }
    return dispatchBridgeDrain(args, enabled);
  }

  if (name === "wat321_session") {
    const target = typeof args?.target === "string" ? args.target : null;
    if (target === null) {
      return errorResult("wat321_session requires a 'target' argument.");
    }
    if (target === "codex") {
      return errorResult(
        "wat321_session does not apply to target=codex. Pass thread_name on wat321_ask instead."
      );
    }
    if (!enabled[target]) {
      return errorResult(
        `Target '${target}' is not enabled. Enable OpenCode (and a local endpoint for target=local) before managing sessions.`
      );
    }
    return handleSession(args);
  }

  return errorResult(`Unknown tool '${name}'.`);
}

async function dispatchAsk(args, enabled) {
  const resolved = resolveAskTarget(args, enabled);
  if (resolved.error) return resolved.error;
  const target = resolved.target;
  // Enforce the enabled-target gate even after the router resolves.
  // Cached Claude tool schemas can outlive a settings change that
  // disabled a target, and last-used / active fallbacks may point
  // at a target the user has since turned off. Refuse explicitly
  // rather than silently dispatching against a disabled tier.
  if (!enabled[target]) {
    return errorResult(
      `Target '${target}' is not enabled. Turn on the corresponding WAT321 setting (Epic Handshake for codex; OpenCode for opencode/local) and reload.`
    );
  }

  // Resolve the effective wait mode for the call. Per-call `true`
  // wins, per-call `false` suppresses the matching sticky flag for
  // this call only, otherwise the sticky flag on disk decides. Codex
  // has its own resolveMode in `codex/dispatch.mjs`. For non-Codex we
  // resolve here because this wrapper has to choose between the sync
  // handleAsk and the detached FF path before calling into the target.
  const explicitFFTrue = args?.fire_and_forget === true;
  const explicitFFFalse = args?.fire_and_forget === false;
  const stickyFFOn = !explicitFFFalse && existsSync(FIRE_AND_FORGET_FLAG_PATH);
  const effectiveFF = explicitFFTrue || stickyFFOn;

  // Adaptive is Codex-only. Non-Codex backends have no progress
  // heartbeat for adaptive to extend against. Reject explicit
  // adaptive on a non-Codex target, sticky adaptive falls through to
  // sync silently (functionally identical, no error needed).
  if (args?.adaptive === true && target !== "codex") {
    return errorResult(
      `adaptive is only supported for target='codex'. The ${target} backend has no progress heartbeat for adaptive to extend against. Reissue the same prompt without the adaptive parameter and use timeout_sec if you need a longer fixed wait (this is not a dispatch failure; nothing was sent to ${target}).`
    );
  }

  // The handlers predate the router, so the resolved target and
  // instance are baked back into the args shape they read.
  const forwardArgs = {
    ...args,
    target,
    ...(resolved.instance_id ? { instance_id: resolved.instance_id } : {}),
  };

  // Non-Codex fire-and-forget: write an outbound envelope to the
  // dispatch queue and return immediately. The extension-side
  // `OpenCodeDispatcher` (registered with the engine's
  // `OutboundWatcher`) picks up the envelope, runs the HTTP/SSE call,
  // and writes the inbound reply to `<bridgeStateDir>/inbox/<target>/`
  // where `wat321_bridge()` drains it alongside Codex's Epic Handshake
  // inbox. Codex FF stays on its own envelope path inside its handler.
  //
  // The dispatcher lives in the extension host, not this MCP process,
  // so an MCP-side restart does not abort in-flight FF work. Graceful
  // shutdown writes a synthetic "cancelled by shutdown" inbound
  // envelope for anything still running when VS Code closes.
  if (effectiveFF && target !== "codex") {
    return dispatchFireAndForget(target, forwardArgs);
  }

  const handleAsk =
    target === "codex" ? codexDispatch.handleAsk : openCodeDispatch.handleAsk;
  const askResult = await handleAsk(forwardArgs);
  return decorateAskResult(askResult, args, target);
}
