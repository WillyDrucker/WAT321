# WAT321 — Will's AI Tools

Real-time AI usage widgets for your VS Code status bar. Monitor Claude session limits, weekly limits, and context window pressure at a glance.

## Features

### Claude Usage (5h)
Shows your current 5-hour session utilization with a progress bar and percentage. Displays loading, auth, offline, and rate-limit states.

### Claude Usage (Weekly)
Shows your 7-day usage limit with a progress bar and percentage. Hides automatically when usage data isn't available.

### Claude Session Tokens
Monitors your active Claude Code session's context window usage relative to the auto-compact ceiling. Reads directly from Claude Code's local transcript files — completely read-only, no configuration required.

**Status bar:** `🗜️ WAT321 178k / 700k 25%`

## How It Works

- **Claude Usage** polls the Anthropic OAuth usage API on a safe interval (every ~2 minutes) with built-in rate-limit protection and automatic 15-minute backoff
- **Session Tokens** reads Claude Code's local JSONL transcripts to calculate context pressure — no API calls, no network access
- All data sources are **read-only** — WAT321 never modifies any user files
- One shared API polling path prevents duplicate calls even with multiple widgets active

## Requirements

- VS Code 1.85.0 or later
- An active Claude account with CLI credentials (`~/.claude/.credentials.json`)
- Claude Code running in VS Code (for session token monitoring)

## Installation

Install from a `.vsix` file:
1. Download `wat321-x.x.x.vsix`
2. Open VS Code → `Ctrl+Shift+P` → **Extensions: Install from VSIX**
3. Select the file and reload

Widgets appear in the status bar automatically. Toggle visibility by right-clicking the status bar.

## Supported Plans

| Provider | Plan | Status |
|----------|------|--------|
| Claude | Max (5x / 10x / 20x) | Supported — plan tier detected automatically |
| Claude | Pro | Supported — usage data works, plan label not shown |
| Claude | Free | Supported — usage data works, plan label not shown |
| Claude | Team / Enterprise | Unknown — untested with the usage API |
| Codex | Plus / Pro / Team | Supported |

API-only Anthropic accounts without CLI OAuth credentials will see a "no auth" state, which is expected.

## License

[MIT](LICENSE)
