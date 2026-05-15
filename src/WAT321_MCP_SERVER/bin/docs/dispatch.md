# WAT321 Bridge - Dispatch (core)

Read once per session before your first `wat321_ask`. Covers what the
tool does, the three wait modes, and the inbox-retrieval contract.

Sibling docs cover the rest:
- `bridge://docs/dispatch/routing` - alias resolution, target capability
  matrix, sticky wait mode mechanics. Read when you need to figure out
  WHO to dispatch to or how mode flags interact with the status bar.
- `bridge://docs/dispatch/errors` - error patterns and recovery. Read
  when a dispatch returns an error you don't immediately understand.
- `bridge://docs/dispatch/judgement` - optional. When the user didn't
  specify a wait mode and you're weighing whether to override sticky
  Adaptive with explicit `fire_and_forget: true` on your own read of
  intent. Skip unless that case comes up.

## What the bridge does

Routes a Claude-side prompt to an AI tool (Codex, OpenCode-aliased
models, Local LLM) running outside this session, then returns either
the reply (sync / adaptive) or a dispatch confirmation (fire-and-forget,
with the reply landing in the bridge inbox).

## Wait modes

Three modes. The mode applies to all three targets equally - Codex,
OpenCode, and Local LLM all support sync and fire-and-forget. Adaptive
is Codex-only because it relies on Codex's progress heartbeats.

### Sync (base mode)

Blocks until the backend replies or `timeout_sec` elapses (default
120s). Reply returns in the tool response. Active when no sticky wait
mode is set and no `fire_and_forget` / `adaptive` arg is passed.

### Fire-and-forget (`fire_and_forget: true`)

Returns immediately after dispatching. The backend processes on its own
schedule; the reply lands in the bridge inbox when complete. Retrieve
with `wat321_bridge()` or (for Codex) rely on the auto-preamble on the
next `wat321_ask` to Codex.

After firing FF: return control to the user. Do NOT say "still working",
do NOT offer to poll, do NOT call wat321_ask again for this prompt. The
return message says "no wait attempted, not a timeout" - that is true
and load-bearing.

### Adaptive (`adaptive: true`, Codex only)

Extends the wait while Codex keeps emitting progress heartbeats. Aborts
cleanly when heartbeats stop for ~120s (the stale threshold). Better
than a flat long `timeout_sec` because it returns fast when Codex is
genuinely done OR hung, vs sitting on a 30-min timer. `timeout_sec`
becomes the hard ceiling under adaptive (default 10 min, max 30 min).

## Mutual exclusion

`fire_and_forget: true` and `adaptive: true` together is rejected. Pick
one or neither.

## Retrieval contract

The bridge tracks "pending" via file presence in the inbox directories.
Always use `wat321_bridge()` to drain replies - never read inbox files
directly with Read or cat. Direct reads leave the file in place; the
next dispatch sees it as still-pending and the auto-preamble (Codex)
or next consume call double-injects the same content. The bridge looks
broken to the user.

For a deeper walkthrough of consume semantics, see `bridge://docs/inbox`.

## Quick reference

- "Ask Codex" -> `alias: "Codex"`; omit mode unless the user requested
  fire-and-forget or adaptive.
- "Ask Big Pickle" -> `alias: "Big Pickle"` (OpenCode-aliased target).
- "Fire-and-forget Codex" -> `alias: "Codex", fire_and_forget: true`.
- "Fire-and-forget Big Pickle" -> `alias: "Big Pickle", fire_and_forget: true`.
- "Wait longer, Codex is doing heavy work" -> `adaptive: true`.
- "Check if a reply landed yet" -> `wat321_bridge()`.
