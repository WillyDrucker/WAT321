# WAT321 Bridge - Inbox

Read once per session before calling `wat321_bridge`. Covers what the
tool does, the why-not-direct-read rule, and drain patterns.

## What the inbox is

Three filesystem directories where backends deposit replies for
dispatches that returned before the backend finished (fire-and-forget,
sync timeouts, adaptive aborts):

- Codex: `~/.wat321/epic-handshake/inbox/claude/<workspaceHash>/`
- OpenCode: `<per-client bridge dir>/inbox/opencode/`
- Local LLM: `<per-client bridge dir>/inbox/local/`

Codex's path is shared across workspaces (the Epic Handshake dispatcher
filters by workspace hash). The non-Codex inboxes are per-client and
isolated by VS Code window.

## What wat321_bridge does

Calling `wat321_bridge()` drains pending replies from EVERY enabled
backend's inbox:

- Returns reply bodies as tool response text.
- Atomically moves source files to `sent/` (best-effort).
- Empty inbox returns "No pending replies".

Codex and non-Codex inboxes are drained in one call; the response
prefixes each non-Codex reply with `[<target> reply <filename>]` so
you can tell them apart.

## Drain-all vs single-reply

- `wat321_bridge()` (no args) -> drain all pending replies across all
  inboxes. Most common pattern.
- `wat321_bridge({reply_id: "<id>"})` -> consume one specific reply.
  Rare; the id matches against filename prefix.

## When to call wat321_bridge

- User says "check inbox" / "is Codex done" / "did Big Pickle reply yet".
- After a fire-and-forget dispatch when the user is ready for the reply.
- After a sync timeout, to check for a late arrival.
- Before sending another `wat321_ask` to Codex (OPTIONAL for Codex
  only - auto-preamble handles it; see below).

## Auto-preamble (Codex only)

`wat321_ask` to Codex automatically prepends any pending Codex inbox
replies to the response. So an explicit `wat321_bridge()` is OPTIONAL
if the next bridge call is going to be `wat321_ask` to Codex anyway -
the late reply rides along on that call's response.

This auto-preamble does NOT apply to OpenCode or Local LLM. For those
targets, call `wat321_bridge()` to retrieve FF replies.

Use explicit `wat321_bridge()` when:
- The user asks about a backend's status without wanting to send a
  new prompt.
- A non-Codex FF reply needs to be retrieved.
- A reply needs to be retrieved before composing the next dispatch.

## Why NEVER read inbox files directly

The bridge tracks "pending" via file presence in the inbox directories.
Reading with Read or cat:

1. Does NOT move the file to `sent/`. It stays as "pending".
2. The next `wat321_ask` to Codex sees the still-pending Codex file
   and auto-preambles its content again, OR the next consume call
   re-drains it.
3. The user sees the same reply twice; the agent looks broken.

Always use `wat321_bridge()` (or, for Codex only, rely on auto-preamble).
Both correctly clear the inbox.

## Peek without consuming

To inspect without draining (e.g., user asks "what's pending?" without
claiming the reply), read the MCP resources:
- `bridge://inbox/codex` - Codex pending replies.
- `bridge://inbox/opencode` - OpenCode pending FF replies.
- `bridge://inbox/local` - Local LLM pending FF replies.

These are read-only and do not move files.

## Empty inbox

Common reasons:
- No FF dispatch happened this session.
- The most recent FF dispatch has not completed yet (backend still
  working).
- A previous `wat321_bridge()` call already drained it.

If the user expects a reply but the inbox is empty: check the status
bar widget for in-flight state, or read `bridge://status` for daemon
health.

## What about MCP server restart?

Non-Codex FF dispatches run in the MCP server's event loop. If the
server process exits before the dispatch completes (VS Code closed,
reload, etc.), the in-flight reply is lost. The user opted into "fire
and forget" knowing the call might not complete. Files already in the
inbox from earlier completed dispatches persist on disk and survive
restarts.

Codex FF is more robust: the Epic Handshake dispatcher runs as a
separate process and continues even when Claude Code is closed.
