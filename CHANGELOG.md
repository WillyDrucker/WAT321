# Changelog

All notable changes to WAT321 Willy's AI Tools will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.11] - unreleased

### Added

### Changed

### Fixed

### Removed

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
