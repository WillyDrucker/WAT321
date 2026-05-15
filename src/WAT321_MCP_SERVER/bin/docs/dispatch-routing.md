# WAT321 Bridge - Routing & sticky modes

Covers alias resolution, target capability differences, and how the
status bar's sticky wait mode interacts with per-call `fire_and_forget`
/ `adaptive` args. Read this when you need to figure out WHICH target
to dispatch to, or when sticky-mode behavior surprises you.

For wait modes and the inbox-retrieval contract, see
`bridge://docs/dispatch`.

## Alias resolution

`alias` is fuzzy-matched against the live catalog at `bridge://instances`.

When `alias` is omitted, the router falls back in this order:
1. Last-used OpenCode-routed backend (whatever the user dispatched to most recently)
2. Active instance (the user's currently-selected default)
3. Codex (if Codex is enabled)

The default lands on whatever the user has been using most recently,
not necessarily Codex. Pass `alias` explicitly when the user names a
target.

Examples: "Codex", "Big Pickle" (an OpenCode model), "Local LLM", any
configured OpenCode model name. Read `bridge://instances` if uncertain
which aliases are currently enabled.

## Target capability

| Target | Transport | FF support | Adaptive | Sessions |
|---|---|---|---|---|
| `codex` | Filesystem envelope (Epic Handshake) | Yes (envelope-based) | Yes | thread_name |
| `opencode` (incl. aliased models like "Big Pickle") | HTTP / SSE | Yes (detached dispatch) | No | session=S1/S2/... |
| `local` (Local LLM) | HTTP / SSE | Yes (detached dispatch) | No | session=S1/S2/... |

Codex carries replies through its own filesystem envelope mailbox at
`~/.wat321/epic-handshake/inbox/`. Non-Codex FF writes an outbound
envelope to the bridge dispatch queue; the extension-host dispatcher
picks it up, runs the HTTP/SSE call, and writes the reply to
`<per-client>/bridge/inbox/<target>/` when it completes. Both paths
drain through the same `wat321_bridge()` call.

## Sticky wait mode (status bar widget)

The user has a status bar toggle that cycles between Adaptive and
Fire-and-Forget. The toggle sets a per-workspace sticky flag on disk
(`~/.wat321/epic-handshake/fire-and-forget.<wsHash>.flag` or
`adaptive.<wsHash>.flag`) so toggling in one VS Code window never
affects siblings.

When `wat321_ask` is called WITHOUT explicit `fire_and_forget` or
`adaptive` params:
- Sticky Adaptive runs in adaptive mode automatically (Codex calls only;
  non-Codex falls through to sync since adaptive does not apply).
- Sticky Fire-and-Forget runs in fire-and-forget mode automatically for
  EVERY target, including OpenCode and Local LLM.

Per-call args override the sticky flag:
- `fire_and_forget: true` forces FF regardless of sticky.
- `fire_and_forget: false` disables FF for this single call.
- `adaptive: false` disables adaptive for this single call.

The sticky flag is per-workspace and global across targets (not
per-target), so toggling it in the widget affects every subsequent
dispatch from this workspace until changed back.

## Sessions and threads

- `session`: opencode/local session alias (e.g., "S1", "S2"). Omit for
  the active session. Sessions persist across windows.
- `thread_name`: Codex thread name. Rarely needed - alias resolution
  covers the common case.
