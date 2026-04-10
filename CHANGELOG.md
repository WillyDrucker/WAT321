# Changelog

All notable changes to WAT321 Willy's AI Tools will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
