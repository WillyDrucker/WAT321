# Changelog

All notable changes to WAT321 Willy's AI Tools will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.24] - unreleased

## [1.5.23] - 2026-06-01

### Fixed

- **The Codex session-tokens widget now finds a session you started from a subfolder of your open workspace.** It previously matched only when the workspace lived inside the session's working directory, not the reverse, so launching Codex from a subdirectory left the widget blank. It now matches both directions, the way the Claude widget already did.
- **The Codex widget stops showing a session once its rollout is gone.** After a session was deleted or you ran Reset WAT321, the widget could keep displaying the old token count instead of going idle. It now clears as soon as the underlying session file disappears, while an older session that simply scrolled out of the recent-history scan still keeps showing.
- **The Claude session tooltip's cache line no longer always reads "HIT".** The "Most recent cache" line could say "HIT" even when the event was a cache load or a miss. It now reads "Most recent cache event" so the wording matches what actually happened.

### Changed

- **Fewer duplicate prompts when a bridge dispatch stalls.** When a dispatch to a slow or cold-starting backend was cancelled before it answered, the recovery guidance could lead to re-sending and stacking a duplicate on a backend that was still working. The bridge docs now classify that abort case and cap retries at one, with the late reply delivered through the inbox instead.

## [1.5.22] - 2026-06-01

### Fixed

- **The Codex session-tokens "thinking" indicator stays animated while Codex is reasoning, even when it goes quiet.** When you prompt Codex directly in its VS Code extension, the widget's activity cycle used to fall back to its idle icon partway through a turn and sit there until the answer landed. Recent Codex models think silently for long stretches with nothing written to the session file (observed up to a minute and a half), and the indicator was tied to how recently that file last grew, so a quiet reasoning gap read as idle even though Codex was hard at work. The indicator now rides through those silent stretches for the length of a turn and settles only once the turn actually finishes. Work dispatched over the Epic Handshake bridge was never affected and behaves exactly as before. The activity window is now turn-aware, a generous ceiling while a turn is in flight rather than a fixed file-activity timeout.

## [1.5.21] - 2026-06-01

### Removed

- **The Claude and Codex session-tokens widgets no longer require Node 22.5+ at runtime.** v1.5.19 added two precision tiers that read SQLite databases via the experimental `node:sqlite` module: a Claude "Memento" tier that stabilized the active-session pick when more than one session was concurrently open in a workspace, and a Codex extension-overlay that detected activity from the Codex VS Code extension's chat panel. Both required VS Code 1.103 or newer (the first VS Code release with a Node 22 runtime), which silently degraded older VS Code, Cursor, Windsurf, and locked-enterprise installs. Both tiers have been removed; ranking falls back to the v1.5.18 disk-tier baseline (hot recency, activity score, mtime, entrypoint). The removed source lives in `WDDOCS/ARCHIVE/v1.5.21-sqlite-dropout/` for a future reimport behind a universal-compatibility library.

## [1.5.20] - 2026-06-01

### Fixed

- **The Codex usage and Codex session-tokens widgets reappear in the status bar.** A v1.5.19 regression made these widgets register with VS Code (they still showed up under the status-bar right-click menu) but never paint their text, leaving a workspace with Claude on its own and the dual-provider layout collapsed to single-provider Full mode. Cause was a missing `this` binding in the new non-active completion drain inside the notification bridge: the drain was destructured into a local variable and called without its receiver, so the first emission of a real Codex session synchronously crashed Codex activation. Extension activation now also shields each provider's startup in its own try block, so a future regression in one provider can never strand the sibling's widgets the same way.

### Changed

- **A long Codex turn that exceeds the bridge's stall or hard-cap timer no longer loses its reply.** Previously, an adaptive-mode dispatch that ran past the bridge's two-minute stall window or 30-minute hard cap would interrupt Codex, poll the rollout file for 30 seconds, and then reject with "Codex exceeded max turn duration" if the reply had not landed yet. A reply that arrived a moment later was discarded. The bridge now opens a 30-minute background late-delivery watch when the initial recovery exhausts, so a slow flush, mid-turn compact, or genuinely-long task still lands in your `wat321_bridge()` inbox via the normal completion path. The MCP tool's caller-side timeout is unchanged: the AI making the dispatch still returns at its `timeout_sec` ceiling without waiting longer.

## [1.5.19] - 2026-06-01

### Fixed

- **A response completing in a Claude or Codex session you weren't actively watching now reliably fires its notification, even when more than one session is open in the same workspace.** The bridge listens to one ranked active session at a time, but concurrent sibling sessions also need their completions delivered. Sibling completions are now tracked per-session and drained on every poll above the suppress gate, so a busy active session can no longer block a quieter sibling's notification. Covers the case where two Claude windows in the same project both finish within seconds of each other and only one used to chime.

- **Two completions landing within ten seconds on different Claude or Codex sessions both fire their toasts.** The notification cooldown was global per-provider, so a follow-up on a second concurrently-active session collapsed into the first session's cooldown window and went silent. The cooldown is now keyed per (provider, session), so distinct sessions never suppress each other while still collapsing rapid bursts inside one session.

- **The Codex session-tokens widget no longer surfaces activity from another workspace.** The Codex VS Code extension writes its native-panel turns to an account-global SQLite store, and the overlay had no workspace filter, so a sibling workspace open in another VS Code window could feed its turns into the wrong widget. The overlay now matches rows by normalized absolute workspace path and the cache is keyed per (workspace, file). Sibling workspaces sharing a leaf folder name like `api` or `frontend` can no longer false-positive either, because basename-only matching is no longer accepted.

- **Codex extension activity now invalidates the overlay's cache the instant a row lands.** SQLite WAL mode writes fresh rows to a sidecar `<file>-wal` before checkpointing back, and the cache fingerprint was reading the main file's mtime, which stays unchanged until checkpoint. The fingerprint now folds in the WAL file's mtime, so the next poll sees the new state immediately instead of waiting for a checkpoint.

### Changed

- **The Codex extension overlay's freshness window now spans the full rescan cadence.** It was 30 seconds, which meant a Codex completion landing just after a rescan could age out before the next pass picked it up and silently fail to fire. The window is now 120 seconds, covering one full 51-second rescan cycle plus headroom for slow systems. Detection runs on every rescan instead of only on size growth, so the widget also catches completions that don't push the file size past the prior poll.

## [1.5.18] - 2026-05-31

### Added

- **The session-tokens widget tooltip now tells you when you have more than one Claude or Codex session open in the same workspace.** A line reading "Watching 1 of N Claude sessions (M in progress)" surfaces only when the count exceeds one, so single-session workspaces stay clean. Makes it instantly obvious that the widget is locked onto one specific session - useful when a notification fires for what looks like the wrong session or when you switch between concurrent CLI windows in the same project.
- **A disk-backed event log captures every notification-path decision under `~/.wat321/clients/<workspace>/notification-events.jsonl`.** Each session switch, bridge fire / suppress, cross-window dedup outcome, and toast delivery result is appended as a single JSONL line with the data that drove the decision. Bounded rolling log (1MB head-truncate). Survives extension reloads so a "the notification did not fire two hours ago" post-mortem can reconstruct the chain without needing a repro under a debugger.

### Changed

- **Usage widgets stuck on a transient cold-start rate-limit now recover within the normal 122-second poll cycle instead of waiting out the server's suggested 15-minute window.** A cold-start 429 is Anthropic's usage endpoint declining to answer polls on quiet accounts - it clears the instant any prompt fires, so the server's retry-after is a polite suggestion, not a real backoff. The poll cadence stays at 122 seconds for cold-start parks now, so the bars recover within seconds of activity returning. Real (non-cold-start) throttling still honors the server's window where the retry-after is load-bearing.
- **You get one notification per Claude or Codex response when more than one VS Code window is open on the same workspace.** Before this change, every window watching the same project would fire its own toast for the same completion. Now the windows coordinate so only one delivers, and the duplicates are silently suppressed. Single-window workflows are unchanged.
- **The session-tokens widget switches faster to a session you just touched when more than one Claude or Codex session is open in the same workspace.** Activity-first ranking alone could leave the widget locked onto a sibling whose mid-turn classification was older than the session you just returned to, since both were inside the five-minute freshness window. A new hot-recency tier sits above the activity score so a transcript written to within the last minute wins outright, then activity-then-mtime applies as before. The result is the widget tracking the user's actual focus instead of trailing it by a turn.

### Fixed

- **The Claude usage bars no longer drop to zero with a stuck `Refreshing` label during an OAuth token refresh.** A transient `token-expired` state was being treated as identity-changing alongside sign-out and disconnect, clearing both the in-memory cache and the persisted snapshot the moment a 401 landed. The next renders had nothing to fall back to, so the bars went to a 0% scaffold under the dim skin until the token recovered. The refresh window now keeps the cached bars visible under the dim skin, matching every other transient state. Sign-out and disconnect still clear cleanly because they actually change identity.
- **A Claude response that completes during a session switch now fires its notification instead of being swallowed by the path-switch reset.** Reopening VS Code and prompting a session that was not the most-recent-on-disk could let the turn finish before the widget caught up to the new path - the first emission on the new path then satisfied the first-read guard and returned without firing. The bridge now tracks paths it has already seen this process and treats a never-seen path with a fresh, done tail as a legitimate "completion landed during the switch" event. Flipping back to a previously-seen path still goes through the normal flow and cannot re-fire its old completion.
- **Codex thread rotations now write to the bridge errors log on disk.** The three rotation sites in the dispatcher logged at warn level, which the v1.5.17 disk tee deliberately skipped (only error level was teed). Rotations now log at error level so post-mortem review of `~/.wat321/clients/<workspace>/bridge/errors.log` captures the consecutive-failure threshold rotation, the failed `thread/resume` rotation, and the run-turn outer rotation - all three with the original failure message intact.

## [1.5.17] - 2026-05-31

### Fixed

- **The session-tokens widget now follows the session you are actually working in when more than one Claude or Codex session is open in the same workspace.** Picking the active session by file write-time alone could lock onto whichever session was last written, even when the other one was the one you were actively prompting. The picker now reads the tail of each candidate, scores it by current activity (a mid-turn assistant beats a waiting prompt beats an idle finished turn), and only honors the score for sessions written in the last five minutes. An orphaned mid-turn file left over from days ago no longer outranks a fresh idle session, and concurrent sessions stay disambiguated as you switch between them.
- **Usage widgets that get stuck on a transient error now auto-heal within fifteen minutes without you having to prompt or click anything.** A recovery watchdog runs alongside the main poll loop and forces a fresh fetch whenever the gap since the last real attempt exceeds the ceiling, bypassing the cache adoption that could otherwise let a stuck `Refreshing` or `Paused` state ride out a long stretch. Covers the cases where a cached error state keeps refreshing itself, an extended rate-limit park honors a long server backoff, or the poll timer drifts.
- **A Codex turn that completes but loses its reply in the bridge marshal step now delivers the reply from the rollout file instead of failing.** The dispatcher captures a watermark on the rollout at turn start and, in the outer error path, re-reads the rollout to compare against that seed. When the assistant text differs or the file grew past the seed size, the recovered text is delivered as success instead of the generic blocker message. Closes the silent-severance class where on-disk work landed but the reply never reached your inbox.
- **Orphaned MCP bridge tool entries from older releases are now cleaned out of your Claude settings on every Epic Handshake activate, not just on a fresh install.** A user who already had Epic Handshake on at upgrade never re-triggered the installer, so legacy entries from retired bridge tools stayed in `~/.claude/settings.json` forever. The cleanup is now part of both the install path and the activate path. Idempotent, no-op when nothing matches.

### Changed

- **Your last-known usage bars now survive a VS Code restart or extension reload, not just an idle stretch in the same session.** The widget persists each provider's most recent reading to a small file under `~/.wat321/clients/<workspace>/usage-snapshot.json` and rehydrates it on construction, so the first frame of a new VS Code window is your real bars instead of a blank scaffold. Sign-out, token expiry, or disconnect still clear the persisted snapshot for that provider so a different account never inherits the prior one's display, and Reset WAT321 wipes the whole thing as part of the existing per-client sweep.
- **The transient state label (Loading, Refreshing, Idle, Paused, Offline) now lives on a small dedicated widget that sits between the 5h and weekly bars, only visible when something needs your attention.** The bars themselves are now always bars - no more suffix text grafted onto the bar widget. The label widget appears for any non-ok service state and disappears the moment the service returns to ok, with the full tooltip detail (reconnect countdown, server message, status-page incident) on hover.
- **WAT321 now reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` as a pair when both are set, matching current Claude Code behavior.** Earlier releases of Claude Code accepted the percentage override on its own, but recent versions ignore it without a paired window declaration. The widget now computes the effective trigger as `(pct / 100) * window` minus the observed 9-to-15-thousand-token drift between the nominal target and the actual fire point. The legacy single-key paths are still honored for older Claude Code releases.

## [1.5.16] - 2026-05-28

### Fixed

- **Fire-and-forget Codex dispatches no longer wedge the bridge after a long idle.** A fire-and-forget turn that ran past the bridge's 15-minute idle window could leave the workspace stuck so every later prompt was queued but never picked up, and the inbox kept reporting "nothing in flight". The idle timer now resets at the start of every turn and skips its shutdown while a turn is still running, and a fire-and-forget turn that loses its Codex side cleanly releases its locks instead of holding them forever. Asking `wat321_bridge()` while a Codex turn is in flight now reports the dispatch (working or stuck) alongside the non-Codex backends, so an agent can tell "still working" from "wedged" without guessing.
- **The Codex session-tokens activity icon stays on through a long thinking turn.** Windows lazily refreshes the timestamp on a file that stays open, and Codex keeps its session file open for the whole conversation. The widget's 30-second freshness window was running off that lazy timestamp, so the comment-discussion cycle could drop to idle mid-turn while Codex was still actively writing. The cycle now follows the extension's own observed-growth signal, so it stays on whenever the file is genuinely advancing.
- **An explicit `fire_and_forget: false` on `wat321_ask` now really means sync.** With sticky Adaptive turned on in the status-bar menu, passing `fire_and_forget: false` from an agent silently fell through to adaptive instead of plain sync. An explicit opt-out now suppresses both sticky flags so a caller can force sync for a single dispatch without flipping the user's status-bar toggle.

### Changed

- **Usage widgets now keep your bars visible through every transient state.** Idle, throttling, network drops, sign-out, and credential refresh all reuse the same bar layout you see normally - your last-known reading dimmed to a muted gray with a short suffix after the percent, instead of swapping out for a different shape. Hover for the full detail, including the reconnect countdown when one applies, and the same provider color scheme everywhere. Sign-out and credential-refresh still clear cleanly so a new account never inherits the previous account's numbers.
- **The Epic Handshake dropdown now visibly locks every destructive row while a turn is in flight.** Reset, Delete, Delete All, Switch Codex Session, Repair Sessions, Codex Defaults, and Wait Mode all show as `(Disabled - Message In-Flight)` with a lock icon while the bridge is busy, and clicking one surfaces a clear info toast instead of running the action. Cancel, Restart Epic Handshake Bridge, Pause / Resume, and Retrieve Late Replies stay available as escape paths.
- **The OpenCode Enable setting is marked as WIP in the Settings page**, matching the same flag on the TPS counters, so the in-progress surfaces are easy to spot at a glance.

## [1.5.15] - 2026-05-23

### Fixed

- **Asking Claude to hand work to Codex or another model now reliably goes through the bridge.** When you say "ask Codex" (or Big Pickle, or your local LLM), Claude could occasionally reach for a raw command-line call instead of the Epic Handshake bridge, which skips the bridge's session tracking and reply delivery. The bridge now carries an always-on hint so Claude routes those requests through it, even before the bridge's tools are fully loaded into the session.
- **Bridge updates now take effect on your next launch, with no need to toggle Epic Handshake off and on.** If you already had Epic Handshake enabled, a previous extension update could leave the bridge's core running the prior version until you manually turned the feature off and back on. It now refreshes automatically when you relaunch, so the bridge always matches your installed version.

## [1.5.14] - 2026-05-23

### Fixed

- **Asking Codex something while it is still working no longer collides with the turn in progress.** When a Codex dispatch over the Epic Handshake bridge was already running and a second one went out, both turns ran at once on the same thread and stepped on each other. The bridge now notices a turn is still in flight and asks you to wait for the first reply rather than starting a competing one, and the timeout and no-reply messages now point you at the inbox for a late reply instead of nudging you to resend. Retrieve a late reply with `wat321_bridge()`.

## [1.5.13] - 2026-05-20

### Added

- **The Codex session-tokens widget now flashes when a compact finishes, just like Claude.** When Codex compacts a conversation (auto at the threshold or when you run `/compact`), the widget briefly flashes a saturated orange bar at 100% for about two seconds, then settles back to your new lower token count. Same acknowledgment Claude already gives, so a sudden context drop on Codex is never a mystery. Like Claude, there is no live progress bar because the compact only becomes observable once it has already finished, and reattaching to an older session does not replay the flash for a compact you were not watching.

### Changed

- **Idle and connection hiccups no longer wipe your usage bars, on either provider.** Previously a stretch of idle, a brief network drop, or the provider's API throttling a background read would swap the usage widget to a generic "Usage - Idle" pill that dropped the bars and percent you were looking at. Now both the 5h and weekly rows keep showing your last known bars, dimmed to a muted gray with a short suffix after the percent (`5% - Idle`, `5% - Offline`, `5% - Paused`), so you can see at a glance the reading is paused rather than gone. Hover for the full detail, including the reconnect countdown when one applies. Genuine sign-out and credential-refresh states still show their own message and never display a previous account's numbers.

### Fixed

- **Codex's 5h widget now reads 100% right after the window resets.** Codex's usage endpoint reports a floor of 1% even on a freshly reset window, so the bar was dropping to 99% the instant any background traffic flowed even though you had effectively used nothing. The widget now reads a clean 100% through the first whole percent of a fresh window and only steps down once you have actually used a full 1%.
- **Codex usage bars no longer vanish when ChatGPT throttles an idle poll.** ChatGPT's usage endpoint recently started rate-limiting background reads after a quiet stretch, the same way Anthropic's does. WAT321 now recognizes that as a paused-not-broken state and keeps your dimmed bars on screen, recovering automatically the next time you send a message.

### Removed

## [1.5.12] - 2026-05-18

### Changed

- **Manual `/compact` and auto-compact now share the same widget treatment.** v1.5.10 shipped what looked like a live progress bar for manual `/compact`, but it turned out Claude Code buffers the `/compact` user entry and writes it to the transcript only after the compact completes - so the bar was never actually observable during a real run. v1.5.12 retires the in-flight code path and unifies both manual and auto-compact around the same post-completion flash that v1.5.11 introduced for auto: a saturated orange bar at 100% for about a second and a half on auto-compact, a slightly longer ~2.5 seconds on manual since you're actively watching after typing the command. The widget settles back to the new lower token count immediately after.
- **The Codex 5h widget now reads 100% right after the window reset.** Codex reports usage as a fractional percent, so the moment any background traffic flowed in a freshly-reset window the bar was dropping to "99.x% remaining" even though you'd effectively used nothing yet. Now the widget reads 100% through the first whole percent of a fresh window and only drops to 99% once you've actually consumed a full 1% of the period. Honest accounting at the high end - no rounding lies once usage is non-trivial.
- **The idle skin now reads as unmistakably dimmed.** v1.5.11 introduced the "keep showing your last numbers, just dimmed" treatment for the 5h widget but the chosen gray was close enough to the active foreground that on many VS Code themes the dim was invisible. v1.5.12 takes the dim two steps deeper into the neutral palette so the paused-not-active read is obvious at a glance against both light and dark themes.
- **The weekly usage bar now stays visible (dimmed) alongside the 5h bar during cold-poll idle.** Previously only the 5h widget kept its last-good bars during cold-poll absorption while the weekly widget hid entirely, which made the row look incomplete. Now both rows keep showing the data you were just looking at, both dimmed in step. Cache identity rules from v1.5.11 still apply - a sign-out or token expiry drops both widgets to the standard error treatment.

### Fixed

### Removed

## [1.5.11] - 2026-05-18

### Added

- **The 5h usage widget keeps showing your last numbers when it goes idle, just dimmed.** Previously, when WAT321 absorbed a cold-poll 429 from Anthropic's stats endpoint (or the equivalent on Codex) after a long idle stretch, the widget swapped to a generic "Usage - Idle" pill that dropped the bars and percent you were just looking at. Now the widget keeps showing the same bars and percent the last successful poll captured, dimmed to a muted gray with "Idle" tacked on the end so you can see at a glance that the reading is paused, not live. Hover the widget and the tooltip leads with "Last updated N minutes ago" so the dimmed state is never mistaken for current data. The cache resets automatically the instant your sign-in identity changes, so a sign-out or token expiry never bleeds a previous account's numbers onto a new session.
- **A brief orange flash on the Claude session-tokens widget when auto-compact finishes.** v1.5.10 added the live progress bar for manual `/compact`. Auto-compact runs the same way structurally but writes nothing observable until the operation is already done - so a live progress bar isn't possible. Instead, the widget now flashes a saturated orange bar at 99% for about a second and a half the moment auto-compact lands, then snaps back to your normal token display with the new (much lower) post-compact count. Enough acknowledgment that you can spot "the conversation just compacted" without having to figure out why your context just dropped from 720k to 12k. Manual `/compact` running on top of an active flash takes over cleanly. Reattaching to a session whose tail already contains a historical auto-compact does NOT trigger the flash for events you weren't watching live.

### Changed

### Fixed

### Removed

## [1.5.10] - 2026-05-18

### Added

- **A live progress bar on the Claude session-tokens widget when you run `/compact`.** As soon as Claude Code accepts the `/compact` command, the widget swaps its normal token readout for a five-cell orange progress bar plus a percent number, so you can see at a glance that compaction is in flight and roughly how far along it is. The bar fills left to right, the last cell only lights up near the end of the run, and the moment compaction finishes the widget snaps back to showing your post-compact token count. Per-session learning: WAT321 reads the actual duration of each completed compact from the transcript and uses a rolling average of the last few runs to estimate the next one - so the bar tunes itself to how long your compacts typically take in this conversation. First compact in a fresh session uses a deliberately generous default so the bar tends to finish a little early rather than appear stuck at 99%. Auto-compact intentionally does not show the bar, because by the time the auto-compact summary lands, the operation has already completed.

### Changed

### Fixed

### Removed

## [1.5.9] - 2026-05-18

### Added

- **`WAT321: Show Provider Health` now tells you which session each widget is reading and whether the CLI process is alive.** A new "source" line per provider shows `live (pid 1234, alive)` when WAT321 has matched your widget to a running Claude CLI process, or `lastKnown` when the widget is falling back to the most recent transcript on disk. If your widget ever shows activity that doesn't match what you remember doing in this window, that line plus the `tail` path above it tells you exactly which session you're looking at.

### Fixed

- **Each workspace's Claude session-tokens widget now reads its own transcript, period.** A long-standing encoding mismatch in how WAT321 mapped your workspace folder to Claude Code's project directory could route the widget to scan globally for the most recent transcript, which meant one VS Code window's typing could light up another window's widget. The mapping now matches Claude Code's current filesystem layout, and the global fallback is locked off whenever a workspace folder is open. If you ever saw a widget animate while you weren't doing anything in that window, this was the cause.
- **The thinking indicator stays on through the whole Claude turn instead of flickering between tool calls.** When WAT321 couldn't match your Claude session to a live CLI process (claude launched from outside the workspace folder, or the session metadata went stale), the indicator was using a tight three-second activity window that misread normal between-tool deliberation as "turn complete." It now uses a thirty-second window in that fallback path, matching how it already behaves when the live process is matched. Compact and interrupt guards are unchanged, so real end states still settle the widget to idle immediately.
- **System notifications no longer go silent for five minutes after a long stretch with the window unfocused.** The warm PowerShell process WAT321 uses for Windows toasts can get reaped while you're away (Windows scheduler, antivirus, or a logoff), and a few notifications firing during that window were enough to trip a circuit breaker that parked toasts for five minutes. The breaker now resets the moment you focus the window again, so the next notification respawns the pipe cleanly.

### Removed

## [1.5.8] - 2026-05-17

### Added

- **`WAT321: Show Provider Health` now shows recent state transitions for the usage widgets.** A new "recent transitions" block per provider lists the last 25 polling events from the past few hours - successful fetches, absorbed cold-poll 429s, parks, wakes - each timestamped with how long since you last sent a Claude prompt at that moment, the current poll cadence, and how stale the cross-window cache was. If you're investigating "the widget went idle randomly," the health output now tells you exactly which path got it there. The history persists across VS Code restarts via a per-workspace JSONL ring at `~/.wat321/clients/<wsId>/<provider>-usage-transitions.jsonl`.

## [1.5.7] - 2026-05-16

### Changed

- **OpenCode Routes is now opt-in.** Fresh installs no longer auto-enable OpenCode widgets or the bundled `opencode serve` harness. If you want Big Pickle, Nemotron Super, Local LLM dispatch, or the session-token widget for those routes, enable OpenCode in WAT321 settings. Existing aliases, sessions, your Zen API key, and your local endpoint setting are all preserved - flipping the toggle back on lights everything up exactly as you left it. The reason: the free OpenCode routes log prompts and outputs by default per their docs, and that should be an explicit choice rather than a silent default.

### Fixed

- **Claude's thinking indicator stops cleanly after a manual `/compact`.** Earlier it would keep spinning indefinitely after `/compact` finished, and even survive a VS Code relaunch because the prior session's transcript still read as "mid-turn." The fix recognizes both the slash-form invocation Claude Code now writes and the `Compacted` completion marker, so the widget settles back to idle as soon as the compact summary lands. Auto-compact behavior is unchanged.
- **Bridge session tokens show up immediately on the first Big Pickle or Local LLM ask.** The widget used to display a bare token-only placeholder during the first Adaptive dispatch in a session and only switched to real numbers after the reply came back. Now the per-session context window is cached as soon as the session is created, so you see live tokens and percent remaining throughout the very first wait - the same behavior subsequent asks already had.
- **Codex disconnect/reconnect ceremony no longer flickers during parallel dispatches.** Sending one prompt to Big Pickle and another to Codex at roughly the same time used to make Codex's connection ceremony cycle multiple extra times because the bridge kept rediscovering the freshest backend's heartbeat instead of sticking with the Codex turn. The bridge now pins to the in-flight turn's own heartbeat, so Codex's animation cycles cleanly through its turn regardless of what the other backends are doing.
- **Usage widgets stay visible during normal idle gaps instead of flipping to offline after a few minutes.** Anthropic's stats endpoint sometimes returns cold-poll 429s when you've been quietly reading a long response. WAT321 used to absorb only a few of those before the widget switched to the idle skin, which made the bar feel like it was dropping out every 5-15 minutes. The absorption window now covers about an hour of idle - matching the Claude CLI's own idle threshold - so the bar keeps showing your last known numbers until you're actually away. As soon as you're active again, the next successful poll refreshes everything.

## [1.5.6] - 2026-05-15

### Changed

- **Reset is now scoped to the current workspace instead of your whole machine.** Earlier, resetting WAT321 in one VS Code window wiped every WAT321 file on disk, which silently killed the bridge servers running in your other open windows. Reset now clears only this workspace's state and refreshes the shared usage caches, leaving other windows' bridges and their state untouched. Toggling Epic Handshake off and on in any window remains the universal self-heal if you do want a clean slate for that window.

### Fixed

- **Dormant bridge entries left over from an older WAT321 layout get cleaned up automatically.** A previous registration mechanism wrote entries into your Claude config pointing at a script path WAT321 hasn't used in several releases. They were harmless but accumulating across workspaces. They're now swept on the next Epic Handshake activation. One-time and silent.

## [1.5.5] - 2026-05-15

### Added

- **Fire-and-forget actually works for Big Pickle and Local LLM.** Earlier versions accepted the dispatch but the call ran inside the bridge's MCP server process. If you closed VS Code or the server restarted while waiting, the reply died with it. Now every backend uses the same envelope-based path Codex has used since the start, so the call runs in the extension itself and survives MCP restart. If you close VS Code mid-call, a clear "cancelled by shutdown" note lands in the inbox instead of the work just disappearing.
- **Claude can opt out of sticky Adaptive on its own initiative for clearly long-running prompts.** The status bar toggle is still the user-facing default. A new on-demand reference doc tells Claude it has the option to dispatch fire-and-forget anyway when it can see a prompt will take 10+ minutes (full-codebase audits, multi-file refactors, deep doc reviews). The bar is high and the override is meant to spare you from sitting on a long timer, not to second-guess your toggle. Direct asks ("fire and forget Big Pickle") still behave exactly as before, and if you didn't intend the override you can flip the toggle off and Claude follows.

### Changed

- **The bridge tool surface is dramatically leaner per prompt.** Tool descriptions used to carry ~970 tokens of guidance into every single conversation turn, whether or not you ever asked Claude to use the bridge. The descriptions now sit at ~320 tokens combined and point at four on-demand reference docs Claude reads once if and when it needs the deeper guidance. Sessions that never touch the bridge pay roughly two-thirds less per turn for the same agent behavior.
- **Codex thread numbering recycles freed slots.** Earlier the S1 / S2 / S3 / ... counter on Codex bridge threads only ever climbed, so deleting threads in Codex's TUI didn't free up the lower numbers. The counter now picks the lowest unused slot, matching how OpenCode session aliases already worked. Delete all your threads and the next one is S1 again, and the menu plus the post-delete toast both show the actual next number instead of the inflated old counter.
- **The status bar wait-mode toggle and the bridge pause button are now per-window.** Toggling Adaptive to Fire-and-Forget in one VS Code window used to flip the mode for every other window on your machine, and pausing the bridge in one project would pause it everywhere. Each window now carries its own preference. Nothing crosses between them. Upgrading from 1.5.4 carries any prior persistent state into the first window that opens, so a paused 1.5.4 install stays paused after the upgrade.

### Fixed

- **Sticky Fire-and-Forget no longer silently waits when you ask a non-Codex tool.** Toggling the status bar widget to Fire-and-Forget and then asking Big Pickle or Local LLM used to fall through to a synchronous HTTP call and just hang Claude until the model replied, contradicting the mode you set. Sticky mode is now honored end-to-end for every backend.
- **The bridge inbox pulses immediately when a reply lands, not three seconds later.** A small safety gate that protected a different race was overzealous and added a noticeable wait between Codex finishing and the mail icon lighting up. Replies now show within about a second of arrival.
- **Checking the bridge inbox no longer reports a phantom failure when only Big Pickle or Local LLM replies are pending.** A leftover "No pending replies" message used to get stapled onto the front of an otherwise-successful drain, and Claude read it as a partial failure. The drain now returns only what's actually there, and when nothing's landed but dispatches are still running it tells Claude exactly which ones so the agent can report progress honestly instead of guessing.
- **Asking a Local LLM session that you just created actually finds the session.** Two related path bugs in the new dispatcher caused it to read the wrong config files and the wrong alias map, so newly-created sessions looked invisible.
- **The bridge widget animates all the way through stages 1 to 5 and plays the return arrow for Big Pickle and Local LLM.** Earlier versions pinned the walker at stage 3 for any non-Codex dispatch and the reply just appeared in the inbox with no completion ceremony. The dispatcher now walks the full sequence on every backend and writes the same per-workspace returning flag Codex uses, so the visual feedback is identical regardless of which model you're talking to.
- **The Codex widget stops flashing its debug-connect glyphs when a different backend is busy.** Asking Big Pickle or Local LLM used to make the Codex session-tokens widget briefly flicker as if Codex was reconnecting, even though Codex wasn't part of the call. The widget now reads which backend the active dispatch belongs to and stays calm when it's somebody else's turn.
- **The OpenCode widget shows the right model immediately and the count keeps moving while the model streams.** If you'd just asked Big Pickle and then dispatched to Local LLM, the widget would correctly switch to Local LLM but show Big Pickle's 80K context until the new dispatch completed. The widget now reads the in-flight heartbeat directly so the model name flips on the first frame, and during a dispatch the displayed count grows continuously - session total plus streaming progress - instead of freezing at the previous turn's number.
- **Deleting a Codex session no longer shows an inflated next-counter in the menu.** After deleting S15, the menu used to say MANAGE CODEX (S16) even though the next dispatch was actually going to use S1 via gap-fill. The menu now mirrors what the next spawn will actually pick, and the (S#) parenthetical disappears entirely when no active session is bound - matching how MANAGE OPENCODE and MANAGE LOCAL LLM behave at idle.
- **Delete-all Codex sessions actually returns the counter to S1.** Before, if you'd previously deleted a few sessions manually or via Reset, the leftover orphan entries in Codex's own session index would block the gap-fill: delete-all would think S1, S3, S4 were "taken" by orphans and the next spawn picked S2. The cleanup now also sweeps any bridge-pattern entries whose rollout files are missing, so a true clean slate yields S1.
- **The wait-mode dropdown never shows STANDARD.** Standard is an internal-only state that meant "no flag file on disk yet". If that ever happened (race during install, dir not yet created), the menu used to show WAIT MODE: STANDARD which isn't a state you can actually choose. The menu now displays ADAPTIVE in that case and the next click moves you to FIRE & FORGET as expected.

### Removed

## [1.5.4] - 2026-05-12

### Added

### Changed

- **Rate-limited usage widget tooltip names who's throttling.** When the Claude or Codex usage widget shows the Offline pill because the API server returned 429, the tooltip used to lead with the verbatim API response and a "Temporarily paused" line, leaving the user to guess whether the issue was their network, WAT321, or the provider. The technical content is unchanged, but a plain-language line now sits in between explaining that the throttle is on the provider's side and recovers automatically.

### Fixed

- **Usage widgets stop spinning forever when the network is unreachable.** Earlier versions absorbed the first three consecutive errors at the normal 122-second poll cadence before flipping the widget out of its spinning state - intentional cover for transient 429 cold-polls on Anthropic's stats endpoint, but it stranded the widget on the `$(loading~spin)` glyph for about six minutes when the underlying network was genuinely down (DNS failure, TCP reset, timeout). The spinner is still useful "still trying" feedback, so genuine network errors now absorb one retry at a tighter 30-second cadence and flip to the offline skin around the 30-40 second mark instead of six minutes in. The 429 cold-poll absorption is untouched.

### Removed

## [1.5.3] - 2026-05-12

### Added

- **Fire-and-forget mode is back for Codex dispatches over the unified bridge.** The v1.5.0 refactor folded `epic_handshake_ask` into the new `wat321_ask` tool but didn't carry the fire-and-forget short-circuit across, so flipping the wait-mode toggle in the Epic Handshake status bar had no effect on real dispatches - Claude would block on a long Codex turn until timeout regardless of what the toggle said. The unified bridge now honors the toggle exactly like the old path did, and `wat321_ask` also accepts an explicit `fire_and_forget` parameter that overrides the toggle per call. Long-running Codex tasks (multi-minute scrapes, large audits) return immediately with a dispatch id. Codex's reply lands in the Epic Handshake inbox and auto-includes on your next Claude-to-Codex prompt.
- **Claude's session-token widget shows the wait animation during Local LLM and OpenCode calls too.** Previously the 1Hz claude/blank blink only fired when Claude was waiting on Codex via Epic Handshake. Calls to Big Pickle, your Local LLM, or any Zen route looked indistinguishable from Claude idle. The widget now reads the OpenCode dispatch heartbeat directly so you can see at a glance that Claude is blocked on another backend, with the same visual signal regardless of which backend.

### Changed

- **OpenCode stays enabled across Reset and fresh installs.** OpenCode Routes was already enabled by default in the schema, but Reset WAT321 was explicitly disabling it on every clear and several internal reads still defaulted to off, which meant a Reset could leave you staring at an empty status bar wondering where Big Pickle went. Reset now clears the override so the schema default takes effect, and every place that reads the setting matches that default.
- **Bridge failure replies now invite you to investigate before bailing.** When Codex's dispatcher couldn't complete a turn, the bridge used to return a terse "couldn't complete this turn" with no path forward - even though Codex's underlying work often landed on disk before the bridge gave up. The reply now includes the chain id, hints that workspace artifacts may already exist (worth checking before declaring failure), and suggests retrying by reissuing the same prompt. The lower-layer error detail still goes only to the WAT321 Bridge output channel.

### Fixed

- **The "Waiting on Codex: Ns" tooltip line works again.** The v1.5.0 unified-bridge refactor stopped writing the wait-status sidecar that drove this tooltip line. It had been silently missing on every Codex dispatch since. The unified bridge writes the sidecar again, with a `finally`-block guarantee that it clears even when the dispatch throws or times out, so the tooltip never sticks on a phantom wait.

### Removed

- **Tool-use hint setting is gone (redundant).** The `wat321.openCode.toolUseHint` setting added in v1.5.2 was a system-channel directive sent on every dispatch to nudge small models toward calling `webfetch` on broad questions. The custom `wat321-research` agent shipped in the same release already has the same imperative pattern list in its own system prompt, so the hint was duplicating the rule across two surfaces with ~600 tokens of extra overhead per dispatch. Setting + plumbing removed. Behavior is unchanged because the agent prompt continues to drive the same webfetch bias.
- **Dead legacy bridge channel files purged.** The pre-v1.5.0 Epic Handshake MCP server (`bin/channel.mjs` plus three internal helpers) stopped being registered with Claude Code when the unified bridge took over, but the files were still being copied into every .vsix and extracted to disk on every Epic Handshake activate. ~400 LOC of dead code removed from the extension. The vsix is slightly smaller and there's one less "is this still load-bearing" decision for future maintenance.

## [1.5.2] - 2026-05-09

### Added

- **Bridge nudges Big Pickle and your Local LLM toward `webfetch` on broad questions.** Some routable models classify "best of right now", opinion, current-events, or specific-people questions as answerable from training data and skip tool calls entirely - the reply ends up stale or hallucinated even when `webfetch` was available. The bridge now ships a short tool-use directive to every dispatch via OpenCode's per-message system channel and the chat-completions `system` slot for one-shots, with imperative wording and concrete trigger shapes so smaller models can match the patterns and webfetch first instead of answering from training. The directive is invisible in the displayed prompt and reply, and you can disable it from the OpenCode section of WAT321 settings (`wat321.openCode.toolUseHint`) if you'd rather send prompts verbatim.
- **The bridge works in folderless VS Code windows now.** Enabling Epic Handshake without an open workspace folder used to leave the bridge widget visible but unreachable - the MCP registration silently skipped, so asking the bridge for codex or your local LLM fell through to whatever Claude could improvise (raw `codex exec` calls, curl probes for ollama). Folderless windows now get a user-scope MCP registration with their own `default` client state, so a window with no folder still has a working bridge. Open a folder later and the per-folder registration takes over automatically. The folderless state stays out of the way under its own client dir with no leak between modes.
- **Bridge dispatches now run as a research agent instead of OpenCode's coding agent.** Every Big Pickle / Local LLM / Zen-route prompt going through `wat321_ask` was inheriting OpenCode's default `build` agent, whose system prompt explicitly tells the model not to guess URLs unless they're for programming help - the cause of the "I cannot access live data" refusal you'd see when asking about current events, sports leaderboards, or product listings. The bridge now declares its own `wat321-research` agent in the OpenCode harness and dispatches every session against it. The research agent's prompt encourages plausible-URL guessing, includes pattern hints for Wikipedia / Cars.com / Steam / IMDb / Reddit / GitHub / DuckDuckGo, and restricts the toolset to `webfetch` only so the model isn't tempted into bash/edit/write paths irrelevant to research questions.

### Changed

- **Toggling Enable OpenCode is silent now.** The "OpenCode Routes is ready" / "OpenCode Routes disabled" toasts that fired on the setting flip were redundant - Epic Handshake's enable toast already covers what to do next, and the OpenCode widget appearing or disappearing in the status bar is its own state signal. Same toggle, no popup.
- **Tokens-per-second appears faster and reads steadier.** The widget used to stare blank for ~5 seconds at the start of an active turn while the underlying tracker waited for its smoothing window to mature, then once it appeared the displayed value would flicker rapidly as new readings landed sub-second. The tracker now reports a rate after about 2 seconds of streaming, and the visible "NNtps" number updates once per second so the readout reads as signal instead of noise.

### Fixed

- **The TPS counter setting now applies immediately when you toggle it.** Earlier versions cached the prior value until the next 15-second service emission, so checking or unchecking the box looked like nothing happened. The widget now re-renders on the toggle directly.
- **The Tool-use hint setting now applies when you flip it.** The setting wrote to package.json correctly but no listener was wired into the OpenCode Routes settings watcher, so toggling it didn't take effect until you reopened VS Code. The watcher now reacts on the toggle and rewrites the bridge config immediately, so the next prompt picks up your new preference without a reload.

### Removed

## [1.5.1] - 2026-05-08

### Added

- **Full-prompt header on bridge replies.** Recent Claude Code builds collapse MCP tool-call inputs into a single OUT row, so when Claude asked Codex / Big Pickle / Local LLM through the bridge you'd see the answer but not the question. Bridge replies now lead with the full prompt rendered as a markdown blockquote (`> Big Pickle: ...`) above the answer so you always see exactly what was asked, even for paragraph-long prompts that a truncated summary would clip.
- **Tokens-per-second clears on its own after a turn ends.** The widget used to pin the last in-flight rate forever once the rollout stopped writing - especially noticeable over the bridge, where Codex emits token counts only at turn boundaries and the readout could sit at "944 tps" for minutes after generation actually stopped. The tracker now clears the rate after 10 seconds of real-time silence regardless of whether the transcript file moved, so an idle widget reads idle.

### Changed

- **Bridge reply prompt header capped at 500 chars.** Long code-review prompts used to echo back into the response in full, padding Claude's reasoning context with the same content it just sent. Long prompts now show the first 500 characters with an ellipsis. Short prompts are unchanged.

- **OpenCode setting description rewritten.** The Settings page entry for OpenCode now reads in parallel with the Claude and Codex entries - lead with what enabling does for widgets, then call out the managed `opencode serve` harness and the free-model catalog, then a clearly scoped data-usage notice that applies to the free Zen routes only and not to your local LLM.

### Fixed

- **OpenCode harness starts again on the latest opencode CLI.** OpenCode 1.14.39 tightened its config schema so a partial `limit` block (only `context`, no `output`) gets rejected with `ConfigInvalidError`, which silently killed the harness and left every Big Pickle / Local LLM / Zen-route prompt erroring with "opencode serve is not running." The local route's `limit` block is now omitted entirely - opencode falls back to its 32K default, the v1.4.7 reasoning-model headroom is preserved, and Big Pickle / Local LLM dispatches work again.
- **Big Pickle and Local LLM stay reachable after activate-time hiccups.** The harness URL used to be written into config.json only at activate. If the activate-time spawn raced or failed and a follow-up spawn succeeded, nothing carried the new URL back into config and dispatches would error with "opencode serve is not running" while opencode was actually healthy. The harness now reports every URL transition and the bridge config rewrites itself to match, so a successful spawn is always reachable.
- **Reset WAT321 now actually resets the Codex Session Settings.** Earlier versions could leave the sandbox permission stuck on Full-Access (or your previously picked model) after a Reset, because the global directory wipe would silently bail on Windows when any file in the tree was locked by a still-running bridge process. The Codex override flags are now swept directly during Reset's cross-tool cleanup, so the Session Settings menu always returns to Read-Only + default model regardless of what happens to the rest of the wipe.

### Removed

## [1.5.0] - 2026-05-08

### Added

- **Two VS Code windows can run the bridge side by side now.** Earlier versions had every window writing to the same alias map, harness URL, and heartbeat file - asking a question in one window could lock up state in the other or land replies in the wrong place. Each window now keeps its own bridge state, MCP registration, and OpenCode harness on its own port, all under your workspace's identity. Open as many as you want. They stay out of each other's way.
- **Same-workspace duplicate-dispatch protection.** When two windows happen to be on the same workspace, the bridge now hands each Codex envelope to exactly one window via a per-envelope claim. Earlier versions could send the same prompt to Codex twice and write two replies. The losing window simply skips. If the winning window crashes mid-turn, the claim ages out and the survivor picks the envelope back up.

### Changed

- **Confirm dialogs land as toasts now, not blocking modals.** Reset session totals, clear the Zen API key, erase an OpenCode Routes thread, delete a Codex session - every confirmation prompt previously interrupted you with a centered window. Same prompts now slide in from the bottom-right with the same Action / Cancel buttons. You can keep typing while you decide.
- **Local LLM tool-calling unblocked for reasoning models.** Earlier versions capped the local route's output budget at 4K, which pushed Qwen3-style reasoning models to skip the tool call and answer from training data instead. Output budget is now unconstrained on the local route so the model has room to think before deciding to use a tool.
- **Model Bridge widget is now OpenCode Routes.** The widget label, dropdown header, output channel, command titles, and every confirmation toast read "OpenCode Routes" - the new name reflects what the widget actually does, which is route prompts to OpenCode, Big Pickle, the Zen catalog, or your local LLM. Existing settings, on-disk state, and the historical setting key namespace all carry over without any action on your part.

### Fixed

- **Tokens-per-second no longer spikes on the first turn after Codex starts up.** When the widget began watching an existing Codex rollout that already had cumulative tokens on disk, the first computable rate window measured from "tokens already there" to "tokens after the next chunk", which capped at 999/s for a few seconds before the math settled. The tracker now anchors on the first sample it sees and only reports rates from increments observed strictly after that.
- **OpenCode Routes widget lights up in folderless windows.** Without an open folder, the heartbeat reader was gated on a workspace-hash check that returned null and silently blocked every read. The per-client directory layout already covers the no-folder case, so the gate is gone and the badge renders correctly.

### Removed

## [1.4.7] - 2026-05-07

### Changed

- **Tokens-per-second now stays steady prompt-to-prompt.** Earlier versions could swing from around 50/s to 150/s between turns even when the model was writing at the same pace. The math used to advance its time window on every poll, including polls where the token count hadn't changed - server-thinking pauses and bookkeeping writes ate into the rate without contributing any tokens. The widget now only counts moments when tokens actually moved, so the readout reflects real generation speed.
- **Bridge dispatches show a live rate sooner.** Big Pickle and Local LLM prompts that finish in 4-6 seconds used to read 0/s for their entire run because the rate-smoothing window needed 5 seconds of activity before reporting a number. Short bridge calls now start reporting after 2 seconds while the longer Claude and Codex transcript widgets keep the original 5-second floor.
- **README rewrite.** The "experimental" labels are gone, the retired Model Bridge section was dropped, and the Epic Handshake section now reads as one unified bridge story - ask Codex, OpenCode, or your local LLM in plain language and the right backend picks it up. The Display Modes list also gained the "Full + Compact" entry that was already a setting but wasn't documented.

## [1.4.6] - 2026-05-07

### Added

- **Live tokens-per-second now reads sensibly across all four backends.** Earlier versions could spike to 999/s on the first prompt of a Claude or Codex session, sag toward zero during idle gaps between prompts, and run uncapped on Local LLM (capped at 15000+ in the field). The widget now smooths the rate over the last 60 seconds of actual writes - idle wall-clock no longer drags the average, the first sample-pair after a session starts no longer spikes, and every backend caps at the same 999/s ceiling.
- **Per-workspace bridge activity.** When two VS Code windows had the bridge enabled, asking a question in one window used to light up the icons in both. Each window now watches its own workspace's heartbeat file, so a sibling window stays dark while you work.

### Changed

- **Backend menus polished.** The dropdown rows now read "Manage Codex (S#)" / "Manage OpenCode (S#)" / "Manage Local LLM (S#)" - no more "Sessions" suffix on the row label, the "(S#)" suffix carries the active count. Inside each submenu, the session row reads simply as "Codex Session:" / "OpenCode Session:" / "Local LLM Session:" - the "Current" prefix is gone since the active session is now marked with a green check (✔️) wherever it appears in switch sub-pickers and model pickers. Reset / Delete / Delete All rows recovered their inline descriptions ("Fresh session on next prompt." etc.) that got trimmed too aggressively in the last release.
- **Back / Pause / Cancel on every sub-picker.** OpenCode and Local LLM switch sub-pickers (the "Pick a session to mark active" picker) gained the standard navigation footer, matching the Codex side. The legacy Model Bridge active-instance picker got the same treatment.
- **Status bar icons render at the right size now.** The llama, OpenCode, and the wat321 square family all carried unused padding inside their viewBox, so the icon-font generator scaled the visible glyph 20-25% smaller than peer codicons. Source files were tightened to the actual content bounds. Codepoints stay stable.
- **Tokens-per-second poll cadence dropped from 5 seconds to 3 seconds** for a more responsive readout during active turns. Detection is event-driven (fs.watch) so the change adds essentially no overhead.

### Fixed

- **Local LLM tps was reading character count instead of tokens.** SSE text part-update lengths are character counts. The bridge was forwarding them as tokens with no conversion, so the widget read roughly 4x higher than what Claude or Codex would show for equivalent output. The bridge now approximates `chars / 4` to match the magnitude the transcript-based widgets report.
- **Stale references to retired Model Bridge tools** removed from the Model Bridge widget's click-menu strings. The harness toggle, manage-sessions row, auto-compact row, and default-agent row described `model_bridge_thread` / `model_bridge_task` tools that no longer exist. Wording is now generic harness language.
- **Tps no longer ghost-renders the pre-reset rate after a compaction.** A token rollback used to clear the sample window but kept the cached rate displayed until the new window aged in. Both clear together now.

### Removed

## [1.4.5] - 2026-05-07

### Added

- **OpenCode and Local LLM session menus now follow the Codex flow.** Earlier versions had separate NEW / DELETE / RENAME sub-pickers for each backend. Now every backend's session menu reads the same way: a single CURRENT row showing the active session, RESET to start fresh on the next prompt, DELETE for the active session, DELETE ALL to clear everything. Sessions are auto-created on the first prompt - you no longer have to ask Claude to call `wat321_session({action:"create"})` before dispatching.
- **Token tracking now works for non-streaming OpenCode models.** Big Pickle and other zen-routed models return the assistant reply as one big chunk after the model finishes, so the SSE stream never produced enough events to drive the live tokens/tps readout. The bridge now polls the session message endpoint every 2 seconds during a dispatch and feeds the heartbeat from whichever source - SSE or poll - is producing higher numbers. The widget shows `Nt @ X/s` for both streaming and non-streaming backends.
- **Local LLM Model Settings row** opens VS Code's Settings UI filtered to the relevant local-side keys when clicked. Replaces the placeholder Local LLM Model row which used to show only the catalog alias and have no useful click action.

### Changed

- **Codex menu reorganized to read more like the rest of the system.** The SESSION SETTINGS row is now MODEL SETTINGS (effort + model + sandbox live there). A new CURRENT CODEX SESSION row at the top of the menu shows the active S# and lets you switch between recoverable sessions. It subsumes the old standalone RECOVER row. DELETE CODEX SESSION shows the active S# inline, e.g. `DELETE CODEX SESSION (S2)`, and is hidden when no session exists yet.
- **Restart Codex Bridge renamed to Restart Epic Handshake Bridge** in the dropdown menu, command palette, and recovery hint text. The bridge handles every backend now, not just Codex - the old name was a leftover from when Codex was the only target.
- **Session-token tooltip is significantly leaner.** Dropped the per-turn extras (active tool name, tool-call count, output tokens, cached %, streaming tps line) from the Claude tooltip - they duplicated info already visible in the widget label or the underlying CLI. Codex's mid-turn block (stage / plan / tool count / thinking) now only shows when the Epic Handshake bridge is actively driving the session, so a standalone Codex chat doesn't double-report what Codex's CLI already prints. Auto-Compact moved to the bottom of the tooltip. The cache-event line renamed from "Most recent" to "Most recent cache HIT" for clarity.
- **OpenCode setting description rewritten with a data-usage note.** The free-models list now matches OpenCode's actual catalog (Big Pickle, MiniMax M2.5 Free, Ling 2.6 Flash Free, Hy3 Preview Free, Nemotron 3 Super Free) and a second paragraph explains that during the free period collected data may be used to improve the model, with NVIDIA-specific logging called out for Nemotron. Source: opencode.ai/docs/zen.
- **Local Endpoint setting moved** from the OpenCode section to the Epic Handshake section, sitting under Suppress Codex Notifications. Easier to find when configuring the bridge end-to-end.
- **OpenCode widget icon swapped to an inverted outlined square.** Replaces the previous outlined double-square. The new version reads cleaner at status-bar size.

### Fixed

- **First text frame of every dispatch is no longer discarded.** OpenCode's event stream emits the assistant's first text fragment slightly before the message-role classification arrives. The previous logic gated text-progress events on already-knowing the message was assistant, so the early frame got dropped, the heartbeat stayed at zero, and the widget fell back to elapsed-seconds display. Any text part with a message id is now counted as assistant-bound.
- **BACK from OpenCode and Local LLM session menus returns to the main menu.** Previously these submenus closed entirely when you picked BACK, leaving you to click the widget again to navigate. Now they re-open the main menu the way the Codex submenu always has.
- **Bridge dispatches that omit `session` now resolve correctly.** Earlier versions errored on `wat321_ask` calls without an explicit session argument. The bridge now falls back to the active alias the menu's CURRENT row tracks, and auto-creates a session if none is active. The menu's "Created on next prompt to OpenCode" hint actually delivers.

### Removed

- **NEW SESSION, DELETE SESSION sub-picker, and RENAME SESSION rows** from the OpenCode and Local LLM menus. Sessions are auto-created on first prompt. Deletion targets the active session via the standard DELETE row. Renaming was rarely used and added clutter.
- **Standalone RECOVER row** from the Codex menu. Recoverable sessions now surface as alternatives in the CURRENT CODEX SESSION sub-picker.

## [1.4.4] - 2026-05-07

### Added

- **Live tokens-per-second on the OpenCode and Local LLM widgets.** Earlier versions showed only elapsed seconds during a dispatch. Now the widget reads `Nt @ X/s` while a turn is generating. The bridge taps OpenCode's event stream and feeds char-count progress into the heartbeat as the assistant's reply accumulates.
- **Epic Handshake animation cycle now plays on OpenCode and Local LLM dispatches too.** Same numbered-stage walk and arrow animation Codex turns get - so the widget reads "in progress" the same way regardless of which backend is active. Stage transitions are time-driven for now (placeholder until the Phased Messaging framework lands real per-backend events).
- **New llama icon for the Local LLM widget.** Idle state on Local LLM now reads with a llama silhouette instead of the generic square. OpenCode/Big Pickle dispatches show a new outlined opencode square. Both share the standard chat-bubble alternation when a turn is active, so all four backends (Claude, Codex, OpenCode, Local LLM) move to the same rhythm.
- **Sessions remember the model they were created on.** Earlier versions used your currently-active instance to label a resumed session, so flipping the MODEL row mid-flight made the widget say "Big Pickle" while you were actually talking to GPT 5 Nano. The alias map now carries the bound instance id. Resume always shows the model the session was actually created with.

### Changed

- **Tokens-per-second readout averages over the last 60 seconds of activity.** The previous smoothing approach sampled per-tick deltas of a token field that only updates at turn boundary on Codex - the widget froze mid-turn, then capped at 999/s when the boundary jump landed. The new approach snapshots cumulative tokens at every poll and reports the slope across the window. Compaction resets handled automatically.
- **Local Endpoint setting was renamed and reworded.** The setting that used to be `wat321.modelBridge.localEndpoint` is now `wat321.localEndpoint` and lives next to the OpenCode toggle. Description spells out "leave empty if you don't have a local LLM" with examples for both same-machine and LAN-server setups. The old key migrates automatically on first launch.
- **OpenCode toggle name cleaned up.** The setting that used to read "WAT321 › Model Bridge: Enabled" now reads "WAT321 › OpenCode: Enable Open Code". "Model Bridge" was internal vocabulary that didn't tell you what the toggle did.
- **Status-bar widget for OpenCode/Local LLM is tooltip-only across all backends.** Click does nothing. Hover shows the status. All session and instance management lives on the Epic Handshake dropdown, where it can stay consistent across every backend instead of branching by widget.
- **Epic Handshake activates with either backend installed.** Earlier versions required both Claude and Codex CLIs. Now Claude is mandatory, plus at least one of Codex or OpenCode - so an OpenCode-only setup (no Codex) can still run the bridge and route to Big Pickle / Local LLM via natural language.
- **Epic Handshake section title is now "Claude-to-Any-LLM"** to match what the bridge actually does. Previously read "Claude to Codex Only" which was true on day one and outdated by the time OpenCode + Local LLM landed.
- **Settings UI ordering: "Enable Heatmap" moved above "Status Bar Priority"** in the General section so display preferences cluster together before the priority knob.
- **MiniMax catalog label updated to M2.7** to match the version the upstream Zen route is currently serving.

### Fixed

- **OpenCode session creation no longer binds to Local LLM by mistake.** When your active instance was set to local-llm and you created a fresh OpenCode session, the bridge would inherit the local-kind active instance for the new opencode session - your remote session ended up bound to llama.cpp instead of Big Pickle. The bridge now filters the active-instance fallback by target kind so opencode and local sessions only inherit their own kind.
- **The "WAT321: Model Bridge - Menu" command palette entry actually works now.** It contributed `wat321.modelBridge.menu` while the registered handler was `wat321.modelBridge.legacyMenu` - the entry was orphan and did nothing on click. Realigned the names. The entry now opens the legacy click-menu as labeled.
- **Epic Handshake gate alignment.** The internal "is this bridge runnable" check still required both Claude and Codex even though the activation gate had been relaxed to accept either Codex or OpenCode. Without this fix, an OpenCode-only user could pass activation but the bridge would refuse to handle settings transitions correctly. Both gates now agree.
- **Local Endpoint default fallback consistency.** One read path defaulted to `http://127.0.0.1:8080` while the schema and other paths defaulted to empty. A user with no local server configured could see a phantom catalog entry until a different code path overwrote it. All paths now agree on empty.

### Removed

- **Epic Handshake bridge-mode dropdown.** The five-option enum (Auto, Codex + OpenCode, Codex Only, OpenCode Only, Local LLM Only) was supposed to narrow Claude's MCP tool surface, but the v1.4.3 router refactor already cut the surface to two tools regardless of mode. The dropdown stopped earning its complexity. Existing values get swept on first launch.
- **"Experimental" wording on Epic Handshake.** The bridge has been stable through several releases. The label was outdated.
- **A 2200-line dead legacy script.** The bundled `WAT321_MODEL_BRIDGE/bin/channel.mjs` was retired when the unified bridge took over but still shipped in every vsix. Cleaning it out drops package size by ~30KB and removes a frequent source of "is this still used?" confusion.

## [1.4.3] - 2026-05-06

### Added

- **Ask any AI by name and the bridge figures out the rest.** A new server-side router now resolves free-form names like "Big Pickle", "Codex", "Local LLM", or partial aliases like "Pickle" or "Nano" to the right backend. You don't pick from a menu - you say what you want and the router matches it against the catalog, with fuzzy lookup for partials. This shrinks the system-prompt overhead Claude carries from your bridge tools by about 75%, which matters most on long-context conversations.
- **Live model catalog and session list, available on demand.** Claude can now read `bridge://instances`, `bridge://sessions/opencode`, `bridge://sessions/local`, `bridge://inbox/codex`, and `bridge://status` as MCP resources. Ask "what models do I have?" and Claude fetches the catalog without you paying for those tool descriptions in every other turn.
- **Sandbox permission is back as its own row.** Manage Codex Sessions -> Codex Session Settings now shows MODEL, EFFORT, and SANDBOX PERMISSION as three top-level rows. One click toggles between Read-Only and Full-Access without diving into a sub-picker.
- **Smarter \*default\* tag.** The `*default*` indicator next to your sandbox setting now disappears the moment you make a deliberate choice, even if you happen to pick the schema default. Once you've touched the row, the tag stays off forever (until Reset). Says "you've made a choice" instead of "you haven't done anything."
- **Status bar widget mirrors your last-used backend.** Run something on Big Pickle and the Model Bridge widget reads "Big Pickle" until your next dispatch flips it. Earlier versions stuck on whichever instance was set as the default. Now you see what just ran.
- **Sessions get readable names.** Every persistent session WAT321 manages now shows up as `<Project> Epic Handshake Claude-to-<Target> S<n>` in the menu list, replacing OpenCode's auto-generated slug ("eager-knight" and friends). Same naming convention across Codex, OpenCode, and Local LLM.
- **MODEL row on the OpenCode session manager.** Pick a different backend (Big Pickle, GPT 5 Nano, etc.) without leaving the menu. Affects the next NEW SESSION. Existing sessions stay on whatever model they were created with (OpenCode constraint, not ours).
- **Toasts on key transitions.** Enabling or disabling Model Bridge surfaces a "ready" / "disabled" toast in the same voice Epic Handshake uses. Bridge mode and status bar priority changes show a passive reload reminder.

### Changed

- **Epic Handshake's enable flag is now the single switch for the bridge.** Flipping Epic Handshake on installs the unified `wat321` MCP server. Flipping it off sweeps it. The previous experimental `wat321.bridge.useUnified` setting is gone, the install/uninstall command palette entries are gone, and the rollback menu row introduced in v1.4.2 is gone. One toggle handles the whole lifecycle.
- **Display Mode picks up a "Full + Compact" option.** It replaces the standalone "Session Tokens Compact" checkbox - now you choose how the status bar reads as a single setting. "Full + Compact" keeps the usage widgets at full size while shrinking session-token labels. Existing users with the old boolean turned on get migrated automatically.
- **Local LLM endpoint defaults to empty.** Instead of assuming `http://127.0.0.1:8080` is your local server, the setting starts blank. Empty means local LLM is hidden from the catalog and not registered as a routable target. Fill in your real endpoint to turn it on.
- **Tokens-per-second readout averages over a minute.** Was 5 seconds, which jittered hard between bursty assistant chunks. The new 60-second rolling window combined with 5-second polling produces a steady reading that still reacts to genuine rate changes within a few samples.

### Fixed

- **The bridge router now refuses to dispatch to disabled targets.** Before, a Claude session that had cached the bridge tool schema before you turned a target off could still try to route to it. The router now checks every dispatch against your live settings and returns a clean error if the target is off.
- **Reading the inbox no longer consumes it.** The `bridge://inbox/codex` MCP resource peeks at queued late replies without moving them out of the inbox. The active dispatch path (which deliberately consumes them when injecting into the next assistant turn) keeps the previous behavior. Only the resource read is non-destructive.
- **Epic Handshake works when bridge mode skips Codex.** Earlier versions still required the Codex CLI to be installed even when bridge mode was OpenCode Only or Local LLM Only. Now the Codex CLI check only fires when the mode actually routes to Codex.
- **Stale session actions cleaned up.** The session-management tool used to accept `list` and `resume` actions that the schema had already dropped. Calling them now returns a clear "use the session resource" pointer instead of running unintended code paths.
- **Comments and tool descriptions reflect the actual behavior.** TPS service comments still said "5-second window" while the code used 60 seconds. Cleaned up. Several stale references to retired tools (`wat321_inbox`, `wat321_list`, the experimental flag) removed from file headers and inline notes. Independent audit pass caught what the in-house pass missed.

### Removed

- **`wat321.bridge.useUnified` setting.** Single-switch lifecycle owned by Epic Handshake makes it redundant. Existing users with the setting present get it cleaned up automatically on first activate.
- **Two MCP tools: `wat321_inbox` and `wat321_list`.** Their content moved to MCP resources, where it costs Claude tokens only when it's actually read.
- **Two command palette entries: `WAT321: Bridge - Install/Uninstall Unified MCP Server`.** The commands stay registered as internal-only so Epic Handshake can dispatch them. No user-facing palette entries.
- **Standalone "Session Tokens Compact" setting.** Folded into Display Mode as the new "Full + Compact" enum option.

## [1.4.2] - 2026-05-06

### Added

- **A recovery row on the Epic Handshake widget** for users who turned on the experimental unified bridge and want to roll back. Click the EH widget. If you've ever run `Bridge - Install Unified MCP Server`, an UNINSTALL UNIFIED BRIDGE row appears at the bottom. One click flips the flag back, sweeps the unified MCP entry, and restores the legacy two-server topology on next reload. Until this, Reset was the only escape - easy to miss.

### Changed

- **Reset is fully factory-clean now.** Previously, Reset removed the legacy bridge MCP entries but left the unified bridge's pre-allowed tool list (`mcp__wat321__wat321_ask`, etc.) sitting in your Claude settings. Now Reset sweeps both. If you were using the experimental unified bridge and want a true clean slate, Reset gives you one.
- **Settings UI ordering tweak:** the bridge-mode dropdown now sits below the Codex notifications toggle in the Epic Handshake section, where it reads more intuitively.

### Fixed

- **The 1.4.1 release was broken on fresh installs - widgets never loaded.** A circular import in the new bridge tier crashed the extension's activation before any status-bar widget could register. The 1.4.1 GitHub Release was pulled mid-day. 1.4.2 ships everything that was in 1.4.1 with the regression fixed. If you happened to install 1.4.1 in the half-hour it was up, this version restores normal behavior on next reload.

### Removed

## [1.4.1] - 2026-05-06

### Added

- **A unified bridge MCP server is now available behind a feature flag.** One `wat321` entry replaces the two-server topology (Epic Handshake + Model Bridge), exposing four tools - `wat321_ask`, `wat321_inbox`, `wat321_list`, `wat321_session` - with a single `target` parameter that picks `codex`, `opencode`, or `local`. Fewer tool slots in Claude's system prompt, less drift between the two bridges. Off by default. Install via `WAT321: Bridge - Install Unified MCP Server` to opt in.
- **A bridge-mode dropdown on Epic Handshake** lets you narrow what the unified server advertises: Auto (All), Codex + OpenCode, Codex Only, OpenCode Only, or Local LLM Only. The narrower the slice, the fewer tool descriptions Claude has to carry. Useful when you only want one route active for a given session.
- **Three Manage submenus on the Epic Handshake widget** - Manage Codex Sessions, Manage OpenCode Sessions, and Manage Local LLM Sessions. All three follow the same row layout: BACK, the session list, NEW, DELETE, RENAME, CANCEL. The Model Bridge widget click now routes to whichever submenu matches the active instance, so all session management lives in one menu rather than two.
- **A compact display option for the session-tokens widgets.** `wat321.sessionTokens.compact` shrinks the Claude and Codex session-token labels without affecting the usage widgets. Cuts status-bar real estate when the bar fills up.
- **Live tokens-per-second now averages over a five-second window** instead of jittering on the most recent sample. The widget rejects intervals longer than 30 seconds (tool waits, bridge waits) so a quiet stretch doesn't drag the average to zero. Persistent across idle, caps at 999/s.
- **Big Pickle works without a Zen API key.** The free Zen tier accepts anonymous requests, and WAT321 now knows that - the red "missing API key" badge no longer fires for free routes. Click the widget, pick Big Pickle, dispatch.

### Changed

- **The Codex session-settings menu collapses to two rows.** Sandbox now lives inside the Effort sub-picker rather than as its own top-level entry. One less hop for the common edit flow.
- **Reset turns both bridges off.** Previously, Reset only forced Epic Handshake off and let Model Bridge re-enable itself from its schema default. Now both flip to disabled together, matching what "reset" usually means.
- **The wait-mode setting is gone.** Adaptive is now the fixed activate-time default. The toggle was always going to land on adaptive, so the option just added noise. Click-menu entry, schema key, runtime watcher, parser all stripped.
- **The local LLM endpoint setting moved.** It's now under the Epic Handshake section right below `suppressCodexNotifications`, where the rest of the bridge configuration lives.
- **The CLI binary search order flipped.** WAT321 now tries the extension-bundled CLI first and falls back to your PATH, matching how the marketplace install is meant to work.
- **The Local LLM widget shows just tokens and TPS during a run.** Phase tags (`RECEIPT`, `STARTED`, `HALFWAY`, etc.) used to sit in the widget text - they're now stripped. The tooltip still shows full phase progression.
- **The MISS-unclear tooltip on Claude session tokens is more specific.** Instead of "cause unclear", it now says what was ruled out (TTL gap, large tool payload, post-compact rebuild) and what's most likely left (tool schema change or system-prompt mutation). Conservative classification - false positives on LOAD events are worse than ambiguous tooltips.

### Fixed

- **A second root cause behind the "Codex went silent for five minutes then said it ran out of time" failure.** The adaptive hard cap was silently overriding caller-supplied `timeout_sec`, so a 15-minute request still got killed at five. The cap is now a runaway protection (intended to fire when something genuinely went wrong), not a working ceiling. Per-stage adaptive timeouts are designed for v1.5 as the proper enhancement.
- **The inbox watcher silently falling back to polling at fresh VS Code start.** When the inbox directory didn't exist yet at activate, the coordinator marked itself as "watching" without actually attaching - and then never retried. Inbox arrival reactivity dropped from ~50 ms (fs.watch) to five seconds (polling backstop). Fixed: the coordinator retries until the watch actually attaches.
- **A class of unified-bridge dispatch bugs.** `target=local` one-shots silently routed to Big Pickle because the local catalog leaves the `model` field blank by design. Empty-prompt retrieval against an existing OpenCode session was contradictory between the two tools. Active-instance fallback was unimplemented. The bridge-mode dropdown wasn't wired into the config writer. The atomic-rename pattern in the alias-map writer was broken (wrote the tmp file, then wrote again to the destination, defeating the point). All five caught by an independent Codex audit run. All five fixed.

### Removed

- **`epicHandshake.defaultWaitMode` is gone from settings.json.** Adaptive is the activate-time default. Pause/resume still works at runtime via the click menu.

## [1.4.0] - 2026-05-05

### Added

- **OpenCode is now its own top-level setting alongside Claude and Codex.** Turn it on once and Big Pickle, GPT 5 Nano, Ling, Hy3, Nemotron, and MiniMax M2.5 light up as routable models in your Claude sessions, plus your local LLM if you've pointed WAT321 at one. WAT321 spawns and manages a private `opencode serve` on your dev box automatically when you turn it on, so the tool-using harness operates against your real workspace instead of a remote machine.
- **Live tokens-per-second now show on the bridge widget during tool-using runs.** Previously the widget went silent for 30+ seconds while the harness chewed through tools. Now you see real token motion the whole time. The same readout that worked for direct chat completions now works for everything.
- **Cumulative session tokens appear right on the Model Bridge widget label.** Glance and see "Big Pickle 12.4k" - what the active instance has cost you so far this session.
- **Pause and Cancel show up at the bottom of the Model Bridge click menu** with the same color vocabulary as Epic Handshake. Pause blocks new tool calls without interrupting whatever's running. Cancel aborts the active call. Click the widget, scroll to the bottom.
- **A read-only KV Cache row in the click menu** tells you what context size your local LLM is running with, probed from llama-server's own properties. No more SSH'ing in to read the launcher script.
- **A Default Agent picker** lets you choose which OpenCode agent (build, explore, general, or plan) the harness uses by default. Most folks want `build`. Switch to `explore` when you only want the model reading your code, not editing it.
- **Manage OpenCode Sessions row in Epic Handshake's menu** so all your bridge session management lives in one dropdown.
- **The wait-mode setting is now visible in the Settings UI.** It used to be runtime-only and editable only via settings.json by hand.

### Changed

- **The Model Bridge settings page is now just two fields instead of five.** Empty out the local LLM endpoint to disable local routing. Fill it in to enable. No more separate boolean toggles to keep in sync. We commit to running OpenCode locally rather than letting users point it at remote machines - simpler to reason about, faster, no LAN hop.
- **Phased protocol default is single-shot markers.** The plan was for gated 5-step to be the default, but it makes every local LLM call do five sequential round-trips, which blew the timeout on anything past simple math. Gated mode is still available - flip it on via the click menu when you want it.
- **Click menu rebuilt to match Epic Handshake's structured layout.** Every submenu has a BACK row at the top. Pause / resume / cancel always live at the bottom. Less scrolling, more muscle memory between the two bridges.
- **The local LLM box no longer needs OpenCode installed.** WAT321 spawns OpenCode on your dev box now. Your inference box just runs llama.cpp.

### Fixed

- **A class of "the bridge swallowed my reply" failures in Epic Handshake** where transport hiccups would lose the right notifications and block the rollout-recovery branches that exist for exactly that case. Recovery now triggers on either rollout-poller progress or `turn/completed` arrival, not just on every prior RPC notification surviving.
- **The OpenCode harness rejecting "model not found"** for whatever local model you had loaded. The wire identifier is now decoupled from the actual model - llama.cpp ignores the model field anyway.
- **The OpenCode subprocess outliving VS Code on close.** When you quit VS Code, our managed subprocess now actually dies with it.
- **A subtle race where canceling one tool call could interrupt a different one.** The cancel signal now scopes to the call it was meant for.
- **Gated phased mode correctly holds the busy-gate** across all five round-trips so a parallel call can't slip in between phases.

### Removed

- **Three Model Bridge settings keys: localEnabled, useManagedOpenCode, externalOpenCodeUrl.** They were redundant booleans on top of the URL fields. If you had `useManagedOpenCode: false` + an `externalOpenCodeUrl` set, you'll silently move to managed local OpenCode on upgrade.
- **OpenCode hosting from the LLM box.** No more `Start OpenCode Server` shortcut, no `start-ai-stack.ps1`, no `~/opencode/` package install on the inference machine. Pure llama.cpp.

## [1.3.0] - 2026-05-05

### Added

- **A new MCP-driven Model Bridge lets Claude consult any OpenAI-compatible LLM you point it at.** Toggle `wat321.modelBridge.enabled` and Claude gains five new tools: `model_bridge_ask` (one-shot streaming chat), `model_bridge_thread` (persistent multi-turn with auto-compact), `model_bridge_inbox` (async results), `model_bridge_task` (tool-using sub-agent via OpenCode), and `model_bridge_list` (inventory of configured instances). Independent of the Codex bridge - works whether or not Epic Handshake is enabled. Reasoning models like Gemma 3 that return their thinking trace separately get both the answer AND the trace, tagged so Claude can tell them apart.

- **Multi-instance from day one - one local plus six free OpenCode Zen routes seeded.** WAT321 ships with a `local-llm` slot pointed at `http://10.0.0.101:8080` (auto-follows whichever model is loaded - no re-pick after swapping with the LLMs desktop shortcuts) plus six pre-wired Zen instances: Big Pickle (free, retained), GPT 5 Nano (free, 30-day), Ling 2.6 Flash (free, retained), Hy3 Preview (free, retained), Nemotron 3 Super (free, NVIDIA logs), and MiniMax M2.5 (free, retained). All ship `enabled: false` - you flip what you want to use. Custom instances drop into the same `wat321.modelBridge.instances` array.

- **Active instance picker on the click menu.** One click on the Model Bridge widget surfaces the list of enabled instances with kind (local/remote) and retention badge. Pick one to make it the default for tool calls without an explicit `instance_id`. Claude can also override per-call by passing `instance_id: "big-pickle"` etc. The widget shows the active alias and a red badge when the active cloud instance is missing its API key.

- **OpenCode Zen API keys live in VS Code's SecretStorage, not settings.json.** A new command `WAT321: Model Bridge - Set OpenCode Zen API Key` (also reachable from the click menu) walks you through storing your Zen key in the OS keychain - all six free Zen instances share the one key. Cleared on Reset WAT321 along with everything else. Settings.json never sees the secret.

- **Live token rate in the status bar while a Model Bridge call streams.** The bridge streams replies via Server-Sent Events and the widget updates four times a second with the running token count and tokens-per-second (`Big Pickle 247t @ 32/s`). Reading the rate while a long reply renders beats watching a wall-clock counter tick - if rate drops, you see it.

- **Async dispatch keeps Claude moving while a long Model Bridge call runs.** Pass `async: true` to `model_bridge_ask` and the tool returns a request id immediately while the call runs in the background.`model_bridge_inbox` retrieves the result when you're ready. Useful for heavy reasoning models or long prompts. Only one async call can be in flight at a time. Collisions return a clear "already busy, check the inbox" message.

- **Phased Model Protocol surfaces what the model is *doing*, not just how long it's been doing it.** When `phasedProtocol: markers-v1` is on (default), every prompt includes a short instruction asking the model to emit `<<PHASE:STARTED>>`, `<<PHASE:HALFWAY:summary="..."`, and `<<PHASE:COMPLETING>>` markers on lines by themselves. The bridge strips the markers from the visible reply, builds a phase trace, and surfaces it in the widget tooltip and at the top of the reply. The HALFWAY summary is the steering anchor - Claude reads what was *done* and can redirect on the next turn rather than waiting for a full wrong answer. Mostly useful with local models. Cloud routes tend to ignore the marker scaffolding.

- **Persistent multi-turn conversations via `model_bridge_thread`.** Each thread keeps a rollout pinned to its starting instance. Every turn replays history so the model sees prior context (and llama.cpp's prefix cache hits for fast prefill). Auto-compact triggers when the rollout passes a configurable fraction of n_ctx (default 85%) - the bridge calls the model to summarize the older half, replaces those turns with the summary, and the conversation continues without overflowing. Sub-actions: `start`, `ask`, `resume`, `list`, `end`, `compact`. Replies include a footer with running context usage and a flag when auto-compact ran on this turn.

- **Tool-using sub-agent via the OpenCode HTTP harness.** Toggle `wat321.modelBridge.useOpenCodeHarness` and the active *local* instance gains a `model_bridge_task` tool that drives a tool loop (read/write files, fetch URLs, run shell commands) end-to-end before returning a single result. WAT321 talks to OpenCode entirely over HTTP - no SSH, no spawning child processes. The tool only appears in Claude's surface when the harness is on, the active instance is local, AND the OpenCode server is reachable. Cloud instances skip the harness automatically.

- **Click menu on the Model Bridge widget.** Active instance picker, output channel, connection test against the active instance's `/v1/models`, thread management (list, end, erase all), runtime tunables (temperature, max tokens, timeout, system prompt), phased protocol toggle, auto-compact threshold, OpenCode Zen API key shortcut, and harness configuration. Replaces the older "click goes straight to output channel" behavior. The legacy `wat321.modelBridge.show` command is still registered.

- **Retention banner on every Model Bridge reply.** Every tool reply ends with `[retention] <Alias> stays local.` or `[retention] <Alias> may log or train on your prompts.` so Claude (and you) can never lose track of where the prompt went. Surfaced loudly in the widget tooltip too.

- **Per-instance session token totals on the Model Bridge widget.** Hover the widget and the tooltip shows cumulative input / output / call-count per instance with a "since X minutes ago" timestamp - useful for keeping an eye on free-tier Zen quotas and for sanity-checking how much you actually spent on a long Big Pickle session. Counters persist to `~/.wat321/model-bridge/usage.json` (atomic writes), survive VS Code restarts, and reset via the click menu's `Reset Session Totals` entry or on Reset WAT321. The widget click-menu top row also shows aggregate totals at a glance.

- **Settings page slimmed from 13 flat keys to 3.** `wat321.modelBridge.enabled`, `wat321.modelBridge.instances` (the array of identity entries), and `wat321.modelBridge.useOpenCodeHarness`. Everything tunable per task - active instance id, sampling, system prompt, phased protocol, auto-compact threshold, OpenCode URL - lives in `~/.wat321/model-bridge/preferences.json` driven by the click menu. API keys live in SecretStorage. Settings.json never carries secrets and only carries identity.

- **WAT321 now works whether you installed the standalone CLI or the marketplace extension.** Epic Handshake used to refuse to enable when `claude` or `codex` weren't on your shell PATH, even if you had the Claude Code or OpenAI Codex VS Code extensions installed (both extensions ship a working CLI binary inside their install dir). The bridge now probes PATH first, then falls back to the extension-bundled binary at `vscode.extensions.getExtension('anthropic.claude-code').extensionUri/resources/native-binary/claude` (and the equivalent for Codex). Marketplace-only users get a working install with no `npm i -g` step. PATH-installed users see no behavior change. Per-platform mapping covers Windows, Linux, and macOS (both Apple Silicon and Intel).

### Changed

- **Codex bridge no longer loses replies that Codex actually finished.** When Codex completed work on disk but the bridge's `turn/completed` notification arrived empty, hit a non-success status, or never landed at all, the bridge used to declare "couldn't complete this turn" and discard the reply. The bridge now reads the rollout file on every failure path - if it shows the current turn complete with fresh assistant text, that text comes through to you instead of the synthetic failure message. A background watcher polls every two seconds during in-flight turns so silent severance recovers within seconds rather than waiting on the auto-abort timeout. Strict freshness gating ensures recovery never returns text from a prior turn. Recovery only fires when our turn was observed starting AND the rollout has either new text or new bytes since dispatch. Closes the bridge severance class documented in #69 / #72 / #73.

- **Bridge gives you actionable feedback ~3 minutes sooner when Codex hangs.** The auto-abort threshold for stale heartbeats dropped from 10 minutes to 7 minutes, and the auto-abort message now explicitly names "Restart Codex Bridge" as a recovery option alongside re-dispatch and switching to fire-and-forget mode. Sub-7-minute Codex turns rarely stall on a single tool boundary. If a real run hits this, a bridge restart is the recovery and the next dispatch starts on a fresh app-server.

- **Long Codex tool calls no longer trip the stale-heartbeat threshold.** Codex tool calls (web fetch, file ops, MCP tools) can run minutes between events without emitting RPC progress in between. The bridge now refreshes its heartbeat every 60 seconds while the codex child process is alive, so a single long tool call no longer auto-aborts a turn that's genuinely working. If the child died, the refresh stops and auto-abort still fires on the now-genuine staleness - alive-but-quiet and dead are distinguished without false positives.

- **Switching VS Code instances no longer leaves a stranded MCP entry advertising tools you never opted into.** A sibling VS Code instance enabling Epic Handshake or Model Bridge writes a user-scope entry to `~/.claude.json` that's global and persists across restarts. An instance with the bridge disabled in its own settings used to inherit that registration silently. Both bridges now reconcile to their own settings on activate - a disabled instance always uninstalls any leftover entry. State converges to current settings instead of inheriting whatever sibling instance touched the registration last.

- **`epic_handshake_inbox` shows you what's queued, what's pending, and what landed late from prior bridge sessions.** When the inbox is empty, the response now appends a single-line queue summary like `Queue: 1 prompt(s) in flight or queued; 2 late repl(ies) from this session pending.` so backlog is visible from Claude's side without poking at status-bar widgets. Timeout messages append the same summary so you see what's still in flight when a single dispatch fails.

- **`epic_handshake_ask` now rejects malformed argument shapes fast instead of waiting the full timeout.** The bridge used to dispatch an empty envelope when Claude passed `prompt` (the Model Bridge tool's key) instead of `text`, then sit through the 120-second wait before declaring no reply. Schema validation now returns an actionable hint within milliseconds when `text` is missing, when `prompt` was used by mistake, or when `timeout_sec` arrives as a non-number. Saves the full timeout cost on a doomed dispatch.

- **Provider Health output now shows you which CLI binary the bridge is actually driving.** The `WAT321: Show Provider Health` panel adds two lines under Epic Handshake telling you whether `claude` and `codex` resolved via PATH or via the marketplace extension's bundled binary, with the absolute path so you can verify which version is in use. Helps diagnose "why does Claude Code feel different across my two VS Code installs" when one is using a newer extension-bundled CLI than the other.

### Fixed

- **`model_bridge_task` no longer asks Codex's harness to use an agent that doesn't exist.** The tool description told Claude to set `agent: "wat321-coder"` for a minimal read/write/bash surface on small models - but that agent was never actually deployed to the OpenCode server config. Every `model_bridge_task` call that followed the description hint produced an "Agent not found: wat321-coder" rejection from OpenCode. The description now names OpenCode's actual built-in agents (`build` is the default, plus `explore`, `general`, `plan`) and tells Claude to omit the field unless a custom agent has been configured on the OpenCode server.

- **Cancelling a Codex turn now reliably restarts the codex app-server.** `turn/interrupt` is best-effort - if the codex child was wedged in inference or stuck on an unresponsive tool call, the interrupt RPC may never deliver and the child kept running with a now-rejected turn. The next dispatch then tried to drive a hung connection and broke too. Cancel now also force-kills the child via the dispatcher's `forceRestart()` path so the next dispatch starts on a fresh app-server.

- **Reset WAT321 no longer breaks subsequent bridge dispatches from sibling workspaces.** Reset wipes `~/.wat321/`, which is correct (it's global state), but `channel.mjs` in both bridges wrote to per-workspace subdirs assuming they exist. After a reset, only the workspace that re-activated the bridge recreated its own subdir. A sibling Claude session calling the bridge from a never-before-seen workspace then hit ENOENT on the first dispatch. Both bridges now defensively recreate the parent directory on every atomic write.

### Removed

## [1.2.12] - 2026-05-01

### Added

- **Tooltip on the Claude session token widget now explains the most recent cache event.** Hover the widget and look for the `Most recent:` line - it tells you whether the prior turn was a clean cache HIT, a deliberate LOAD after a compact, or a MISS, and when there's a MISS it names the likely cause (TTL expiration with how big the gap was, large tool result that pushed past the cache window, or "prefix change, cause unclear" when neither obvious cause fit). The thresholds match what already drives the banner flash so the two surfaces never disagree, but the tooltip is always-on so you see cache cadence between flashes too. Pure transcript read - no API calls, no spawns. Issue #66 (and the visibility gap behind #65).

- **Epic Handshake menu shows stage age and last-activity time during an in-flight turn.** When you click the bridge widget while a Codex turn is running, a new BRIDGE STATUS row at the top of the menu tells you what stage Codex is in, how long it's been there, and how long since the dispatcher last heard from it. When the writing stage has held for over three minutes with no activity for over a minute, the row explicitly says "looks stuck on flush - consider CANCEL" so you can abort and retry without waiting out the ten-minute auto-abort. Issue #67.

### Changed

### Fixed

- **Opening a second VS Code window no longer flips the wait mode in your other windows.** The Epic Handshake adaptive / fire-and-forget flag files live at one shared path under `~/.wat321/`, so the activation handler that wrote your default-wait-mode preference was overwriting whatever flag the menu had set in another window. The activate-time and enable-flow paths now respect any flag already on disk and only seed when none exists. Only an explicit settings change forces an override. Menu toggles continue to take effect immediately. Issue #68.

- **Pending Epic Handshake replies survive a VS Code restart.** A Codex reply that landed in the inbox while VS Code was closing or restarting used to get archived to `sent/` on the next activation before the inbox check could surface it - the work was done and the envelope was right there in `sent/`, but `epic_handshake_inbox` returned empty. The activate-time inbox sweep is gone. The existing one-hour TTL on subsequent bridge dispatches still cleans up genuinely stale entries without racing fresh ones. Issue #64.

### Removed

## [1.2.11] - 2026-04-28

### Added

### Changed

- **Cold-launching VS Code no longer pre-spawns the Codex bridge daemon.** The Epic Handshake bridge used to spawn Codex's app-server child process 500 milliseconds after VS Code activated, purely as a UX shortcut to eliminate the ~20 second cold-start the first time you fired a bridge prompt. The spawn was structurally inert (no Codex API call, just a JSON-RPC handshake with the local daemon), but reducing the audit surface matters more than saving 20 seconds once. The first bridge dispatch after a fresh launch now pays the cold-start, which the bridge widget's stage-1 ceremony already covers visually. Restart Codex Bridge from the menu still leaves the bridge warm afterward because that's a deliberate user action.

- **The bridge waits longer for Codex to flush a late reply before giving up.** When a Codex turn hit its internal timeout, the bridge interrupted Codex and gave it three seconds to write its final reply to disk before falling back to a synthetic error message. Three seconds wasn't enough headroom for long replies that Codex was still streaming when the interrupt landed, and you'd get the error reply when Codex actually had a real reply one or two seconds later. The bridge now polls for the late reply for up to thirty seconds at one-second intervals, so a real Codex finish that lands shortly after interrupt comes through correctly instead of being replaced by the timeout text.

- **The bridge MCP script is now installed atomically.** When you upgrade WAT321, the bundled bridge script gets refreshed in `~/.wat321/epic-handshake/bin/`. The previous install copied the script directly over the old one, leaving a brief window where Claude Code spawning the script mid-copy could read torn bytes and fail to parse. The new install writes to a temp file then renames, so Claude Code always sees either the prior script or the fully-written new one - never a partial.

### Fixed

- **The Claude session token LOAD banner no longer fires against incremental cache writes.** Even after the 1.2.10 fix, the first new assistant turn after attaching to an existing Claude session would fire the yellow LOAD banner whenever cache-creation tokens crossed the 5000 floor - which happens routinely during normal turn work, not just on real rebuilds. The widget now arms its "deliberate rebuild incoming" latch only when one is genuinely incoming: a brand-new Claude session whose first turn IS the first cache build, or a fresh compact event observed live. Existing-session attaches leave the latch off, so the banner stays quiet until something real happens. To be doubly clear: the LOAD banner is purely a display read on transcript files Claude itself wrote. It never triggered any API activity, just made it look like the widget might have. That misleading display is gone.

### Removed

- **Dropped a dormant capability declaration in the bridge MCP server.** The script declared a forward-compatibility experimental capability that no client has ever consumed. Carrying speculative surface "just in case" violates our anti-spec rule. If a real consumer ever ships, the capability comes back at the same time, not before.

## [1.2.10] - 2026-04-27

### Added

### Changed

### Fixed

- **Cold-launching VS Code or switching Claude projects no longer fires a misleading LOAD banner against history.** When the Claude session token widget attached to a new session, it reset its usage tracking and then immediately read the existing transcript's most recent assistant turn - which on any healthy Claude session has cache-creation tokens left over from a real rebuild that already happened. That historical reading was firing the yellow LOAD banner against work the widget didn't observe live, so it could look like opening VS Code itself had caused a cache rebuild. The widget now adopts the existing usage state on attach, so LOAD only fires on a brand-new assistant turn that lands while the widget is actually watching. To be clear, the widgets only ever read transcript files and never trigger anything on the CLI side. This just removes the false visual signal that suggested otherwise.

### Removed

## [1.2.9] - 2026-04-27

### Added

- **Reasoning effort now shows up next to the model name in session token tooltips.** Hover the Codex session token widget and the model line reads `GPT-5.5 · High (272K context)` or whichever effort is currently in play. The override you pick from the bridge menu wins. Otherwise the tooltip shows the model's own default reasoning level pulled from Codex's local cache, so you always see what Codex will actually run rather than what you happened to override. The Claude tooltip gets the same treatment using its closest analog: when extended thinking is firing in your recent turns, the model line reads `Sonnet 4.6 · Thinking (200K context)`, and the segment is omitted when Claude's running normally.

### Changed

### Fixed

- **Fire-and-Forget really keeps the Claude waiting cycle off this time.** The 1.2.8 fix only covered one of three places where the Claude session token widget could render bridge-driven activity, so under Fire-and-Forget you'd still see the pre-ceremony idle blink and the stage-1 debug-disconnect alternation before the widget settled. The widget now bypasses every bridge-driven prefix path under Fire-and-Forget and renders purely from your own Claude transcript activity, exactly as if the bridge weren't running. Adaptive and Standard still drive the waiting cycle as before.

- **The very first bridge dispatch after a fresh VS Code launch no longer skips the Codex session token ceremony animation.** The widget's animation ticker only re-evaluated bridge state on its own 15-second poll cadence, so a bridge prompt fired within seconds of opening VS Code landed in a window where the ticker was idle and never started. The bridge widget itself walked the ceremony correctly, but the Codex session token widget stayed frozen on its idle prefix. The session token widget now subscribes to bridge state changes directly, so it picks up the very first dispatch's ceremony without waiting for its next scheduled poll.

- **The cache LOAD / MISS banner finally pulses without shifting cell width.** The 1.2.8 attempt swapped the off-frame placeholder from an ideographic space to two ASCII spaces. Both still shifted because emoji and non-emoji characters live in different font tables in VS Code's status bar with no width contract between them. The off-frame is now a black-circle emoji from the same Unicode block as the colored circles, which makes the swap pixel-perfect by construction. On dark themes the off-frame nearly disappears for a "fades to blank" feel. On light themes it stays visible but still pulses cleanly. Geometry holds either way.

- **The bridge's "auto-compact just finished" and "you pressed Esc" events no longer fire a misleading "Claude finished" toast.** This shipped in 1.2.8 but was incomplete in some classifier paths. The remaining drift is now swept and the toast notifier suppresses both events cleanly while the spinner still stops correctly.

- **Bridge config-error messages are friendlier and don't leak file paths.** When Codex's local config points at a model Codex doesn't recognize, or when a stored session slug has been retired by a Codex CLI upgrade, the error reply that lands back in Claude is now passive and brief - it points at the right bridge menu action when one exists, and routes full error text to the WAT321: Epic Handshake output channel instead of echoing it into your transcript. The actionable info you need is still there. The noise isn't.

### Removed

## [1.2.8] - 2026-04-27

### Added

### Changed

- **The cache LOAD / MISS banner no longer shifts cell width while it pulses.** The off-frame placeholder used to be a CJK-style ideographic space, which was meant to match the colored circle emoji width but never quite did in VS Code's status bar font - every flash transition left a tiny but visible cell-width shimmy. The off-frame is now plain ASCII spaces sized to the emoji's render width, so the cell stays put across the whole 2-second flash window. Only the colored bullets blink.

### Fixed

- **The Claude session token widget no longer pretends to be waiting under Fire-and-Forget.** The previous gate only covered one of three bridge-prefix paths the widget can take during a bridge turn. The pre-ceremony idle blink and the stage-1 debug-disconnect alternation were both still firing for Claude under FaF. The widget now bypasses every bridge-driven prefix path under FaF and renders purely from its own transcript activity, exactly like a non-bridge turn. Adaptive and Standard still drive the waiting cycle as before.

- **No more spurious "Claude finished" toast after auto-compact or after pressing Esc.** Auto-compact summary entries and the user-interrupt marker were both being classified as a finished assistant turn, which fired a toast every time the engine compacted context mid-turn or you aborted a turn yourself. Both now route through their own classifier kinds. The widget treats them as idle (so the spinner still stops), but the toast notifier suppresses them. The completion toast only fires for a real model response.

- **The bridge dropdown row label is back to `MANAGE CODEX SESSIONS (S#)`.** A v1.2.6 menu redesign accidentally shortened it to `SESSIONS (S#)`. Restored.

### Removed

## [1.2.7] - 2026-04-26

### Added

- **Epic Handshake checks for Codex before installing anything.** Enabling the bridge previously would write its MCP server registration into Claude's settings even if you didn't have the Codex CLI installed - the next dispatch would fail and you'd be left with bridge artifacts you didn't need. The enable flow now verifies the `codex` CLI is on your PATH before any install side-effect runs, mirroring the existing `claude` CLI check. If Codex isn't found, the setting flips back off with a friendly toast saying to install Codex and re-enable when ready. Nothing is written until both CLIs are present.

### Changed

- **The Claude session token widget no longer pretends to be waiting under Fire-and-Forget.** Fire-and-Forget returns Claude's MCP call immediately so Claude is free to keep working while Codex runs in the background. The Claude waiting cycle (1Hz logo blink) now only renders under Adaptive mode where Claude's MCP call is genuinely blocked on the bridge reply. Under Fire-and-Forget, the Claude widget falls through to its normal activity detection - idle when the transcript is silent, thinking icons when Claude is actually doing something.

- **Codex Session Settings are now per-workspace instead of shared across every VS Code window.** Sandbox, model, and effort overrides previously lived in a single set of files at the root of `~/.wat321/epic-handshake/`, so flipping sandbox to FULL-ACCESS in one project silently flipped it in every other workspace too. Each VS Code window now writes its own workspace-scoped flag files alongside the bridge's existing per-workspace state, so two windows on different projects carry independent settings. Reset WAT321 still wipes them all in one shot.

### Fixed

### Removed

## [1.2.6] - 2026-04-26

### Added

- **Every Claude-to-Codex bridge turn now visibly walks through all five stages.** The bridge widget previously dropped its stage walker mid-walk on fast turns, so stages 4 and 5 sometimes never displayed. The walker now keeps walking until it reaches stage 5 + the post-walk hold, regardless of how the underlying turn ends. Quick turns get a 500ms-per-stage flash through 3 and 4 so the churn always reads as motion rather than a skipped frame, and a 2000ms green check icon caps off the visual after the walker settles. Closes the long-standing "did stage 5 just not happen?" feeling.

- **The Codex bridge process pre-warms in the background as soon as you open VS Code.** Previously the very first bridge prompt after a window reload paid a ~20-second cold start while the Codex app-server child process spawned and initialized - the bridge widget cycled stage 1 the entire time. The dispatcher now spawns the child process and completes its JSON-RPC handshake about half a second after activation, so your first dispatch is already warm by the time you ask. Same pre-warm runs after `RESTART CODEX BRIDGE` so the next dispatch after a manual restart is also fast.

- **Cancel mid-turn now walks the bridge widget cleanly to stage 5 instead of leaving it stuck on whatever intermediate stage it last reached.** Cancel and error settle paths now write a final stage-complete heartbeat before tearing down, so the walker resolves naturally via the fast-walk path. The green check icon stays gated on actual successful delivery, so cancelled and errored turns end at idle silently - no spurious "delivered" flash.

- **The Claude-to-Codex bridge no longer asks for permission on first use.** Claude Code's per-tool permission gate previously fired the first time you used `mcp__wat321__epic_handshake_ask` in any project, which interrupted the very first bridge prompt. Enabling Epic Handshake in the WAT321 settings now adds the two bridge tools to your `permissions.allow` allowlist alongside the MCP server registration we already write. Disabling Epic Handshake removes only those two entries. Everything else in your allowlist is untouched.

- **Stage-flow design doc.** The new `WDDOCS/EPIC_HANDSHAKE/STAGE_FLOW.md` is the canonical reference for what each square-N icon means, what Codex is doing during each stage, what triggers each transition, the fast-walk short-cut for quick turns, the cancel/error orphan path, and a full timing reference table covering every constant in the bridge UI.

### Changed

- **Bridge dropdown menu reordered + colored.** Most-frequent actions sit at the top (`RETRIEVE LATE REPLIES`, `SESSIONS`, `WAIT MODE`). Restart and the always-present pause + cancel sit at the bottom. Pause + cancel are now visible in every submenu so you always have a one-click escape regardless of how deep you've navigated. Color circles distinguish the action rows: yellow PAUSE, red CANCEL, green RESUME (when paused), blue BACK. Restart no longer shows green - that hue is now reserved for resume.

- **`MANAGE CODEX SESSION` is now `SESSIONS`** with a square-info icon, since the row covers more than just session management (it's the entry point to Codex Session Settings, recover, repair, etc.). `RESTART CODEX BRIDGE` trimmed to a single inline description and given a neutral sync icon instead of the green debug-restart glyph.

- **Codex Session Settings menu reads cleanly.** The row label flips to `CODEX SESSION SETTINGS: Default` (capital `D`) when sandbox, model, and effort all match the platform baseline, otherwise just `CODEX SESSION SETTINGS`. The subline shows the current `Sandbox · Model · Effort` values dot-separated. Sandbox is now a one-click toggle directly from the settings picker (no more sub-menu for a binary). Model and effort pickers drop their explicit "use default" rows. Default values are tagged inline as `*default*` next to the model name, and the active selection is tagged `(CURRENT)`. Tags sit between the value and its description so they stay visible if a narrow QuickPick column truncates the description.

- **BACK navigation walks back one menu level instead of closing or jumping to the main menu.** Previously BACK from Codex Session Settings closed the entire menu stack, and BACK from Recover Sessions skipped past the sessions submenu straight to main. Both now reopen their direct parent.

- **Session token activity icons read more accurately during a bridge turn.** The Claude widget shows its native thinking cycle during stage 1 instead of the debug-disconnect glyphs - Claude's MCP connection is established at that point, so the "connecting" flavor was misleading. The Codex widget drops the debug-disconnect fallback at stage 2 (was holding through stage 3) and switches to its native thinking cycle the moment the bridge confirms receipt.

- **The cache LOAD / MISS banner pulses without shifting cell width.** The yellow LOAD and red MISS banners hold their text steady for the full 2-second flash window. Only the colored circle bullets blink between visible and invisible, like the Claude waiting cycle. No more layout shimmy on every frame transition.

- **Bridge UI converged on a 3-second beat.** Five timing constants - the latch orphan grace, the returning-flag fallback, the mail-pulse window, the Claude active-thinking threshold, and the late-reply classification threshold - normalized to 3 seconds so the entire bridge UI rhythm aligns with the per-stage walker holds.

### Fixed

- **First bridge prompt after a VS Code reload no longer races the pre-warm.** The pre-warm defer dropped from 2 seconds to 500ms, so users dispatching a bridge prompt immediately after window-open consistently see the warm channel pay only `thread/start` + `turn/start` latency rather than the full cold-start chain.

### Removed

- **Three Codex-defaults settings retired from VS Code Settings.** `epicHandshake.codexSandboxDefault`, `codexModelDefault`, and `codexEffortDefault` are no longer settings entries. The Codex Session Settings menu picker remains the sole way to change those values. The picker writes runtime override flag files under `~/.wat321/` that persist across activations until Reset WAT321 wipes them. Simplifies the settings page and removes a sync layer that was never load-bearing.

- **Modal confirmation dialogs replaced with non-modal toasts with action buttons.** Delete-all sessions, discard mail, repair sessions, and the force-repair flow all previously raised a blocking VS Code modal dialog. They now use the standard non-modal toast notification with the same action buttons, so the rest of the editor stays interactive while you decide.

## [1.2.5] - 2026-04-26

### Added

- **Cache LOAD / MISS banners actually fire now.** The previous detector required cache reads to be near zero, which essentially never happens in real Claude Code 1M sessions because the warm prefix cache always has something to read back. Sampling shows the old rule fired about 35 times across 25,000+ turns - users reported never seeing it once. The new detector uses a ratio rule that catches the dominance pattern regardless of absolute numbers, so every legitimate cache rebuild surfaces. Yellow LOAD also fires after a `/compact` (auto or manual) so a deliberate rebuild reads as expected cost, not as an unexpected miss. Red MISS stays reserved for involuntary mid-session evictions. Closes #60 follow-up.

- **The Claude-to-Codex bridge surfaces in-flight status when you check the inbox during a turn.** Asking Claude to check the inbox during an active bridge turn used to return a misleading "empty" message. The bridge now reports stage, elapsed time, and time since last progress instead. If a heartbeat hasn't moved for 10+ minutes, the bridge auto-aborts the stuck turn, deposits a friendly synthetic abort reply into the inbox, and cleans up the flag files so your next prompt starts clean. No more polling forever against a dead bridge. Closes #61.

- **macOS and Linux can stage clipboard screenshots through the Codex bridge.** A single Node-based `stage-clipboard.mjs` shim replaces the prior Windows-only PowerShell script. On Windows it shells out to `powershell.exe`. On macOS it uses `osascript`. On Linux it prefers `wl-paste` (Wayland) and falls back to `xclip` (X11). Same output convention everywhere - prints the absolute path on stdout - so Claude's invocation flow is identical across platforms. Old screenshots auto-sweep on a 5-minute TTL so abandoned clipboard pastes don't accumulate. Image bytes stay on disk. Only the path travels through the conversation. Closes #57.

- **Codex sandbox, model, and effort all change without a session reset.** A new `CODEX DEFAULTS` row in the sessions submenu opens a single picker covering all three: sandbox (Full-Access / Read-Only), model (any visibility=list slug from your `models_cache.json`), and effort (low / medium / high / xhigh, or whatever the selected model supports). Every row shows your persisted default alongside the current live value so you can see at a glance which knob differs. Threads always start at maximum permission and capability ceiling so any dial-down is reachable without recreating the session. Settings still drive the on-activate default. The picker overrides until the next reload. Closes #58 and addresses #63.

- **A `RESTART CODEX BRIDGE` row sits in the main menu above CANCEL as a backup safety net.** When the Codex side gets wedged - rare, but it happens - one click cancels the in-flight turn, clears the bridge runtime state, force-kills the Codex app-server child process, and respawns it cleanly. The active session resumes on your next prompt because Codex sessions are file-backed. Nothing about your conversation is lost. Critically, this does NOT restart the WAT321 VS Code extension and does NOT touch Claude's MCP connection, so there is zero impact on your Claude session token usage.

- **Codex session token widgets light up during stages 1-2 of a bridge turn.** On first bridge activation, Codex hasn't written its rollout file yet during the early "dispatched" and "received" stages, so the Codex widget had no transcript signal and stayed idle. The widget now blinks `disconnect` <-> `connected` at 1Hz during those early stages, mirroring the Claude widget's debug ceremony. Once stage 3+ ticks in, normal in-turn rendering takes over.

- **Cache LOAD detection now works for Codex sessions too.** Codex rollouts use a different compact marker than Claude (an `event_msg/context_compacted` event plus a legacy `compacted` rollout line). The widget now reads both and feeds the same provider-agnostic compact-aware state machine, so a yellow `LOAD` banner fires after a Codex compaction the same way it does after a Claude `/compact`. Closes #62.

- **The bridge walker now blinks at 1Hz with directional cues.** Stages 1-2 alternate the numbered square with an outbound arrow. Stages 3-4 alternate with a blank during the working phase. Stage 5 alternates with a returning arrow. The dispatcher's existing reply-incoming flag drives a sub-state where stage 4's alternate frame switches from blank to a returning arrow once the reply is forming, so you see the direction of the handoff change in real time.

- **A blank-and-logo blink replaces the activity-icon cycle during the bridge's pre-ceremony window.** Before the dispatcher writes its first heartbeat, no real thinking is happening yet, so the previous activity icons misrepresented state. The session token widgets now blink the provider logo against a blank square to read as "we know something is starting" without falsely advertising thinking activity.

### Changed

- **All Epic Handshake menu labels now use ALL CAPS with updated wording.** The main menu reads `RETRIEVE LATE REPLIES (n)` / `WAIT MODE` / `MANAGE CODEX SESSION (S{n})` / `CLEAR` / `PAUSE` / `RESTART CODEX BRIDGE` / `CANCEL`. The Codex session submenu matches the same convention with `BACK` at the top, then `CODEX DEFAULTS` / `RESET` / `DELETE` / `DELETE ALL (n)` / `RECOVER (n)` / `REPAIR SESSIONS (n)`. The `BRIDGE STATUS` row is hidden in this release. All actionable bridge state lives in the click menu instead.

- **Wait mode is now a binary toggle between Adaptive and Fire-and-Forget.** The old three-way Standard / Adaptive / Fire-and-Forget cycle introduced friction the third mode didn't pay back for most users. Standard mode stays internal for any legacy state, but the menu and the settings dropdown only expose Adaptive and Fire-and-Forget. If you had Standard set as your default, you migrate to Adaptive on the next activate.

- **Bars, percentages, and the "Auto-Compact at ~X" tooltip line all show the actual compaction fire point.** Recent Claude Code releases stack a small reserve on the override percentage rather than replacing the default formula, so 73% on a 1M context fires around ~715k instead of the nominal ~730k. The widget used to show 730k in the bar but 715k only in the tooltip, which read as a contradiction. All displays now agree on the effective trigger. Closes #55.

- **The bridge widget no longer renders a hover tooltip.** VS Code Issues #128887 (open since 2021) and #293360 (PR #305676 in development) cause the tooltip overlay to reshow over toasts and re-fire on alt-tab no matter what the extension does about the property. Hovering the bridge widget now shows just the static `Epic Handshake` label. All actionable bridge state lives in the click menu.

- **The Claude session token widget keeps its logo blinking through the full bridge turn under Fire-and-Forget.** Previously, once Claude's MCP call returned the dispatched ack and the transcript classifier saw the tool result land, the widget went idle - even though Codex was still working through the bridge on the other side. The widget now stays visually engaged for the entire bridge in-turn window regardless of which wait mode is active.

- **Internal: bridge state now flows through tool-tier coordinators with a type-only contract for engine consumers.** Two coordinators (`bridgeStageCoordinator`, `lateReplyInboxCoordinator`) live alongside the Epic Handshake source-of-truth files in the EH tier and own an `fs.watch` + 50ms debounce reactor with a 1s polling backstop. Engine consumers depend on a small type-only contract (`engine/bridgeTypes.ts`, `engine/serviceTypes.ts`) so the one-way dependency rule holds. Visible benefit: bridge state changes propagate to widgets in ~50ms instead of up to 1000ms because file-system watch fires events at kernel speed. Background benefit: long-idle stretches save CPU because the bridge stage timer self-suspends after 30s of inactivity and session token widget tickers self-suspend when nothing is animating.

### Fixed

### Removed

## [1.2.4] - 2026-04-24

### Added

- **Codex permissions toggle now takes effect on your next prompt instead of requiring a session reset.** Flipping "Codex permissions: Full-Access" or "Read-Only" in the sessions submenu used to only apply to fresh threads, so an existing session silently ignored the change. The bridge now reads the flag on every turn, so your toggle lands on the very next Claude-to-Codex prompt without touching the session. The toast message was updated to match. Closes #59 and unblocks #56.
- **A yellow `LOAD` banner on session token widgets for the first cache-miss-pattern turn after a reload.** A deliberate Claude Code reload always pays a cache-seeding cost on its first turn, and that previously showed as red `MISS` - reading as an alarm when really the reload was the point. The widget now flashes yellow `LOAD` on the first qualifying turn after mount, then switches to red `MISS` for any subsequent cache miss. Red is reserved for the "investigate" case. Closes #60.
- **`file_paths` on the Epic Handshake bridge tool.** When you want Codex to look at specific files, the Claude-to-Codex bridge now accepts an optional list of absolute paths alongside your prompt. Codex reads them directly from disk - no copy-pasting file contents into the prompt text, no hitting token limits on large files. Sandbox permissions still apply: Read-Only Codex can read files but not execute. Full-Access Codex can do both.
- **A clipboard-to-screenshot helper so Codex can see pasted images.** A standalone PowerShell script lands at `~/.wat321/epic-handshake/bin/stage-clipboard.ps1` at install time. When you paste a screenshot into Claude and ask Codex to look at it, Claude runs the script via Bash, the script writes the clipboard image to a timestamped PNG under `~/.wat321/epic-handshake/attachments/clipboard/`, and Claude passes the resulting path through the new `file_paths` field. The image never enters your token budget - only the path string travels through the conversation. A manual command `WAT321: Epic Handshake - Stage Clipboard Image for Codex` is available from the command palette as a fallback. Partial progress on #57.

### Changed

- **Fire-and-Forget now truly fires and forgets.** The bridge previously still enforced a 5-minute hard cap and per-tool stall windows on Fire-and-Forget turns, which defeated the mode's whole point ("reply lands when it lands"). Stall detection, hard cap, and the phase-0 "never activated" timer are all disabled when Fire-and-Forget is on. If a turn truly hangs, cancel from the status bar or reset the session.
- **Adaptive wait mode tolerates longer pure-reasoning gaps.** Complex design and analysis tasks often spend 60+ seconds in model-side reasoning before the first tool call, which was tripping Adaptive's 60-second stall window and killing legitimate turns. Every per-tool stall window on Adaptive now floors at 2 minutes, so silent reasoning gaps survive. Standard mode still uses the tight default.
- **The Claude Usage widget stays on the last-known numbers through the 5-hour billing-window rollover.** Anthropic's usage endpoint returns 429 on cold polls when you've been idle past the 30-second activity window, and the widget used to flip to "Idle" immediately. The widget now absorbs up to three consecutive cold-start 429s while it has recent numbers on display, so the rollover no longer flashes a misleading idle state between live polls. If the cold state persists past the absorption threshold (~6 min at 2-min poll cadence), the normal rate-limited skin takes over.

### Fixed

- **Mid-session permission toggles actually work now.** The turn-level `sandboxPolicy` was hardcoded to `readOnly` on every turn, silently overriding whatever the thread-level sandbox was set to. Issue #59 documented the fix. The bug was defeating the Full-Access toggle since v1.1. Shell commands, file writes, and network access now follow your menu selection on the very next prompt.
- **Diagnostic logging of MCP tool-call shape.** Every invocation of `epic_handshake_ask` and `epic_handshake_inbox` now logs its argument shape and a truncated raw JSON dump to `channel.log`. Enables future investigation of how Claude Code forwards pasted images, clipboard payloads, and other non-text content through the MCP layer. No user-visible behavior change.

### Removed

## [1.2.3] - 2026-04-24

### Added

- **Wait mode locks while an Epic Handshake turn is in flight.** Flipping Standard / Adaptive / Fire-and-Forget mid-turn let the dispatcher's wait behavior get out of sync with the envelope that was already on the wire, which could strand replies or leave blocking calls waiting past their intended timeout. The wait mode row in the menu now stays visible during active turns so you can still see the current mode, but clicking it produces a lock toast instead of switching. The row unlocks automatically when the turn finishes for any reason (reply received, timed out, paused, cancelled, or errored).
- **Session token widgets show a bridge handshake animation during Epic Handshake turns.** When Claude calls the bridge, both the Claude and Codex session token widgets play a 4-second intro (`disconnect`, `connected`, `disconnect`, `connected` at one-second cadence) so the handshake always reads as a joint event regardless of how fast Codex acks. After the intro the widgets hold `debug-connected` until Codex reaches the `received` stage, at which point the Codex widget returns to its normal thinking cycle while the Claude widget blinks its brand glyph (`blank`, `claude` at one-second cadence) to indicate Claude is still blocking on the bridge reply under Standard or Adaptive wait modes. Under Fire-and-Forget the Claude widget resumes its normal thinking cycle too. Any bridge error, pause, or completion clears the animation immediately and the widgets return to normal behavior. A new shared reader in `src/shared/bridgePhase.ts` maps the existing per-turn heartbeat file into a provider-agnostic snapshot so neither provider widget has to know about Epic Handshake directly.

### Changed

- **Fire-and-Forget bridge dispatch no longer reads as a timeout to Claude.** The tool response sent back to Claude now leads with "Fire-and-forget dispatch complete" and states plainly that no wait was attempted, instead of "Dispatched to Codex. Reply will land...". Claude was paraphrasing the previous wording to the user as "Codex didn't reply within the timeout", which reads as a failure in a mode where no wait is ever attempted in the first place. The new wording leaves Claude no room to introduce timeout-shaped language downstream.

### Fixed

- **Codex session token thinking indicator no longer flickers idle mid-turn.** Codex CLI 0.124 emits a `commentary` agent_message mid-turn ("I'll look at X first") before the `final_answer` message at turn end, and the transcript classifier was treating the commentary as turn-complete. On every poll that landed right after a commentary message the widget blinked to idle and back, producing a stuttery thinking indicator during long research turns. The classifier now distinguishes `phase=final_answer` from `phase=commentary` and only closes the turn on final_answer or the explicit `task_complete` / `turn_aborted` signals.
- **Epic Handshake stage walker spreads tool-heavy Codex turns across stages 3 and 4 instead of pinning at stage 3.** On tool-heavy turns Codex emits `function_call` / `web_search_call` interleaved with `reasoning` for 80-95% of wall time, so the rollout parser would sit at `working` until the very last moment and stage 4 was essentially invisible. The walker now force-advances stage 2 to 3 after 15 seconds and stage 3 to 4 after 30 seconds when the parser hasn't signaled a higher stage, so the numbered-square glyphs track Codex's actual progress. Stages 1 and 5 are intentionally left on the parser's authoritative signals (task_started / task_complete) because those are the send and reply-back bookends and must not advance without real observation.
- **Stage 4 no longer latches prematurely on the 2nd commentary message.** The parser had a fallback that advanced to `writing` on the second assistant `response_item/message` to cover a hypothetical schema without a phase tag. In 0.124 that fallback was firing on the 2nd commentary at roughly 27% through a long turn and pinning stage 4 for the remaining majority. The fallback is removed.`agent_message phase=final_answer` and the post-tool reasoning heuristic now own stage 4 advancement.

### Removed

- **Dropped the heuristic disconnect glyph from session token widgets.** The 30-second stale-transcript check was swapping the thinking indicator for a disconnect icon during normal long reasoning passes, where the transcript legitimately stops growing for a while. The regular thinking animation now rides through the entire turn so you see Claude or Codex working. Bridge activity gets its own dedicated cue (see Added above).

## [1.2.2] - 2026-04-24

### Added

- **Claude session tokens flash a 🔴MISS🔴 banner when the prefix cache genuinely goes cold.** When a turn lands with near-zero cached input AND substantial cache creation (the signature of TTL expiry, context invalidation, or auto-compact), the widget alternates its token readout with a red MISS banner for two seconds (miss 500ms, tokens 500ms, miss 1000ms). Normal per-turn cache writes no longer trip the detector. The provider codicon stays in place throughout the flash - only the tokens/percent portion swaps.
- **Session token widgets drop the redundant "Claude" / "Codex" label.** The brand codicon already tells you which provider you're looking at, so the widget now reads as `$(claude) 267k / 730k 37%` instead of `$(claude) Claude 267k / 730k 37%`. Shorter line, same signal.
- **Heuristic disconnect glyph on session token widgets when a turn is silently hung.** If the thinking indicator has been active for more than 30 seconds with no transcript activity, the prefix swaps to `$(debug-disconnect)` so you can tell the session is probably waiting on the network, not just reasoning. Uses the same mtime signal the active indicator already reads, so no API probe and no platform-specific code. Closes #51.
- **The Auto-Compact tooltip line now reads the real fire point.** Claude Code's percentage override stacks with an internal reserve in recent releases, so setting `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=73` on a 1M window actually triggers compaction around 715k, not the nominal 730k. The widget's "Auto-Compact at ~X" line now shows the effective trigger with a `~` prefix so the advertised number matches what you'll actually hit. The bar and the "N/M" numerator still use your configured target so the percentage stays self-consistent. Closes #55.
- **Auto-Compact math now reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.** If you've set the absolute window override or declared the context window via env var, the widget picks those up instead of guessing from the model slug.

### Changed

- **Upgrade your Codex CLI before running the bridge in this release.** A lot of the model-repair work here depends on your local Codex models cache being current. If you're on a Codex CLI older than 0.124, newer slugs like `gpt-5.5` will read as "unknown" and Epic Handshake will fail every turn at pre-flight validation. Run `npm install -g @openai/codex@latest` once. The CLI auto-refreshes `~/.codex/models_cache.json` on its next invocation and everything else takes care of itself.
- **Delete All Codex Sessions is scoped to the current project even when another workspace shares the basename.** Previously "Delete All" walked Codex's session index by thread-name match alone, so a sibling workspace also named `foo` in a different parent path could have its sessions swept by mistake. Each candidate session's rollout header is now read and required to match the current workspace's path before it gets included in the delete set.
- **Epic Handshake bridge status bar shows the wait-mode lightning flash reliably.** The 2500ms bolt flash when you toggle wait mode was rendering as a static icon (the 500ms frame interval aligned with the 1000ms tier refresh so every sample landed on the same parity) and could be hidden by pending mail or prior failure states. Now held solid for the window and promoted above mail / failure rendering so a user-initiated toggle is always visible.
- **Retrieve late replies uses stock `$(mail)` / `$(mail-read)` codicons.** Both the menu row and the status bar pending-mail animation switch from the custom `wat321-square-mail` glyph to the built-in codicons, which render consistently across every VS Code fork without requiring our font.
- **Pause and Resume menu rows now have longer detail text.** Hovering or selecting either one explains what pausing actually does (blocks new prompts, in-flight turns complete, reply buffering is Claude's job), matching the detail treatment Cancel already had.
- **Usage widget error state uses `$(sync-ignored)` instead of `$(cloud-offline)`.** The two states (network offline vs API temporarily unavailable) used to share a glyph. The distinct icon makes it easier to tell at a glance whether the issue is your connection or the provider.
- **Codex session tooltip shows the raw model slug instead of a prettified name.** `gpt-5.1-codex` now reads as `gpt-5.1-codex` instead of `GPT-5.1 Codex`, matching what Codex CLI shows everywhere else. An invalid model ID stored in a session (like `gpt-5.5`, which is not a real Codex model) is immediately visible in the tooltip now. Previously the prettify made it read as plausible until the next prompt fired and the API returned 404.
- **Epic Handshake catches sessions that store an unknown Codex model slug and offers to repair them.** When Codex CLI upgrades and renames or retires a model, old bridge sessions that stored the old slug in their rollout would 404 on the next resume with a cryptic API error. The bridge now validates the stored slug against your local Codex models cache before every resume. If the slug is unknown, the turn fails early with a clear message pointing at the new "Repair sessions" action under Manage Codex Sessions. Repair rewrites the stored slug to your current Codex default in place, only touching bridge-owned rollouts for the current workspace. A Force Repair fallback handles the case where the cache-based scan returns zero because your cache is stale, and the Codex session token tooltip flags the invalid slug with a ⚠ badge so you see it before the next prompt even fires.
- **Bridge sessions that were broken by a Codex CLI upgrade silently unstick themselves once the CLI catches up.** If you'd been running a Codex CLI that didn't know about `gpt-5.5` and upgraded to a version that does, the old bridge thread was sitting at a non-zero failure count waiting to be manually repaired. The bridge now checks before each turn: if the stored slug is now recognized by your current Codex cache, the failure count is cleared and the next prompt just resumes normally. No click required.

### Fixed

- **The Claude thinking indicator no longer stays on after an auto-compact runs.** Auto-compact writes a terminal summary entry that structurally looks like a fresh user prompt, so the transcript classifier was returning "user waiting for response" and the widget kept animating forever. The classifier now recognizes the compact summary markers (`This session is being continued from a previous conversation`, `conversation was compacted`, `<command-name>compact</command-name>`) and treats them as turn-complete, so the widget returns to idle as soon as the compact finishes.
- **"Delete All Codex Sessions" no longer reports zero when your workspace actually has bridge sessions to delete.** The scoped-by-cwd check was reading the first 8KB of each Codex rollout and trying to parse it as JSON to compare the session's workspace against yours. Recent Codex CLI releases write 15-25KB of environment context into that first line, so the parse was failing silently and every session was being rejected from the delete set. A new chunk-based reader now pulls the first line in full regardless of size, so the scope check sees the real cwd and the delete count matches reality. The same fix feeds the Recover and Repair flows.
- **Delete All's zero-count message surfaces as a toast with a "View details" button instead of a modal dialog.** When Delete All finds nothing to delete, the toast links directly to the Epic Handshake output channel, where a full breakdown of every scanned session (its thread name, cwd, and why it was included or excluded) is already logged. The Repair picker uses the same pattern when its zero-count path fires.

### Removed

## [1.2.1] - 2026-04-21

### Added

- **Epic Handshake knows which of the five turn stages Codex is in and shows it right on the status bar.** A new stage walker on the widget steps through dispatched, received, working, writing, and complete using five numbered-square glyphs, so you can watch a turn progress at a glance instead of seeing one generic animation until the reply lands. Every stage holds for at least 3 seconds so fast turns still walk the full sequence.
- **Pick your default wait mode for the bridge.** A new `wat321.epicHandshake.defaultWaitMode` setting lets you choose what mode Claude's side restores to after a VS Code restart: Standard (fixed 2 minute block per prompt), Adaptive (keeps waiting while Codex is demonstrably working, 5 minute hard cap), or Fire-and-Forget (Claude's tool returns immediately and the reply lands in the inbox when ready). The menu still cycles through the three modes live. This just picks the baseline.
- **Delete all Codex sessions for this workspace in one go.** A new command palette entry (`WAT321: Epic Handshake - Delete All Codex Sessions`) wipes every bridge-owned Codex session for the current workspace at once, so you can reset a workspace's Codex history without clicking through each session.

### Changed

- **Session token tooltips now show what the active turn is actually doing.** During an in-flight turn you see the current tool name, how many tools have been called so far, the reasoning/output token split, and a thinking hint while Codex or Claude is mid-thought. Previously the tooltip just showed the total token count. Now it tells you what's eating those tokens.
- **Usage widgets in non-OK states lead with the provider icon.** Idle, offline, rate-limited, and token-refresh states now read as `$(claude) Usage - $(key) - Idle` instead of `$(key) - $(claude) Usage - Idle`. The provider brand sits up front so you can tell at a glance which widget is the problem and the status glyph lines up where the cycle counter would be in the OK state.
- **Epic Handshake source is now organized into focused modules.** The dispatcher, status bar, menus, and thread persistence monoliths each split into narrower units that match their real concerns (mailbox, threadLifecycle, turnRunner, turnMonitor, turnHeartbeat, menuPickers, statusBarState, and more). No behavior change - the split just makes each file readable end-to-end and keeps the engine/tool boundary clean.

### Fixed

- **System notifications on macOS and Linux no longer report success when the OS path actually failed.** If `osascript` or `notify-send` is missing, the notification layer used to return `true` optimistically because the spawn error arrives asynchronously. Diagnostics now remember the failure and report the honest outcome on the next call, so health output doesn't tell you notifications are working when they aren't.

### Removed

## [1.2.0] - 2026-04-20

### Added

- **Epic Handshake lets Claude ask Codex a question and get a real answer back.** A new status bar widget sits alongside the usage and session token tiles and shows whether the bridge is ready, working, or paused. When Claude calls the bridge from a prompt, WAT321 hands the question to a local Codex app-server in read-only sandbox mode and streams Codex's reply straight back into Claude's turn. Threads persist per workspace so follow-up questions keep their context, and the widget surfaces failures passively the same way the usage widgets do. The bridge is opt-in and only activates when you actually install the MCP entry. Everything it writes lives inside `~/.wat321/`.
- **Codex session token widget now recognizes reasoning and tool-call activity.** The thinking indicator lights up during Codex's reasoning passes and any `*_call` response items, not just the final assistant message. You see the widget working through a longer turn instead of sitting idle until the text lands.

### Changed

- **Codex session token warning thresholds widened to 75% / 85%.** The white-to-yellow shift now happens at 75% used and the amber warning at 85%, so you get a softer ramp into the danger zone instead of a sudden jump near the top.
- **Usage widgets lead with the provider's brand icon even in non-OK states.** Idle, offline, and rate-limited states now show the Claude or OpenAI glyph up front so you can tell at a glance which provider you're looking at without reading the label.
- **Session token polling cadence is now defined in one place.** The 15-second poll and 51-second rescan intervals are hoisted to `src/shared/polling/constants.ts` so both providers stay in lockstep and future tuning is a single-file edit.

### Fixed

- **Codex notifications fire on the session you're actually using.** When Codex rolls over to a new transcript file mid-work, the notification bridge now resets its baseline for the new path instead of carrying stale state across the swap. Fast turns on a freshly-rolled session no longer get silently skipped.

### Removed

## [1.1.7] - 2026-04-18

### Added

### Changed

- **Smaller download.** The marketplace icon was shipping as a 1000x1000 source file that adds about 800 KB of unnecessary weight to every install. The 512x512 variant looks identical at every display size the marketplace actually uses and drops the packaged `.vsix` download well under 1 MB.

### Fixed

### Removed

## [1.1.6] - 2026-04-18

### Added

### Changed

- **Status bar 5-hour labels drop the parentheses.** Reads as `5h 76%` now instead of `(5h) 76%`. The brand icon already tells you which provider you're looking at, so the extra punctuation was just noise.
- **Usage tooltips now lead with the Claude or OpenAI brand icon.** Matches the status bar surface so you can tell at a glance which provider's tooltip you're reading without scanning the heading text.
- **The extension icon gets the full WAT321 tile treatment.** The marketplace listing and extension panel now show the colored tile variant on a light background.

### Fixed

- **No more "Offline" scare after you've been away from Claude for a bit.** Anthropic's usage endpoint throttles cold polls before you've had any activity in the session. WAT321 now shows that as a calm "Idle" state with a short note that usage data returns on Claude's next activity, instead of the alarm-level Offline label with a 16-minute countdown that never actually applied. The active rate-limited state during real use still surfaces the countdown.
- **Codex toasts fire reliably for fast responses.** Quick "Are you there?" -> "Yes" style turns were being eaten by a race between how Codex writes rollout events and how WAT321 watched for changes. The bridge now treats a turn-classifier transition to done as a separate firing trigger so those fast turns no longer get silently skipped.
- **Clicking into an older Codex session no longer pops a stale toast.** Previously, switching into a session whose last assistant turn was hours old would fire a fresh notification as if the message had just arrived. A new freshness check on the transcript file's write time blocks notifications for anything older than 30 seconds.

### Removed

## [1.1.5] - 2026-04-17

### Added

- **Session token widgets show when Claude and Codex are thinking.** A gentle animated indicator appears on each session token widget while a prompt is being processed, so you can tell at a glance whether your CLI is still working. The indicator lights up promptly on send and clears instantly on response or interrupt. Detection combines a transcript tail classifier with process liveness for Claude and a short mtime backstop for both.
- **Claude and OpenAI brand icons on every widget.** The status bar widgets now lead with the official brand glyph instead of the provider name text or the older thinking-bubble / pipe prefixes. The line reads shorter and tells you which provider you're looking at without having to read.
- **`WAT321: Show Provider Health` is now in the Command Palette.** Previously you had to invoke it via `code --command` from a terminal. It now shows up alongside `WAT321: Reset WAT321` where you'd expect to find it.

### Changed

- **Windows toast notifications now handle em dashes, smart quotes, emoji, and curly-quote title wrappers correctly.** The warm PowerShell process that delivers toasts forces UTF-8 input and output so non-ASCII content no longer gets mangled into `?` characters on its way to Windows.
- **Windows toast notifications now work on VS Code forks.** Insiders, VSCodium, Cursor, Windsurf, and anything else that registers a unique AppUserModelID at install. Discovery runs inside the warm PowerShell process keyed on the host's app name, with a fallback to the generic `powershell` AUMID so delivery never silently drops on an unfamiliar host.
- **macOS and Linux System Notifications are actually the OS toast now.** If you pick "System Notifications" mode on macOS you get a real macOS notification via `osascript`. On Linux you get `notify-send`. Previously both platforms quietly fell back to in-app banners.
- **Notification settings moved to application scope.** `notifications.mode`, `notifications.claude`, and `notifications.codex` can't be silently overridden by a workspace `.vscode/settings.json` anymore. A one-time scope heal on startup strips any stuck workspace-level values left by older versions.

### Fixed

- **The Codex session token widget now picks the session you're actually using.** When returning to an older Codex session, the widget used to stick on the most recently created session instead. Rollouts are now ranked by file modification time rather than filename, so the widget follows whichever session you're actively writing to.
- **The thinking indicator resolves instantly when you press Escape or Ctrl+C.** For both Claude and Codex, interrupts are detected directly in the transcript (`[Request interrupted by user]` for Claude, `turn_aborted` for Codex) so the indicator goes idle immediately instead of hanging on for its backstop to age out.
- **The Claude session token widget no longer holds a stale process ID when a session comes back.** The fast path that skips work when the transcript hasn't changed was preserving an old pid through a session-source flip. It now passes the current pid through, so process liveness correctly reflects the returning CLI.

### Removed

## [1.1.4] - 2026-04-16

### Added

- **New-process instant discovery.** Both Claude and Codex now notice a fresh CLI session the moment it appears on disk instead of waiting for the next scan. The session token widgets light up instantly when you open a new terminal.
- **Warm Windows toast process.** System notifications on Windows now fire near-instantly. The underlying PowerShell process is spawned once, stays warm, and handles every subsequent toast without cold-start delay.
- **Health command shows real diagnostics.** The hidden `WAT321: Show Provider Health` command (invoked from the palette) now reports each provider's live state, rate-limit park countdown, active transcript paths, recent lifecycle transitions, and the last 20 notification delivery decisions. Useful when something looks off and you want to know why without reopening an issue.

### Changed

- **System Notifications mode is now literal.** If you set the notification mode to System Notifications, you'll get exactly that - no silent fall-through to in-app delivery when a stale workspace override is present. A one-time scope heal on startup also strips any stuck workspace-level value so the mode you see in Settings is the mode you get.
- **Windows toast failures fall back to in-app.** If the Windows toast path can't deliver (process died, stdin closed), you'll see an in-app notification instead of a silent drop. The event will not be lost.
- **Notification and per-provider toggles are now user-scoped.** They can't be silently overridden by a workspace `.vscode/settings.json` anymore, which is the root cause of the "why am I seeing random notifications?" problem.
- **Reset now clears session token widgets immediately.** Previously the widgets would keep showing the last known session until the next poll re-discovered it. Reset now wipes in-memory state across the board.

### Fixed

- **Codex session token notifications now fire reliably.** Previously an unrecognized Codex event shape at the tail of a rollout could silently suppress the toast. The classifier now skips unknown events and keeps scanning, so notifications only get suppressed on genuine mid-turn events.

### Removed

- **Experimental auto-compact cleanup code removed.** The temporary migration path for the v1.1.3-retired Force Auto-Compact has been taken out now that the window has closed. WAT321 once again strictly honors "no writes outside `~/.wat321/`".
- **Dead `isReady()` export** on the Windows toast module (internal cleanup, no behavior change).

## [1.1.3] - 2026-04-16

### Changed

- **Codex notifications now show the actual response text instead of a generic "response complete".** The response parser now recognizes all known Codex rollout event shapes so the toast body matches what you see in the terminal. Codex also gets the same turn-completion gating that Claude already had, so you only get notified on actual finished responses instead of mid-tool-call bookkeeping

- **Codebase reorganized into focused modules, no behavior change.** File renames for clarity (`resetSettings`, `workspaceScopeHeal`, `transcriptClassifier`), the kickstart state machine extracted into its own module, text color helpers split from the heatmap file, and the session token widgets now use the same thin-descriptor pattern as the usage widgets. The extension works identically - this is housekeeping that makes future changes safer

### Fixed

- **You no longer get a duplicate notification 30-60 seconds after Claude finishes a response.** Post-response transcript writes (auto-compact summaries, system entries) were being treated as new responses. The notification bridge now only fires on context increases and only when the last transcript entry is a genuine assistant message

- **Codex session tokens now pick up mid-session model switches immediately.** If you use `/model` to change models during a Codex session, the widget and tooltip used to keep showing the old model name and ceiling until you started a new session. The model is now resolved from the most recent turn on every poll

### Removed

- **Force Auto-Compact experimental setting removed.** Claude Code now handles auto-compact natively across all supported context sizes. A temporary cleanup runs on startup to restore any `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` left by prior versions

## [1.1.2] - 2026-04-16

### Changed

- **Notification default is now System Notifications instead of Auto.** Previously the default mode switched between system toasts (when tabbed away) and in-app notifications (when focused). The new default always uses system notifications so you get the native Windows toast with sound regardless of focus state. You can still switch to Auto, In-App, or Off from the Notifications section in Settings.

### Fixed

- **Force Auto-Compact no longer chains multiple compacts in a row.** Arming the experimental auto-compact and sending a prompt could trigger 4-5 consecutive compacts before the tool could intervene, requiring a manual breakout. The override now uses a calculated threshold just below your current context level instead of the old blanket "compact at 1%", so exactly one compact fires and the post-compact context falls safely below the threshold. Prompt detection also switches from 2-second polling to instant file-system events, restoring your settings within milliseconds of your prompt landing.
- **Notifications no longer fire between tool calls.** If Claude was using tools during a response, you would get a notification toast on every tool call and tool result instead of just the final answer. The notification bridge now classifies the last transcript entry and only fires when the turn is actually complete - a final assistant message with no pending tool calls.

## [1.1.1] - 2026-04-16

### Added

- **You now get notified when Claude or Codex finishes a response.** A system notification pops up with the session name and a preview of the reply so you know which session finished and what it said. On Windows you get a native toast with the default notification sound. On macOS and Linux, notifications show inside the editor. Enabled by default in Auto mode - system notifications when you've tabbed away, in-app when you're already looking at the editor. You can switch to System Notifications (always), In-App (always), or Off from the new Notifications section in Settings. Each provider can be toggled independently.

### Changed

- **Notifications route through the core engine instead of being wired directly.** Session token services no longer know about notifications at all. A new `session.responseComplete` event on the EventHub handles all the routing, so the notification system is fully pluggable.
- **Progress bars across all widgets now share a single builder.** Claude, Codex, and session token bars all delegate to one shared function. Each keeps its own color and display style.
- **Clearer variable names in session token services.** `lastFilePath` is now `cachedTranscriptPath`, `lastFileSize` is now `cachedTranscriptSize`, and `lastLastKnownScan` is now `lastFallbackScan`. No behavior change.
- **Codex parser function renamed for clarity.** `parseFirstUserMessage` in the Codex parser is now `extractFirstUserMessage` to make it obvious it takes pre-read content, not a file path (the Claude version still reads the file itself).

## [1.1.0] - 2026-04-16

### Added

- **Your session token tooltips now show which model you're on and the full context window.** Hover Claude or Codex session tokens to see the model name (e.g. "Opus 4.6") and context window size (e.g. "1M context") right below the session title. The model updates live if you switch mid-session with `/model`.
- **Hidden debug command for checking provider health.** Run `WAT321: Show Provider Health` from the command palette (type the full name) to see which providers are activated and the engine state. Useful when something looks off.
- **Typed event system for future cross-cutting features.** The engine now emits provider lifecycle events (activated, deactivated, connected, disconnected) that future features like toast notifications can subscribe to.

### Changed

- **WAT321 now runs on a core engine.** Provider lifecycle, widget metadata, setting keys, and model detection are all centralized. Adding a new provider no longer requires edits across 6 files. No behavior change from the user's perspective - everything works the same, just better organized under the hood.
- **Session token auto-compact ceiling is now model-aware.** The ceiling shown in your session token widget adapts to your model's context window size instead of showing a flat 85% for all models. On a 1M-context model like Opus 4.6, the ceiling is ~970k instead of the old 850k.
- **All four usage widgets share a single rendering engine.** Claude and Codex usage bars (5h and weekly) now run through one config-driven widget class. Same look, same behavior, less code to maintain.
- **TypeScript upgraded to 6.0.** The extension now builds on TypeScript 6.0.2 with modern module resolution. VS Code engine floor raised to 1.100 (December 2024).

### Fixed

- **Codex session tokens now refresh properly on display mode toggle.** Switching between Full, Compact, and Minimal could show stale token data for Codex because the rebroadcast path skipped a file re-read. Both providers now behave the same.

## [1.0.21] - 2026-04-15

### Changed

- **Force Auto-Compact now silently clears once your prompt lands.** Previously the red `! ARMED` indicator stayed visible while Claude was auto-compacting, and then timed out with a "disarmed" toast even though the compact ran successfully. Now the indicator hides the moment your prompt is detected in the transcript, the wait window extends to three minutes so long compacts finish cleanly, and there are no toasts after your prompt lands. If you never type a prompt, the original 30-second timeout still fires with its usual notification.
- **Your Claude settings are now restored by deleting the override key, not by writing a replacement value.** We confirmed that removing `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` entirely returns Claude to its own built-in default formula. The old four-tier backup chain (sentinel, 3-slot backup ring, install snapshot, hardcoded "85") is replaced by a simpler two-tier chain: restore the sentinel's recorded value, or delete the key. WAT321 never writes a percentage to your settings during restore - only your exact original value or key removal.
- **Claude and Codex usage services now share a single state machine.** The polling lifecycle (discovery, caching, rate-limit parking, kickstart escalation, error absorption, dispose) previously existed as two near-identical 450-line files. Both providers now extend one shared base class, eliminating about 400 lines of duplicated code and guaranteeing the two providers can never drift on critical rate-limit or recovery behavior.
- **Codebase polish from a full 58-file manual audit.** Shared `StateListener<T>` type replaces four duplicate listener declarations. Widget activation consolidated into a single `activateWidget` helper. `CODEX_BASELINE_TOKENS` is now one constant instead of two. Setting keys for action-trigger checkboxes are centralized. Heatmap emoji declarations reordered for readability. Dead `SessionEntry.kind` field removed.

### Fixed

- **Claude session tokens no longer go blank on the second VS Code open.** If you opened VS Code without a live Claude session, closed it, and opened again, the widget would show "Claude -" permanently. A stale entry in `~/.claude/sessions/` was pointing at a transcript that was never written, and the widget locked into a "waiting" state instead of falling through to your last known session. The widget now verifies the transcript exists before committing to it.

## [1.0.20] - 2026-04-15

### Added

- **The Claude and Codex usage widgets now resume on their own when the provider recovers.** Previously, if Anthropic or OpenAI went down and returned a long `Retry-After` header, your widget would sit "Offline" for up to 45 minutes and there was nothing you could do about it. Now each usage service watches your active session's transcript file. If you are actively using Claude or Codex when the API comes back up, the widget wakes itself within about two minutes. No clicks, no reload, no waiting out the full park. The new constants live in `src/shared/polling/constants.ts`.
- **Parked widget tooltips now explain why.** When your usage widget is parked in "Offline", the tooltip now surfaces the server's 429 reason (like "HTTP 429 Too Many Requests (possible API outage)") and, if there is a live incident on the provider's public status page, a line reading "Anthropic status: Partial System Outage" or similar. Lazy and cached - the status page is only read from the tooltip render path and at most once per five minutes. Silent on any fetch failure.
- **Reset WAT321 now also clears accumulated rate-limit backoff state.** If you ever find yourself escalated to the longer retry cadence during a bad outage and want to try a fresh attempt without waiting it out, the Reset command will zero the counter. Gating still applies - the reset does not force an immediate fetch, it just gives the next gate check a clean slate.

### Changed

- **Usage widgets cap any server `Retry-After` at fifteen minutes.** Nothing against the provider's own guidance, but when their edge returns a value in the 40+ minute range during a recovery, honoring it literally strands the widget long after the API is actually back up. The cap gives us the same "back off, do not hammer" behavior without leaving you stranded. Lives alongside the other polling constants.
- **Sustained outages now escalate retry spacing progressively.** On a fresh park, the widget is responsive - it tries to wake within about two minutes of activity. If that attempt fails, the next one waits five minutes. Then ten. Then fifteen, at which point it effectively stops trying to wake and lets the normal park timer handle retries. A single successful fetch resets the ladder so short outages still get the full responsive behavior. Driven by `KICKSTART_ESCALATION_MS`.
- **Codex session token polling is now staggered one second off Claude.** Both providers used to poll local transcripts on the same tick. Now Codex is on a 6-second cadence and Claude stays at 5, so two active providers never `stat` the same tick. No user-visible effect, just slightly kinder to the filesystem.
- **Codebase split into focused modules, no behavior change.** The experimental Force Auto-Compact service had its armed status bar item peeled off into its own file, and the Reset WAT321 flow had its workspace `.vscode/settings.json` heal split into an `applicationScopeHeal` module. Both are internal splits for readability. The product surface is unchanged.

### Removed

- **Click-to-wake affordance on parked usage widgets.** The earlier "click to resume polling" path on the rate-limited widget was only meaningful when WAT321 was guessing at a wait time. Now that recovery is fully automatic via the activity kickstart, no widget state is clickable. The surface area is smaller and the UX is consistent with the rest of WAT321's passive-recovery posture.

## [1.0.19] - 2026-04-15

### Added

- **Heatmap colors on the usage progress bars.** Bars now gradually shift through warning colors as you get closer to your limits, so a tight session stands out at a glance instead of looking the same as a fresh one. On by default. Turn it off in settings if you prefer plain bars. The new toggle is `wat321.enableHeatmap`.
- **Known Issues section in the README.** A short, friendly list of rough edges that are worth knowing about - things like a stale Max plan tier label after an upgrade or what to do when you see "Offline" with a countdown. None of them need any action on your part. They either self-heal or are waiting on upstream fixes.

### Changed

- **Codex session tokens now match Codex's own native hover byte-for-byte.** The widget previously read a different denominator than Codex's built-in display (245k vs 258k) and counted slightly fewer tokens per turn than Codex did. After research into the upstream Codex source, your widget now uses the same effective context window, the same `total_tokens` field, and the same baseline-normalized percentage formula Codex uses internally. If you cross-check the two displays they will agree.
- **Claude session tokens count the full per-turn footprint.** Previously the widget summed input plus cached input but skipped the output tokens for each turn. The displayed value is corrected. The visual change is below the rounding threshold so most reads look identical, but the underlying number is now accurate.
- **Auto-Compact wording in the session token tooltips matches what each provider actually does.** Claude shows `Auto-Compact at {ceiling}` because Claude's compact fires exactly at that point. Codex shows `Auto-Compact ~{value}` because Codex's effective context window is the displayed ceiling but the actual compact fires a bit earlier.
- **Reset WAT321 now also restores Enable Heatmap to its default.** The new heatmap toggle was missing from the reset list, so toggling it off and running Reset would not flip it back on. Fixed in `src/shared/clearSettings.ts`.
- **Command palette entry renamed from "WAT321: Reset All Settings" to "WAT321: Reset WAT321"** so it matches the settings checkbox label and the rest of the docs. The internal command id is unchanged.
- **Settings descriptions tightened across the board.** Shorter sentences, less boilerplate, and the Minimal display mode description is corrected to say progress bars *move* to tooltips on hover instead of *remain* in tooltips.
- **Cross-project fallback label for the Claude session token widget is now correct.** When you have no Claude transcript in the current workspace and WAT321 falls back to your globally most-recent session, the widget now shows that other project's name instead of the current workspace name. The earlier limit could miss the `cwd` field on transcripts that started with many control events.`parseCwd` in `src/WAT321_CLAUDE_SESSION_TOKENS/parsers.ts` now scans further into the file.
- **README screenshots redone at retina-sharp resolution.** Every screenshot is now sized so it renders 1:1 with device pixels on a 4k display, removing the soft or upscaled look you may have noticed if you read the README on a high-DPI monitor.

### Fixed

- **Session token color now actually applies a color.** Both session token widgets previously fell through to the default theme foreground when they tried to highlight near-compact sessions, because VS Code only renders the warning foreground theme token when paired with a matching warning background. The widgets now use explicit hex values instead, so the warning is visible on every theme.
- **License field added to `package.json`.** The `LICENSE` file and README both said MIT but the package metadata had no declaration. Would have failed strict marketplace validation.

### Removed

- **No more "Not Connected" prose in the README.** The Provider Toggles section used to mention an old UX label state that no longer exists. Cleaner wording, no behavior change.

## [1.0.18] - 2026-04-14

### Fixed
- **Packaging hardening, no behavior change.** Local environment files (`.env`, `.env.*`) are now excluded from the packaged extension so a developer's local credentials cannot end up bundled inside the `.vsix`. If you are upgrading from 1.0.17, every WAT321 feature behaves the same as before - this release exists purely to ship the cleaner package.

## [1.0.17] - 2026-04-14

### Fixed
- **Reset WAT321 now actually responds the first time you click it.** The checkbox at the bottom of the WAT321 settings page was getting silently blocked by a stale workspace-level value left behind by an early-adopter build, so clicking it in user settings would do nothing - no toast, no dialog, nothing. The reset trigger and the experimental Force Claude Auto-Compact checkbox have both been hardened so they can only ever live at the user level, never per-workspace, and a quiet one-shot heal runs the first time you open WAT321 after upgrading to scrub any stale value out of your workspace settings file. After the upgrade the click-and-confirm flow works on the first try.
- **Claude Session Tokens now keeps showing your most recent session at startup, even when no Claude session is actively running.** Before this, the widget would land at "Claude -" with a "No active Claude session" tooltip on a fresh VS Code launch, even though Codex Session Tokens correctly showed the last session in the same situation. The Claude widget now mirrors how Codex resolves the last-known session: scan the current workspace's transcripts first, fall back to the globally newest transcript across every project if nothing matches, and never quietly degrade a known-good session back to a blank state mid-poll. When the widget is showing a snapshot from a previous session, the tooltip already says "Last active: X ago" so you know what you are looking at, and the cross-project fallback now correctly labels the snapshot with its real project name instead of the current workspace's name.
- **The experimental auto-compact arm-blocker toast now says something useful when there is nothing to arm.** Before this it read `Open Claude Code and send a prompt first so WAT321 can target your session.`, which described the wrong sequence of events. It now reads `No active Claude session. Send a prompt to activate Claude session.` so the message matches what is actually missing.

## [1.0.16] - 2026-04-13

### Added
- **A red `❗ ARMED` status bar item now shows up whenever the experimental Force Claude Auto-Compact is armed.** It sits just to the left of your Claude session token widget. Hover to see what it is, click it to disarm immediately. The widget only exists while armed - it appears the moment you confirm the arm dialog and disappears the moment the tool disarms for any reason (your next prompt fires a compact, the 30-second timeout hits, you click the armed widget, or you untick the checkbox)
- **Arming now asks you to confirm first.** Ticking the experimental Force Claude Auto-Compact checkbox pops a confirmation dialog asking if you really want to arm for your next message. Cancelling the dialog leaves your Claude settings untouched and unticks the checkbox. This matches the new settings description, which now says "A confirmation dialog will appear before arming."
- **Preflight safety gates now refuse arming when it would waste a compact or risk a loop.** Before the confirmation dialog appears, WAT321 checks six things about your current Claude session: no live session to target, Claude is still mid-turn on a prompt or tool call, you are below 15% of the auto-compact ceiling (nothing meaningful to compact), your session was compacted within the last two minutes, you are still inside the 30-second post-disarm cooldown, or your auto-compact override is already stuck at 1 from a prior session. Each failure shows a friendly toast explaining exactly what to fix. The mid-turn check watches the transcript directly and blocks arming through an entire long-running tool call, not just the first few seconds. No background polling, no passive widget grayed-state - the gates run once when you tick the box and never again

### Changed
- **The experimental Force Claude Auto-Compact checkbox is now the armed state itself**, not a fire-once trigger. Ticking the box and confirming the dialog arms the tool and leaves the box ticked while armed. Unticking the box at any point during the armed window disarms immediately. On compact detection or the 30-second timeout, WAT321 unticks the box for you. One source of truth for whether the tool is armed right now: the checkbox
- **Toast wording is shorter and more specific.** The arm toast reads `Claude Auto-Compact armed. Next prompt will trigger Auto-Compact.`, the timeout disarm reads `Claude Auto-Compact disarmed. Timed out after 30 seconds.`, and user-cancel disarms (unticking the box, clicking the armed widget) now surface a short `Claude Auto-Compact Disarmed. Cancelled.` toast so every path confirms what happened
- **Armed widget tooltip now explains what arming does.** Hovering the red `❗ ARMED` widget shows the title, a one-line explanation (`Your Claude session will Auto-Compact on next prompt.`), and a bolded `Click to disarm.` footer
- **Reset WAT321 description tightened.** Small wording pass on the setting's description so the reset-as-failsafe guarantee reads more clearly

### Fixed

### Removed

## [1.0.15] - 2026-04-13

### Added
- **Force Claude Auto-Compact is now an experimental checkbox in the Claude settings section.** Flip `WAT321: Experimental > Force Claude Auto-Compact` on right before sending your final message to Claude for the day. WAT321 lowers `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `1` in `~/.claude/settings.json`, waits up to 30 seconds for the compact to fire, restores your original value, and turns the checkbox back off automatically. A 30-second cooldown after each cycle prevents accidental double-arms. Your Claude settings are backed up every time this arms, and WAT321 heals a stuck override on the next VS Code start if something goes sideways. **Heads up:** a forced compact still counts against your Claude usage the same way the manual `/compact` command does, so only flip this on when you actually want to spend a compaction

### Changed
- **Force Claude Auto-Compact no longer ships as a status bar widget.** The old one-click widget required a context-fraction gate, a claude-busy gate, a click-to-repair affordance, and a one-time consent prompt to stay safe - and even with all of that, compacting still costs you a message against your usage on the very next turn. The experimental checkbox replaces all of that with a single toggle you flip when you actually want the compaction, which is almost always only at the end of the day. The full v1.0.14 tool is archived under `ARCHIVE/WAT321_CLAUDE_FORCE_AUTOCOMPACT_v1.0.14/` inside the repo working tree in case we ever want to bring any of it back
- **Reset WAT321 now also restores any WAT321 widgets you hid from the status bar.** If you previously right-clicked one of the six WAT321 widgets and chose Hide, running Reset WAT321 will bring them all back. The reset stays narrowly scoped to the six widget ids WAT321 actually creates - no other status bar item in your VS Code is touched

### Removed
- **Claude Force Auto-Compact status bar widget and its supporting code.** The widget, preflight gate (context-fraction / claude-busy / loop detection), passive availability resolver, post-disarm cooldown loop-detection watcher, consent helper, and tool-specific command palette entry are all gone. The `wat321.enableClaudeForceAutoCompact` setting and `wat321.claudeForceAutoCompact` command were removed from `package.json`. The sentinel, arm backup ring, install snapshot, and four-tier heal chain all survive in the new slim `src/WAT321_EXPERIMENTAL_AUTOCOMPACT/` service that powers the experimental checkbox
- **One-time consent prompt helper** (`src/shared/consent.ts`) is no longer needed because the experimental setting is itself the opt-in gate

## [1.0.14] - 2026-04-13

### Added
- **Click the usage widget to resume polling when it looks stuck.** If a Claude or Codex usage widget lands in its 15-minute "Offline" state because WAT321 fell back to a conservative guess after a 429, the widget is now clickable. Clicking it resumes polling at the normal cadence right away, and the next three rate-limit responses are absorbed silently so a single transient 429 does not snap it straight back to sleep. The click-to-wake affordance only appears on the fallback wait - if the server told us to wait a specific amount of time via a Retry-After header, the widget stays hover-only. We never override a delay the server explicitly asked for
- **Claude Force Auto-Compact now waits for Claude to finish its turn before it lets you arm it.** If Claude is mid-response or still running a tool call when you click the button, the widget stays grayed with a tooltip explaining what is going on. It lights back up the instant Claude finishes. This prevents the next compact from firing on a queued prompt or a tool-result callback instead of the prompt you actually meant to trigger it with

### Changed
- **Usage widgets now honor the server's rate-limit wait time instead of always falling back to a flat 15 minutes.** When the Anthropic or ChatGPT usage endpoint returns a 429 with a Retry-After header, WAT321 now reads that header and waits exactly that long. If there is no header we still fall back to our own 15-minute guess, but you can now click the widget to resume polling early if you think the server is ready again
- **Claude Force Auto-Compact now gives you 30 seconds instead of 10 to actually send a prompt after arming.** The old 10-second auto-disarm was too aggressive for anyone who clicks arm and then reads their prompt before sending. 30 seconds also makes the timeout the unified safety net for every "nothing happened" scenario - you armed by mistake, you walked away, Claude was mid-tool-call when you armed, and so on - so one failsafe catches everything
- **Claude Force Auto-Compact arm confirm dialog is shorter and clearer.** The old dialog padded the message with threshold hints and multi-session warnings that duplicated what the grayed `unavailable` state was already telling you. Rewritten into a single sentence that names the target session and confirms what your next prompt will do
- **Reset WAT321 now works even when you have no workspace folder open.** The old reset path tried to update settings at the Workspace and WorkspaceFolder scopes regardless and threw two guaranteed errors in the common no-workspace case. The six `wat321.*` keys also reset in parallel now instead of sequentially
- **Codebase reorganized into focused shared helpers**, no behavior change. The four usage widgets now share one generic activator and one shared non-OK state renderer, the Force Auto-Compact tool's timing and threshold values all live in one centralized `constants.ts`, and a handful of single-caller helpers were inlined into their callers. Per-tool framework documentation was removed entirely because every doc had drifted into a worse copy of the code. The source tree is now authoritative

### Fixed
- **Claude Force Auto-Compact no longer double-reports the loop warning** if the post-disarm watcher sees more than one stray compact in the same 30-second window. The first stray still triggers the "close and reopen your Claude terminal" toast. Subsequent ones in the same window are silent
- **Claude Force Auto-Compact internal sentinel-ownership tracking is now consistent.** The passive availability resolver used to hardcode "this sentinel is not ours" in every snap check, which was harmless because the resolver never ran during armed state anyway, but would have silently misreported the moment a future caller invoked it outside that guarded path. The tracker now takes a getter so the answer is always live
- **Claude Force Auto-Compact idle poll no longer re-reads `~/.claude/settings.json` on every tick.** The passive resolver now caches the parsed settings file against its mtime, so idle sessions pay only a stat call until the file actually changes

### Removed
- Dead `loadingTooltip` option on the shared usage non-OK renderer (was declared and passed from both 5h widgets but the loading branch hardcoded its own string)
- Unused `adopted-restored` variant on the Force Auto-Compact `DisarmReason` type (zero emitters, zero consumers)
- Unused `getCooldownRemainingMs()` and `hasCooldownLoopDetected()` on the Force Auto-Compact service plus their backing watcher methods (the passive resolver stopped consulting cooldown state when the context-fraction gate replaced the time-based cooldown-as-arm-gate path)

## [1.0.13] - 2026-04-13

### Changed
- **Claude Force Auto-Compact now grays itself out when arming would not help.** The button used to always look ready and then refuse at click-time with an error toast. Now it reads your live Claude context and, if you are below 20% of the session's auto-compact ceiling, the button passively grays out with a tooltip explaining that there is not enough context to produce a useful summary yet. As soon as your context grows past the threshold, it wakes back up on its own. No clicks, no toasts, no guesswork
- **The grayed state also covers every other reason arming is unsafe**: a suspected compact loop, an unreadable settings file, a stuck override left behind by a crash, a missing Claude settings file, or another VS Code window already driving a compact. Each reason has its own tooltip that tells you what is going on and, where WAT321 can fix itself, the grayed button is clickable to trigger the repair directly
- **Click-to-repair** - if the grayed reason is something WAT321 can heal on its own (stuck override, transient read error), the button becomes clickable while grayed and runs the repair path in place. You no longer need to open the command palette and Reset WAT321 to recover from a stuck state
- **Auto-repair runs quietly in the background** when WAT321 notices its own override got stuck at the armed value, limited to once every five minutes so a genuine loop cannot spin the heal path
- **First-use consent notification is shorter and clearer.** The old version opened with the tool name twice (VS Code renders the first sentence as the header) and padded the body with separator lines. Rewritten into a single flowing paragraph that leads with what the tool does and ends with the grant question
- **Error messages along the arm path dropped the jargon.** Every refusal message now reads like a sentence a human would say, does not reference internal file paths, and does not tell you to "write a message first" (which contradicted the morning-resume workflow the tool is designed for)
- **Settings page wording polished throughout.** Each tool's enable description now reads in full sentences matching the feature names ("Enable Claude Usage and Claude Session Token widgets...", "Enable Claude Force Auto-Compact widget..."), the Reset WAT321 description reads "If any WAT321 tool appears unresponsive, this will reset every tool back to a known-good state", and the command palette entry reads `WAT321: Enable Claude Force Auto-Compact tool` so the disabled default state reads as a next-step action
- **Force Auto-Compact poll cadence is now dynamic.** The service polls every two seconds while armed or watching for a stray compact, and every fifteen seconds the rest of the time. The Claude session token widget piggybacks its own reads into the availability check, so the grayed state still reacts within about five seconds even during the idle cadence. Net effect: the widget feels instant when it matters and is effectively free when it doesn't

### Fixed
- **The `"1"` poison value can no longer end up in any backup file.** Every backup tier (install snapshot, arm backup ring) refuses to write the armed value, so a crash mid-arm cannot leave a backup that, when restored, would re-arm the tool
- **Reset WAT321 now preserves the original Claude install snapshot across its wipe.** Before, resetting would clear the one file that knew what your original auto-compact setting was, leaving recovery reliant on the hardcoded Claude default. The snapshot is now read, held in memory during the `~/.wat321/` wipe, and rewritten afterward so the canonical baseline survives reset
- **An unreadable Claude settings file now pauses arming instead of triggering a bad write.** The reader distinguishes "file missing", "file unreadable", and "file OK but key absent" as separate outcomes, and the arm path refuses to proceed on any read error. Stale sentinels are never cleaned up on a read error either
- **Post-disarm stray compacts caused by cached CLI env vars are now detected and surfaced.** If a second compact fires inside a thirty-second window after WAT321 successfully disarms, the tool assumes the CLI is still holding a cached copy of the old override value and notifies you via a loop-detected event. The watcher runs as a diagnostic, not an arm gate, so it does not block legitimate use

### Removed
- Time-based recency gates (`recent-native-compact` and `post-disarm-cooldown`). Both edge cases fold into the single context-fraction gate because post-compact context is always well below the 20% threshold anyway
- `formatArmErrorMessage` helper and several other stale symbols left over from earlier review rounds

## [1.0.12] - 2026-04-13

### Changed
- **The Auto-Compact button in the status bar now always shows just `🗜️ Auto-Compact`**, with no live token count. You already see token usage in the Claude Session Tokens widget next to it, and doubling it up made the button too busy. Tooltip still shows the session you're about to target and its usage
- **Auto-Compact tooltip is shorter and clearer**: "Higher-quality summary than `/compact` - preserves tool results and reasoning."
- **First-use consent dialog no longer shows the tool name twice.** VS Code's notification already renders the first sentence as the header, so the old code was duplicating "Claude Force Auto-Compact" at the top. Body rewritten into a cleaner three-paragraph form
- **Reset WAT321 description now mentions the failsafe:** "If any WAT321 tool ever looks stuck, this also resets every tool back to a known-good state." Same text in both the settings page and the confirmation dialog
- **Arm refusal message for "already at override=1" points at Reset WAT321** instead of telling you to fix the file manually. The recovery is now one click away
- **Codebase reorganized into focused modules.** You will not notice any behavior change, but each service is now built from small, single-purpose files (parsers, discovery, heal, sentinel IO, compact detector, tooltips, messages, etc.) which makes future fixes much faster to land. 18 new internal modules under `src/shared/` and the widget folders. Every file is under 200 lines except for the handful of stateful service cores that would lose cohesion if split further

### Fixed
- **Claude Force Auto-Compact no longer gets stuck in a loop.** The v1.0.11 detector was watching for the transcript file to shrink when a compact fired, but Claude Code's transcripts are append-only - they never shrink. The detector never fired, the tool stayed armed for the full five-minute failsafe window, and every prompt you sent in that window triggered another auto-compact. The fix: WAT321 now scans for the actual compact-summary marker that Claude writes into the transcript, catches the compact within a couple of seconds of it firing, and restores your setting immediately. The safety timeout is also now 45 seconds instead of 5 minutes
- **Reset WAT321 now always unsticks you from a stuck override**, even if the backup file is missing or corrupt. Before, the reset flow would only restore if it could find the sentinel file. A missing sentinel meant the reset walked away and left your Claude settings stuck at override=1. Now the reset inspects `~/.claude/settings.json` directly and, if the override is still stuck at the armed value, restores it to the Claude default (85) no matter what state the backup is in. A new shared helper in `src/shared/claudeSettings.ts` is the single source of truth for reading and writing that setting, so every recovery path goes through the same code
- **Unreadable Claude settings can no longer confuse the recovery path into deleting its backup.** Rare but real: if `~/.claude/settings.json` was corrupt or unreadable, the old recovery code treated the unreadable file the same as "nothing to fix" and would delete the backup sentinel - destroying the only record of what your override value used to be. The reader now distinguishes "file missing" from "file unreadable" from "file OK but key absent", and refuses to clean up anything on a read error. Caught by Codex during review before it shipped
- **Arm refuses to proceed if `~/.claude/settings.json` is unreadable** rather than guessing. Previously it could have captured a false `null` as your "original" value, which would then have written the wrong thing on restore

### Removed
- Old file-size-shrink heuristic for compact detection (`COMPACT_SIZE_RATIO`). Replaced by the marker-scan detector described above
- Several stale comments referencing removed constants and renamed files. No behavior change

## [1.0.11] - 2026-04-13

### Added
- **Claude Force Auto-Compact** - a new optional status bar button that triggers Claude's real auto-compact on your next prompt. Produces a much higher-quality summary than running `/compact` manually because Claude uses the main model (not Haiku) and preserves tool results and reasoning. Click the button, confirm, send any prompt, and the auto-compact fires mid-turn. WAT321 backs up your current Claude setting before arming and restores it automatically within seconds of the compact firing. Safe by design: it auto-disarms if you close the Claude session, switch to a different one, or five minutes pass without anything happening. Default **off** with a one-time friendly consent prompt on first click, because this is the only WAT321 feature that writes outside `~/.wat321/`. Lives in a new **Claude Force Auto-Compact** setting under the Claude category. Also available as `WAT321: Claude Force Auto-Compact` in the command palette
- **Claude session tokens keep showing your last session after a VS Code restart.** Before, the widget would go blank the moment you closed VS Code and not recover until you clicked a session in the Claude picker and sent a prompt. Now it shows your most recent session in the workspace with a subtle `Last active Xm ago` line in the tooltip so you know it's a snapshot. The instant you resume a session, it flips back to live
- **Two-tier tool model** - WAT321 now formally separates its read-only core widgets (which never modify user files) from opt-in interactive tools like Claude Force Auto-Compact. Interactive tools are always default-off and always ask for consent on first use. Documented in `CLAUDE.md` and the framework README

### Changed
- **Session token widgets now use 💭 (thought bubble)** instead of the old 🗜️ clamp icon. The clamp is now reserved for the Claude Force Auto-Compact button where it reinforces the compact-ceiling meaning. Tooltip "Auto-compact at" lines still show the clamp
- **Tooltip reset lines now read identically on Claude and Codex.** Both providers now show `Resets 1:30AM (3hr 30min)` for 5-hour windows and `Resets in Thu (4d 1hr)` for weekly windows. Before, each provider had its own wording
- **5-hour status bar labels** say `Claude (5h)` and `Codex (5h)` in compact and minimal views for consistency and to save space. Full view still shows `Claude (5hr)` and `Codex (5 hour)` to match what each CLI shows

### Fixed
- **Claude session token widget no longer goes blank on huge post-compact transcripts.** On very large sessions, the widget could show `Claude -` after a compact because it was only scanning a tiny window at the end of the transcript and missing the most recent usage entry. The scan window is now four times larger and searches the whole tail instead of the last 100 lines
- **Codex session token widget no longer mysteriously blanks while you're still working.** An old 60-second staleness timer would drop the widget to the empty state if the rollout file stopped growing for a minute, even though the cached data was still good. Now the most recent rollout for the workspace is shown for as long as it exists on disk
- **Claude settings writes are now atomic.** Both the arm and restore paths for Claude Force Auto-Compact write `~/.claude/settings.json` via a temp-file rename, so a process crash mid-write can't truncate the real settings file. The restore path is the recovery path, so it especially needs to not make things worse on failure

### Removed
- Old provider-specific reset line formatters (`formatSessionReset`, `formatWeeklyReset`, `formatWindowReset`) now superseded by the shared `resetFormatters.ts` helper
- `STALE_TIMEOUT` dead code from the Codex session token service after the blanking behavior was removed

## [1.0.10] - 2026-04-12

### Added
- **Shared polling subsystem** under `src/shared/polling/` - new `constants.ts`, `stateMachine.ts`, `discovery.ts`, `httpClient.ts`, and `httpError.ts` modules consolidate every piece of duplicated polling logic between the Claude and Codex usage services
- **Generic type primitives** `ServiceState<TData>` and `StatusBarWidget<TState>` in `src/shared/types.ts` - every provider now specializes these generics instead of redefining the same union and interface
- **GitHub Releases distribution** - the `.vsix` is now attached to each release tag at `https://github.com/WillyDrucker/WAT321/releases`, giving users a permanent manual-install URL that works when the VS Code marketplace is unavailable

### Changed
- Claude usage service slimmed from 438 to ~341 lines and Codex usage service from 476 to ~363 lines by routing timing constants, state machine helpers, discovery backoff, and HTTPS request handling through `src/shared/polling/`
- All timing knobs (`POLL_INTERVAL_MS`, `RATE_LIMIT_BACKOFF_MS`, `CACHE_FRESHNESS_OK_MS`, `CACHE_FRESHNESS_ERROR_MS`, `CLAIM_TTL_MS`, etc.) are now defined once in `src/shared/polling/constants.ts` so the two usage services cannot drift out of sync on the hot path
- `DiscoveryPoller` replaces the hand-rolled `startDiscovery` / `scheduleDiscoveryTick` / `stopDiscovery` trio in both usage services with a single class driven by the shared `DISCOVERY_BACKOFF` table
- `httpGetJson<T>()` replaces the two near-identical inline HTTPS request blocks, including the `agent: false` fresh-connection pattern and AbortController cancellation. Codex retains its Retry-After parsing via the new `onNon200` hook
- Synced `package.json` and `package-lock.json` to `1.0.10` so branch, package metadata, and changelog stay aligned for the next development cycle
- Session token services bump the directory-scan cache interval from 30s to 51s to cut background filesystem work without changing token-count update latency (the per-poll `statSync` fast path still catches transcript growth on every tick). Session-switch detection is now 0-51s instead of 0-30s - invisible in practice because sessions don't switch mid-conversation

### Fixed
- **Codex session token ceiling matches Codex's real auto-compact point** - WAT321 was displaying Codex session usage against the full reported `effective_context_window` (272k for gpt-5), but Codex's real auto-compact ceiling is ~90% of the raw model context window (244800). The widget now reads `~/.codex/models_cache.json` to resolve the true ceiling per model, falling back to `reportedWindow * (90/95)` when the cache is absent
- **Corrupt claim file no longer deadlocks the cross-instance coordinator** - a zero-byte or partial-write claim file (previously reachable from a crash between `openSync("wx")` and `writeFileSync`, or from the microsecond truncate-window race inside `writeFileSync`) caused `tryClaim()` to throw on `JSON.parse` and return `false` without entering the stale-reclaim path. Every instance would then wait forever for a TTL check that could never run. Two fixes: (a) claim writes now go through the owned file descriptor via `writeSync(fd, payload)` instead of reopening the path with `writeFileSync(path)`, eliminating the self-inflicted truncate window at its source. (b) `tryClaim()` now also falls back to `statSync().mtimeMs` as a safety net for any remaining corrupt-file case (e.g. crash between `openSync` and `writeSync`): recent mtime means a legitimate mid-write from another instance (respect it), old mtime means a crash leftover (reclaim via the same atomic `rmSync` + `openSync("wx")` pattern used for normal stale claims)
- **Auth directory deletion mid-session now recovers automatically** - if the user uninstalls the Claude or Codex CLI while VS Code is running, the service used to stay in `no-auth` forever polling a directory that no longer existed. `refresh()` now checks `existsSync(AUTH_DIR)` at the top of every cycle. If the directory is gone, the service clears its poll and countdown timers, transitions to `not-connected`, and restarts the exponential `DiscoveryPoller` so a re-install is picked up without manual reset
- **Startup delay honors per-state cache freshness** - `startPolling()` now computes the first-refresh delay from `resolveStateFreshness(cache.state)` instead of always using the long-window constant. A cached `no-auth`, `offline`, or `error` state that should expire in 30s no longer forces a 115s wait on reload before the first retry. Addresses the Codex v1.0.10 audit finding

## [1.0.9] - 2026-04-12

### Added
- Per-state cache freshness in the cross-instance coordinator - long window (115s) for `ok` and `rate-limited`, short window (30s) for auth and error states so recovery propagates quickly across windows
- Consolidated Auto-Compact section in `WDDOCS/WAT321_FUTURE_FEATURES.md` preserving the full history of the removed setting and the parked force-auto-compact investigation

### Changed
- Package description is now "Willy's AI Tools - Real-time Claude & Codex usage widgets" so the brand phrase lives in the Extensions panel subtext
- Claude session token widget reads `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `~/.claude/settings.json` directly as the single source of truth for the auto-compact ceiling
- README, CLAUDE.md, AIDOCS handoff, memory extended doc, framework README, and per-tool Codex design/support docs synced to v1.0.8+ defaults (Codex enabled by default, Auto display mode, hidden-when-not-installed, cross-instance coordinator)

### Fixed
- Cross-instance coordinator stale-claim reclaim is now atomic - stale claims are removed and the atomic `openSync("wx")` is retried, so two instances racing on the same stale claim cannot both believe they own it
- Widget startup flash for provider CLIs that are not installed - service initial state now reflects auth-dir presence synchronously, and widget constructors no longer call `item.show()`, so missing-CLI widgets never render before hiding
- Countdown ticker is stopped immediately when adopting a fresh cached non-rate-limited state (was previously self-cleaning on the next 60s tick)

### Removed
- `wat321.autoCompactThreshold` display-only override setting (introduced in v1.0.7) - the setting could visibly disagree with Claude's actual compact behavior, which undermines the widget's purpose. Willy's 700k ceiling is preserved automatically via Claude's own `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`. Full history and the parked force-auto-compact investigation are preserved in `WDDOCS/WAT321_FUTURE_FEATURES.md`

## [1.0.8] - 2026-04-12

### Added
- Cross-instance shared cache and claim-based coordination (one API call per 122s cycle across all VS Code windows)
- Auto display mode (new default) - resolves to Compact when both providers active, Full when only one
- Exponential discovery backoff - 60s to 15 min when CLI is not installed
- New Predator handshake logo showing Claude vs Codex friendly competition

### Changed
- Both providers enabled by default (`wat321.enableCodex` default: false -> true)
- Widgets hide entirely when provider CLI is not installed (no more "Not Connected" text)
- Startup adopts cached state instantly from other instances - no loading flash on new windows
- HTTPS requests now use `agent: false` for fresh connections, avoiding stale keep-alive sockets after idle
- Error absorption bumped from 2 to 3 consecutive failures before showing offline
- Startup delay now includes 0-5s random jitter to stagger simultaneous instance startups
- Extension `displayName` changed to `"WAT321"` only (was `"WAT321 Willy's AI Tools"`, got truncated in UI)

### Fixed
- Idle-offline bug from stale keep-alive socket reuse after 5+ minute idle
- Cross-instance cooldown - multiple VS Code windows no longer collide on the API
- No-auth state dedupe - no longer emits on every poll when credentials are missing

### Removed
- First-run welcome notification (no longer needed with auto-detection and default-enabled providers)
- `src/shared/welcome.ts` deleted

## [1.0.7] - 2026-04-11

### Added
- Auto-compact threshold setting (`wat321.autoCompactThreshold`) - override the session token ceiling display (0 = auto, 1-100 = custom percentage)
- Reset WAT321 checkbox in settings page with confirmation dialog
- Additional Settings and Reset WAT321 sections in README
- Customize Visible Widgets section in README

### Changed
- Session token progress bars changed from blue to yellow for visual distinction from usage widgets
- Startup offline fix - first transient API error absorbed during loading state, prevents false "Offline" flash
- README updated with Not Connected wording for API-only accounts
- Clear settings now also resets autoCompactThreshold
- Rebroadcast invalidates cached autoCompactPct so threshold changes apply immediately

## [1.0.6] - 2026-04-11

### Added
- Clear All Settings command (`WAT321: Clear All Settings`) - resets all settings and removes stored data
- State deduplication on session token services - widgets only update when visible values actually change
- Bounded staleness (60s) - cached session data preserved during transient failures, degrades to placeholder after timeout
- Path-aware file cache - handles session switches without showing stale data from previous session
- Cached hot-path values - session title, autoCompactPct, and Codex cwd read once per session instead of every poll
- Product principles documented in CLAUDE.md
- Side effect safety audit documented in framework README
- Shared regulation model documented in framework README

### Changed
- Folder `claude-session-tokens/` standardized to `WAT321_CLAUDE_SESSION_TOKENS/` (all six tool folders now match)
- `sessionService.ts` renamed to `service.ts`, `widgets/tokenWidget.ts` flattened to `widget.ts`
- Widget disposal fixed for dynamic enable/disable - provider group now owns all widgets, no ghost items on re-enable
- Tool activation functions return disposables instead of pushing to context subscriptions
- Session token services absorb mid-write parse failures silently when cached data exists
- Usage services dedupe no-auth state to prevent redundant rebroadcasts
- Clear settings confirmation changed from "Reload the window" to "All defaults restored"
- Session resolution description corrected to transcript mtime-based (not startedAt)
- README clarifies WAT321 will not affect usage limits

### Fixed
- Session token widget blip on every prompt (mid-write streaming caused blank flicker)
- Usage widget going offline on alt-tab or idle (first transient error now silently absorbed)
- File-size cache not resetting on session switch (could show stale data from different file with same size)

## [1.0.5] - 2026-04-10

### Added
- Dynamic enable/disable - toggling Claude or Codex settings takes effect immediately, no window reload needed
- Auth directory detection - widgets show "Not Connected" when CLI hasn't been used yet, activate automatically when it is
- First-run welcome notification with option to enable Codex from the toast
- Configurable status bar priority base (`wat321.statusBarPriority`) to resolve conflicts with other extensions
- ECONNRESET handling as network offline state

### Changed
- Error state on usage widgets now shows "Offline" instead of hiding the widget
- Codex no-auth state now shows "Waiting" instead of hiding
- Token-expired messages no longer reference CLI re-login
- Session token percentages clamped to 100% maximum
- Display mode descriptions clarified for session token widget differences
- Updated extension logo

### Fixed
- Missing countdown ticker cleanup on successful fetch in Claude usage service
- Redundant regex fallback in Codex error handler (dead code removed)
- Division-by-zero guard on Codex session token widget
- Em dash in GitHub feature request template
- Stale label references across framework documentation

### Removed
- Unused forceRefresh() from all four services (dead code since click commands were removed)

## [1.0.4] - 2026-04-10

### Changed
- Warning color threshold standardized at 90% across all six widgets

### Fixed
- Codex session tokens not detecting active sessions (readHead buffer too small for large session_meta)

## [1.0.3] - 2026-04-10

### Added
- ESLint integrated into build pipeline (clean -> lint -> tsc)
- Display mode and compact mode screenshots in README

### Changed
- Error messages are now passive and friendly - no login prompts or CLI commands
- Token expired shows "Refreshing" instead of "re-login needed"
- No-auth shows "Waiting" instead of directing users to log in
- Rate-limited tooltip says "Temporarily paused" instead of "Sleeping"
- Network offline shows "No Network" with auto-reconnect message
- README redesigned with marketplace-first install and scaled images
- Compact session tokens show text-only (no bars)

### Fixed
- Removed stale arrow characters from framework docs

## [1.0.2] - 2026-04-10

### Added
- Display mode setting: Full, Compact, Minimal (changes apply instantly)
- Rate-limit cooldown stamps persist across reloads (`~/.wat321/`)
- GitHub issue templates for bug reports and feature requests

### Changed
- Settings gate controls tool activation (Enable Claude / Enable Codex)
- Smart startup delay respects remaining cooldown from previous session
- Compact mode shows 5-block bars, minimal mode is text-only with bars in tooltips
- Shared utilities reorganized (`shared/ui/`, `shared/fs/`, `shared/displayMode.ts`)
- README redesigned with marketplace install instructions

### Fixed
- Codex tooltip bar width now matches "remaining" text
- Future timestamp guard on cooldown stamp reads
- Session token widgets register in status bar menu when no session active

## [1.0.1] - 2026-04-10

### Added
- **Codex Session Tokens** - context window usage monitor for Codex CLI sessions, reads local rollout transcripts
- README.md with screenshots, marketplace listing content, and supported plans table
- New extension logo

### Changed
- Status bar labels differentiated: "Claude (5hr)" / "Claude weekly" / "Codex (5 hour)" / "Codex weekly"
- Claude tooltip title changed to "Claude usage limits" with "(5hr)" on session label
- Codex tooltip: "5 hour usage limit" / "Weekly usage limit", percentages show "remaining", reset times use absolute dates
- Codex usage bars fill left-to-right (green=remaining depletes from right), percentage counts down
- Session token tooltips: "Claude session token context" / "Codex session token context", bars show "used"
- Error states hide widgets silently instead of showing persistent error messages
- Codex no-auth hides widgets silently (Claude no-auth still shows login hint)
- Rate-limited state shows "Offline" with countdown in tooltip
- 5-second startup delay on API services to prevent hammering on rapid reloads
- Session scanner uses transcript mtime (not startedAt) to handle /resume correctly
- Session directory scan cached at 30-second intervals

### Fixed
- Codex session ID extraction from rollout filenames (was off by one segment)
- Removed all screenshot mock data and debug logging from production code

## [1.0.0] - 2026-04-09

### Added
- **Claude Usage (5h)** - real-time 5-hour session utilization bar in the status bar
- **Claude Usage (Weekly)** - real-time 7-day utilization bar in the status bar
- **Codex Usage (5h)** - real-time 5-hour remaining-capacity bar (green=remaining, black=used)
- **Codex Usage (Weekly)** - real-time weekly remaining-capacity bar with absolute reset dates
- **Claude Session Tokens** - context window usage monitor showing tokens used vs auto-compact ceiling
- Shared HTML tooltips with colored progress bars and threshold-based coloring
- Hourglass reset countdowns in Claude and Codex usage tooltips
- Rate-limit protection with automatic 15-minute backoff and countdown display
- Auto-compact ceiling detection from `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` setting
- Session title extraction from Claude Code conversation transcripts (head-read first 8KB)
- 1M context window detection for Opus 4.6 and Sonnet 4.6 models
- Optimized JSONL tail-read (last 64KB) for usage parsing

### Architecture
- Modular tool-per-folder structure under `src/`
- Shared service pattern - one API polling path per provider to prevent rate-limit collisions
- Read-only data access - no user files are modified
- All five tools active for testing
