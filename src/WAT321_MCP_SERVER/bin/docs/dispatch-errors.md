# WAT321 Bridge - Error recovery

Read this when a dispatch returns an error you don't immediately
understand. Each section names the error message, what caused it, and
how to recover without looping.

For wait-mode mechanics see `bridge://docs/dispatch`. For alias /
target / sticky-flag mechanics see `bridge://docs/dispatch/routing`.

## "adaptive is only supported for target='codex'"

You passed `adaptive: true` on an OpenCode or Local LLM call. Those
backends have no progress heartbeat for adaptive to extend against.

Recovery: drop the `adaptive` parameter and use `timeout_sec` if you
need a longer fixed wait. Nothing was sent - do NOT retry the prompt
expecting a different outcome.

## Sync timeout: "No reply from X within Ys"

The backend did not respond within `timeout_sec`. The dispatcher may
still be running.

Recovery options:
1. Call `wat321_bridge()` to check for a late arrival.
2. Retry the same prompt with a higher `timeout_sec`.
3. For Codex: retry with `adaptive: true` to extend while heartbeats
   are coming in.
4. For any target: retry with `fire_and_forget: true` to detach and
   pick up the reply later via `wat321_bridge()`.

## Adaptive abort (Codex, stale heartbeat)

When Codex stops emitting heartbeats during an adaptive wait, the MCP
tool aborts cleanly after ~120s (the stale threshold) and returns a
stale-heartbeat error in the tool response (NOT an inbox envelope).

Codex may still finish later; if it does, the reply lands in the
bridge inbox and is retrievable with `wat321_bridge()`. Surface the
abort to the user and let them decide whether to retry with a fresh
dispatch.

## "Backend not enabled" / "X requires Codex to be enabled"

The target is not turned on in WAT321 settings. The user has to enable
it via the Epic Handshake or OpenCode toggle and reload the window
before the tool can succeed.

Recovery: surface the message to the user verbatim. Do NOT attempt
to enable settings programmatically; that requires user consent.

## "wat321_bridge: unknown action 'X'"

You passed an `action` field that is not "consume". The tool is
single-purpose - it drains the inbox. Omit `action` entirely, or pass
`action: "consume"` for back-compat with the pre-v1.5.5 schema.

Recovery: reissue without the action field.

## What NOT to do

- Do NOT read inbox files directly with Read or cat. Always use
  `wat321_bridge()`. Direct reads desync the bridge and the next
  consume double-injects the same reply.
- Do NOT retry after a "nothing was sent" error. The dispatch genuinely
  did not occur - retrying loops.
- Do NOT poll `wat321_ask` or `wat321_bridge` on a timer. The user
  controls cadence.
- Do NOT manually clear or move inbox files. The user has a Reset
  WAT321 command for that.

(For fire-and-forget specifically: do NOT say "still working", do NOT
offer to poll, do NOT call the tool again for the same prompt. The
FF return message explicitly says no wait was attempted - the
dispatch is complete from your perspective.)
