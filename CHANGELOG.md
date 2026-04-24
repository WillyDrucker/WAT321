# Changelog

All notable changes to WAT321 Willy's AI Tools will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-04-24

### Added

- **Claude session tokens flash a 🔴MISS🔴 banner when the prefix cache genuinely goes cold.** When a turn lands with near-zero cached input AND substantial cache creation (the signature of TTL expiry, context invalidation, or auto-compact), the widget alternates its token readout with a red MISS banner for two seconds (miss 500ms, tokens 500ms, miss 1000ms). Normal per-turn cache writes no longer trip the detector. The provider codicon stays in place throughout the flash - only the tokens/percent portion swaps.
- **Session token widgets drop the redundant "Claude" / "Codex" label.** The brand codicon already tells you which provider you're looking at, so the widget now reads as `$(claude) 267k / 730k 37%` instead of `$(claude) Claude 267k / 730k 37%`. Shorter line, same signal.
- **Heuristic disconnect glyph on session token widgets when a turn is silently hung.** If the thinking indicator has been active for more than 30 seconds with no transcript activity, the prefix swaps to `$(debug-disconnect)` so you can tell the session is probably waiting on the network, not just reasoning. Uses the same mtime signal the active indicator already reads, so no API probe and no platform-specific code. Closes #51.
- **The Auto-Compact tooltip line now reads the real fire point.** Claude Code's percentage override stacks with an internal reserve in recent releases, so setting `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=73` on a 1M window actually triggers compaction around 715k, not the nominal 730k. The widget's "Auto-Compact at ~X" line now shows the effective trigger with a `~` prefix so the advertised number matches what you'll actually hit. The bar and the "N/M" numerator still use your configured target so the percentage stays self-consistent. Closes #55.
- **Auto-Compact math now reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.** If you've set the absolute window override or declared the context window via env var, the widget picks those up instead of guessing from the model slug.

### Changed

- **Upgrade your Codex CLI before running the bridge in this release.** A lot of the model-repair work here depends on your local Codex models cache being current. If you're on a Codex CLI older than 0.124, newer slugs like `gpt-5.5` will read as "unknown" and Epic Handshake will fail every turn at pre-flight validation. Run `npm install -g @openai/codex@latest` once; the CLI auto-refreshes `~/.codex/models_cache.json` on its next invocation and everything else takes care of itself.
- **Delete All Codex Sessions is scoped to the current project even when another workspace shares the basename.** Previously "Delete All" walked Codex's session index by thread-name match alone, so a sibling workspace also named `foo` in a different parent path could have its sessions swept by mistake. Each candidate session's rollout header is now read and required to match the current workspace's path before it gets included in the delete set.
- **Epic Handshake bridge status bar shows the wait-mode lightning flash reliably.** The 2500ms bolt flash when you toggle wait mode was rendering as a static icon (the 500ms frame interval aligned with the 1000ms tier refresh so every sample landed on the same parity) and could be hidden by pending mail or prior failure states. Now held solid for the window and promoted above mail / failure rendering so a user-initiated toggle is always visible.
- **Retrieve late replies uses stock `$(mail)` / `$(mail-read)` codicons.** Both the menu row and the status bar pending-mail animation switch from the custom `wat321-square-mail` glyph to the built-in codicons, which render consistently across every VS Code fork without requiring our font.
- **Pause and Resume menu rows now have longer detail text.** Hovering or selecting either one explains what pausing actually does (blocks new prompts, in-flight turns complete, reply buffering is Claude's job), matching the detail treatment Cancel already had.
- **Usage widget error state uses `$(sync-ignored)` instead of `$(cloud-offline)`.** The two states (network offline vs API temporarily unavailable) used to share a glyph; the distinct icon makes it easier to tell at a glance whether the issue is your connection or the provider.
- **Codex session tooltip shows the raw model slug instead of a prettified name.** `gpt-5.1-codex` now reads as `gpt-5.1-codex` instead of `GPT-5.1 Codex`, matching what Codex CLI shows everywhere else. An invalid model ID stored in a session (like `gpt-5.5`, which is not a real Codex model) is immediately visible in the tooltip now; previously the prettify made it read as plausible until the next prompt fired and the API returned 404.
- **Epic Handshake catches sessions that store an unknown Codex model slug and offers to repair them.** When Codex CLI upgrades and renames or retires a model, old bridge sessions that stored the old slug in their rollout would 404 on the next resume with a cryptic API error. The bridge now validates the stored slug against your local Codex models cache before every resume; if the slug is unknown, the turn fails early with a clear message pointing at the new "Repair sessions" action under Manage Codex Sessions. Repair rewrites the stored slug to your current Codex default in place, only touching bridge-owned rollouts for the current workspace. A Force Repair fallback handles the case where the cache-based scan returns zero because your cache is stale, and the Codex session token tooltip flags the invalid slug with a ⚠ badge so you see it before the next prompt even fires.
- **Bridge sessions that were broken by a Codex CLI upgrade silently unstick themselves once the CLI catches up.** If you'd been running a Codex CLI that didn't know about `gpt-5.5` and upgraded to a version that does, the old bridge thread was sitting at a non-zero failure count waiting to be manually repaired. The bridge now checks before each turn: if the stored slug is now recognized by your current Codex cache, the failure count is cleared and the next prompt just resumes normally. No click required.

### Fixed

- **The Claude thinking indicator no longer stays on after an auto-compact runs.** Auto-compact writes a terminal summary entry that structurally looks like a fresh user prompt, so the transcript classifier was returning "user waiting for response" and the widget kept animating forever. The classifier now recognizes the compact summary markers (`This session is being continued from a previous conversation`, `conversation was compacted`, `<command-name>compact</command-name>`) and treats them as turn-complete, so the widget returns to idle as soon as the compact finishes.
- **"Delete All Codex Sessions" no longer reports zero when your workspace actually has bridge sessions to delete.** The scoped-by-cwd check was reading the first 8KB of each Codex rollout and trying to parse it as JSON to compare the session's workspace against yours. Recent Codex CLI releases write 15-25KB of environment context into that first line, so the parse was failing silently and every session was being rejected from the delete set. A new chunk-based reader now pulls the first line in full regardless of size, so the scope check sees the real cwd and the delete count matches reality. The same fix feeds the Recover and Repair flows.
- **Delete All's zero-count message surfaces as a toast with a "View details" button instead of a modal dialog.** When Delete All finds nothing to delete, the toast links directly to the Epic Handshake output channel, where a full breakdown of every scanned session (its thread name, cwd, and why it was included or excluded) is already logged. The Repair picker uses the same pattern when its zero-count path fires.

### Removed

## [1.2.1] - 2026-04-21

### Added

- **Epic Handshake knows which of the five turn stages Codex is in and shows it right on the status bar.** A new stage walker on the widget steps through dispatched, received, working, writing, and complete using five numbered-square glyphs, so you can watch a turn progress at a glance instead of seeing one generic animation until the reply lands. Every stage holds for at least 3 seconds so fast turns still walk the full sequence.
- **Pick your default wait mode for the bridge.** A new `wat321.epicHandshake.defaultWaitMode` setting lets you choose what mode Claude's side restores to after a VS Code restart: Standard (fixed 2 minute block per prompt), Adaptive (keeps waiting while Codex is demonstrably working, 5 minute hard cap), or Fire-and-Forget (Claude's tool returns immediately and the reply lands in the inbox when ready). The menu still cycles through the three modes live; this just picks the baseline.
- **Delete all Codex sessions for this workspace in one go.** A new command palette entry (`WAT321: Epic Handshake - Delete All Codex Sessions`) wipes every bridge-owned Codex session for the current workspace at once, so you can reset a workspace's Codex history without clicking through each session.

### Changed

- **Session token tooltips now show what the active turn is actually doing.** During an in-flight turn you see the current tool name, how many tools have been called so far, the reasoning/output token split, and a thinking hint while Codex or Claude is mid-thought. Previously the tooltip just showed the total token count; now it tells you what's eating those tokens.
- **Usage widgets in non-OK states lead with the provider icon.** Idle, offline, rate-limited, and token-refresh states now read as `$(claude) Usage - $(key) - Idle` instead of `$(key) - $(claude) Usage - Idle`. The provider brand sits up front so you can tell at a glance which widget is the problem and the status glyph lines up where the cycle counter would be in the OK state.
- **Epic Handshake source is now organized into focused modules.** The dispatcher, status bar, menus, and thread persistence monoliths each split into narrower units that match their real concerns (mailbox, threadLifecycle, turnRunner, turnMonitor, turnHeartbeat, menuPickers, statusBarState, and more). No behavior change - the split just makes each file readable end-to-end and keeps the engine/tool boundary clean.

### Fixed

- **System notifications on macOS and Linux no longer report success when the OS path actually failed.** If `osascript` or `notify-send` is missing, the notification layer used to return `true` optimistically because the spawn error arrives asynchronously. Diagnostics now remember the failure and report the honest outcome on the next call, so health output doesn't tell you notifications are working when they aren't.

### Removed

## [1.2.0] - 2026-04-20

### Added

- **Epic Handshake lets Claude ask Codex a question and get a real answer back.** A new status bar widget sits alongside the usage and session token tiles and shows whether the bridge is ready, working, or paused. When Claude calls the bridge from a prompt, WAT321 hands the question to a local Codex app-server in read-only sandbox mode and streams Codex's reply straight back into Claude's turn. Threads persist per workspace so follow-up questions keep their context, and the widget surfaces failures passively the same way the usage widgets do. The bridge is opt-in and only activates when you actually install the MCP entry; everything it writes lives inside `~/.wat321/`.
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

- **Session token widgets show when Claude and Codex are thinking.** A gentle animated indicator appears on each session token widget while a prompt is being processed, so you can tell at a glance whether your CLI is still working. The indicator lights up promptly on send and clears instantly on response or interrupt; detection combines a transcript tail classifier with process liveness for Claude and a short mtime backstop for both.
- **Claude and OpenAI brand icons on every widget.** The status bar widgets now lead with the official brand glyph instead of the provider name text or the older thinking-bubble / pipe prefixes. The line reads shorter and tells you which provider you're looking at without having to read.
- **`WAT321: Show Provider Health` is now in the Command Palette.** Previously you had to invoke it via `code --command` from a terminal. It now shows up alongside `WAT321: Reset WAT321` where you'd expect to find it.

### Changed

- **Windows toast notifications now handle em dashes, smart quotes, emoji, and curly-quote title wrappers correctly.** The warm PowerShell process that delivers toasts forces UTF-8 input and output so non-ASCII content no longer gets mangled into `?` characters on its way to Windows.
- **Windows toast notifications now work on VS Code forks.** Insiders, VSCodium, Cursor, Windsurf, and anything else that registers a unique AppUserModelID at install. Discovery runs inside the warm PowerShell process keyed on the host's app name, with a fallback to the generic `powershell` AUMID so delivery never silently drops on an unfamiliar host.
- **macOS and Linux System Notifications are actually the OS toast now.** If you pick "System Notifications" mode on macOS you get a real macOS notification via `osascript`; on Linux you get `notify-send`. Previously both platforms quietly fell back to in-app banners.
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

- **The Claude and Codex usage widgets now resume on their own when the provider recovers.** Previously, if Anthropic or OpenAI went down and returned a long `Retry-After` header, your widget would sit "Offline" for up to 45 minutes and there was nothing you could do about it. Now each usage service watches your active session's transcript file; if you are actively using Claude or Codex when the API comes back up, the widget wakes itself within about two minutes. No clicks, no reload, no waiting out the full park. The new constants live in `src/shared/polling/constants.ts`.
- **Parked widget tooltips now explain why.** When your usage widget is parked in "Offline", the tooltip now surfaces the server's 429 reason (like "HTTP 429 Too Many Requests (possible API outage)") and, if there is a live incident on the provider's public status page, a line reading "Anthropic status: Partial System Outage" or similar. Lazy and cached - the status page is only read from the tooltip render path and at most once per five minutes. Silent on any fetch failure.
- **Reset WAT321 now also clears accumulated rate-limit backoff state.** If you ever find yourself escalated to the longer retry cadence during a bad outage and want to try a fresh attempt without waiting it out, the Reset command will zero the counter. Gating still applies - the reset does not force an immediate fetch, it just gives the next gate check a clean slate.

### Changed

- **Usage widgets cap any server `Retry-After` at fifteen minutes.** Nothing against the provider's own guidance, but when their edge returns a value in the 40+ minute range during a recovery, honoring it literally strands the widget long after the API is actually back up. The cap gives us the same "back off, do not hammer" behavior without leaving you stranded. Lives alongside the other polling constants.
- **Sustained outages now escalate retry spacing progressively.** On a fresh park, the widget is responsive - it tries to wake within about two minutes of activity. If that attempt fails, the next one waits five minutes. Then ten. Then fifteen, at which point it effectively stops trying to wake and lets the normal park timer handle retries. A single successful fetch resets the ladder so short outages still get the full responsive behavior. Driven by `KICKSTART_ESCALATION_MS`.
- **Codex session token polling is now staggered one second off Claude.** Both providers used to poll local transcripts on the same tick. Now Codex is on a 6-second cadence and Claude stays at 5, so two active providers never `stat` the same tick. No user-visible effect, just slightly kinder to the filesystem.
- **Codebase split into focused modules, no behavior change.** The experimental Force Auto-Compact service had its armed status bar item peeled off into its own file, and the Reset WAT321 flow had its workspace `.vscode/settings.json` heal split into an `applicationScopeHeal` module. Both are internal splits for readability; the product surface is unchanged.

### Removed

- **Click-to-wake affordance on parked usage widgets.** The earlier "click to resume polling" path on the rate-limited widget was only meaningful when WAT321 was guessing at a wait time. Now that recovery is fully automatic via the activity kickstart, no widget state is clickable. The surface area is smaller and the UX is consistent with the rest of WAT321's passive-recovery posture.

## [1.0.19] - 2026-04-15

### Added

- **Heatmap colors on the usage progress bars.** Bars now gradually shift through warning colors as you get closer to your limits, so a tight session stands out at a glance instead of looking the same as a fresh one. On by default; turn it off in settings if you prefer plain bars. The new toggle is `wat321.enableHeatmap`.
- **Known Issues section in the README.** A short, friendly list of rough edges that are worth knowing about - things like a stale Max plan tier label after an upgrade or what to do when you see "Offline" with a countdown. None of them need any action on your part; they either self-heal or are waiting on upstream fixes.

### Changed

- **Codex session tokens now match Codex's own native hover byte-for-byte.** The widget previously read a different denominator than Codex's built-in display (245k vs 258k) and counted slightly fewer tokens per turn than Codex did. After research into the upstream Codex source, your widget now uses the same effective context window, the same `total_tokens` field, and the same baseline-normalized percentage formula Codex uses internally. If you cross-check the two displays they will agree.
- **Claude session tokens count the full per-turn footprint.** Previously the widget summed input plus cached input but skipped the output tokens for each turn. The displayed value is corrected; the visual change is below the rounding threshold so most reads look identical, but the underlying number is now accurate.
- **Auto-Compact wording in the session token tooltips matches what each provider actually does.** Claude shows `Auto-Compact at {ceiling}` because Claude's compact fires exactly at that point. Codex shows `Auto-Compact ~{value}` because Codex's effective context window is the displayed ceiling but the actual compact fires a bit earlier.
- **Reset WAT321 now also restores Enable Heatmap to its default.** The new heatmap toggle was missing from the reset list, so toggling it off and running Reset would not flip it back on. Fixed in `src/shared/clearSettings.ts`.
- **Command palette entry renamed from "WAT321: Reset All Settings" to "WAT321: Reset WAT321"** so it matches the settings checkbox label and the rest of the docs. The internal command id is unchanged.
- **Settings descriptions tightened across the board.** Shorter sentences, less boilerplate, and the Minimal display mode description is corrected to say progress bars *move* to tooltips on hover instead of *remain* in tooltips.
- **Cross-project fallback label for the Claude session token widget is now correct.** When you have no Claude transcript in the current workspace and WAT321 falls back to your globally most-recent session, the widget now shows that other project's name instead of the current workspace name. The earlier limit could miss the `cwd` field on transcripts that started with many control events; `parseCwd` in `src/WAT321_CLAUDE_SESSION_TOKENS/parsers.ts` now scans further into the file.
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
- **Codebase reorganized into focused shared helpers**, no behavior change. The four usage widgets now share one generic activator and one shared non-OK state renderer, the Force Auto-Compact tool's timing and threshold values all live in one centralized `constants.ts`, and a handful of single-caller helpers were inlined into their callers. Per-tool framework documentation was removed entirely because every doc had drifted into a worse copy of the code; the source tree is now authoritative

### Fixed
- **Claude Force Auto-Compact no longer double-reports the loop warning** if the post-disarm watcher sees more than one stray compact in the same 30-second window. The first stray still triggers the "close and reopen your Claude terminal" toast; subsequent ones in the same window are silent
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
- **Reset WAT321 now always unsticks you from a stuck override**, even if the backup file is missing or corrupt. Before, the reset flow would only restore if it could find the sentinel file; a missing sentinel meant the reset walked away and left your Claude settings stuck at override=1. Now the reset inspects `~/.claude/settings.json` directly and, if the override is still stuck at the armed value, restores it to the Claude default (85) no matter what state the backup is in. A new shared helper in `src/shared/claudeSettings.ts` is the single source of truth for reading and writing that setting, so every recovery path goes through the same code
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
- **Corrupt claim file no longer deadlocks the cross-instance coordinator** - a zero-byte or partial-write claim file (previously reachable from a crash between `openSync("wx")` and `writeFileSync`, or from the microsecond truncate-window race inside `writeFileSync`) caused `tryClaim()` to throw on `JSON.parse` and return `false` without entering the stale-reclaim path. Every instance would then wait forever for a TTL check that could never run. Two fixes: (a) claim writes now go through the owned file descriptor via `writeSync(fd, payload)` instead of reopening the path with `writeFileSync(path)`, eliminating the self-inflicted truncate window at its source; (b) `tryClaim()` now also falls back to `statSync().mtimeMs` as a safety net for any remaining corrupt-file case (e.g. crash between `openSync` and `writeSync`): recent mtime means a legitimate mid-write from another instance (respect it), old mtime means a crash leftover (reclaim via the same atomic `rmSync` + `openSync("wx")` pattern used for normal stale claims)
- **Auth directory deletion mid-session now recovers automatically** - if the user uninstalls the Claude or Codex CLI while VS Code is running, the service used to stay in `no-auth` forever polling a directory that no longer existed. `refresh()` now checks `existsSync(AUTH_DIR)` at the top of every cycle; if the directory is gone, the service clears its poll and countdown timers, transitions to `not-connected`, and restarts the exponential `DiscoveryPoller` so a re-install is picked up without manual reset
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
