# WAT321 - Willy's AI Tools

### *Does manually refreshing AI usage limits give you anxiety?*

<img src="images/screenshots/AI_USAGE_LIMITS.png" width="340">

## Now you can live in fear in real-time!

![Hero](images/screenshots/HERO_SHOT.png)

Real-time AI usage widgets for your VS Code status bar.

WAT321 ships with **six status bar widgets** for Claude and Codex. Claude tools are enabled by default. Codex tools are included but disabled - enable them in Settings.

---

## What's Included

### Claude Usage

Live progress bars showing your 5-hour session utilization and weekly limits. Simple hover for information breakdown.

<img src="images/screenshots/CLAUDE_USAGE_TOOLTIP_HOVER.png" width="250">

![Claude usage bars](images/screenshots/CLAUDE_USAGE.png)

### Claude Session Tokens

Tracks your active Claude Code session's context window usage against the auto-compact ceiling. See how much room you have before compaction kicks in.

![Claude session tokens](images/screenshots/CLAUDE_SESSION_TOKENS.png)

### Codex Usage

Same concept, **green** bars for Codex. Shows **remaining** capacity - the bars deplete as you use more.

<img src="images/screenshots/CODEX_USAGE_TOOLTIP_HOVER.png" width="250">

![Codex usage bars](images/screenshots/CODEX_USAGE.png)

### Codex Session Tokens

Monitors your Codex session's context window fill level. Same layout as Claude session tokens.

![Codex session tokens](images/screenshots/CODEX_SESSION_TOKENS.png)

---

## Display Modes

WAT321 supports three display densities. Search **"wat321"** in **Settings** to change.

- **Full** - 10-block progress bars with all details (default)
- **Compact** - 5-block progress bars, session tokens show text only
- **Minimal** - text-only, usage bars move to tooltips on hover

<img src="images/screenshots/DISPLAY_MODE_SETTINGS.png" width="300">

![Compact Mode](images/screenshots/COMPACT_MODE.png)

---

## Installation

### From the Marketplace
1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search **"WAT321"**
4. Click **Install**

### From a .vsix file
1. `Ctrl+Shift+P` / `Cmd+Shift+P` then **Extensions: Install from VSIX**
2. Select the `.vsix` file
3. Reload window

---

## Enabling Codex Widgets

All six tools install together, but Codex is **disabled by default**. To enable:

1. **File > Preferences > Settings** (`Ctrl+,` / `Cmd+,`) and search for **"wat321"**
2. Check **Enable Codex** - widgets appear immediately, no reload needed

<img src="images/screenshots/CODEX_WAT321_SETTINGS.png" width="350">

Once enabled, you can toggle individual Codex widgets on or off using the **status bar overflow button** (`>>` at the bottom-left):

![Status bar button](images/screenshots/STATUS_BAR_BUTTON.png)

<img src="images/screenshots/STATUS_BAR_TOGGLE_MENU.png" width="300">

---

## How It Works

- **Claude Usage** and **Codex Usage** poll their respective APIs on a safe interval (~2 minutes) with built-in rate-limit protection
- **Session Tokens** (both providers) read local transcript files - no API calls, no network access
- All data sources are **read-only** - WAT321 never modifies Claude, Codex, or user config files. The only files written are internal timestamps under `~/.wat321/`
- One shared API polling path per provider prevents duplicate calls even with multiple widgets active
- Settings changes (enable/disable, display mode) take effect immediately - no window reload needed
- If Claude or Codex CLI hasn't been used yet, widgets show "Not Connected" and activate automatically when you start using the CLI

## What It Doesn't Do

- **Will not affect your usage limits.** Usage widgets poll a read-only stats endpoint on a safe interval. Session token widgets only read local files - no API calls, no network access. Nothing WAT321 does counts toward your Claude or Codex usage.
- WAT321 does not store, transmit, or modify your credentials. It only writes cooldown timestamps to `~/.wat321/`
- WAT321 does not interfere with Claude Code, Codex CLI, or any other extension

## Requirements

- VS Code 1.85.0 or later
- Claude widgets need an active Claude account with CLI credentials (`~/.claude/.credentials.json`)
- Codex widgets need Codex CLI credentials (`~/.codex/auth.json`)
- Session token widgets need an active session in the respective CLI tool

## Supported Plans

| Provider | Plan | Status |
|----------|------|--------|
| Claude | Max (5x / 10x / 20x) | Supported - plan tier detected automatically |
| Claude | Pro | Supported - usage data works, plan label not shown |
| Claude | Free | Supported - usage data works, plan label not shown |
| Claude | Team / Enterprise | Unknown - untested with the usage API |
| Codex | Plus / Pro / Team | Supported |

API-only Anthropic accounts without CLI OAuth credentials will see the Claude widgets hidden, which is expected.

## Rate Limits

Both Claude and Codex usage APIs have rate limits. WAT321 polls conservatively to stay well within safe thresholds. However, **repeatedly reinstalling or reloading the extension in quick succession can trigger a temporary rate-limit lockout**.

If a lockout occurs, the status bar will show "Offline" and the tooltip will display a countdown timer. The extension will automatically reconnect when the lockout expires - no action needed.

## Issues & Feedback

Found a bug or have a feature request? [Open an issue on GitHub](https://github.com/WillyDrucker/WAT321/issues).

## License

[MIT](LICENSE)
