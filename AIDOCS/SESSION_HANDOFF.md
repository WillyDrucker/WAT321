# Session Handoff — WAT321 (Will's AI Tools 321)

## What This Project Is
A VS Code extension that displays real-time Claude (and eventually Codex) usage metrics in the status bar. Originally called `claude-usage-bar`, being renamed to **WAT321** (Will's AI Tools 321).

The vision is a **suite of toggleable status bar widgets** for Claude and Codex users — not all load by default, users can check/uncheck them in the status bar extension area (double arrow section). The extension should be easily updatable to add more widgets over time or fix bugs.

## Current State
- **Version:** 1.0.0
- **Publisher:** WillyDrucker (registered on VS Code Marketplace, account created 2026-04-09)
- **NOT yet published** — marketplace publisher account exists, no PAT created yet
- **Azure DevOps issue** — user's Azure trial expired, blocked creating PAT. Alternative: direct .vsix upload via marketplace manage page.
- **Compiles cleanly** as of last session
- **package.json publisher** changed from "glp321" to "WillyDrucker"

## Full Conversation History

### Phase 1: Marketplace Publishing Prep
1. User asked what's involved in publishing to VS Code Marketplace
2. Walked through: publisher account, PAT, metadata, vsce publish
3. User created publisher account on marketplace:
   - Name: Willy Drucker
   - ID: WillyDrucker (originally was going to be glp321, changed to WillyDrucker)
   - Updated package.json publisher field to match
4. User hit Azure DevOps subscription block — trial expired, can't create org for PAT
5. Recommended alternative: direct .vsix drag-and-drop upload at marketplace.visualstudio.com/manage

### Phase 2: Code Audit
User wanted to ensure tool is production-ready before publishing. Did comprehensive audit finding:

**High severity:**
- `makeBar` crash on >100% utilization (RangeError from negative .repeat())
- No request timeout (hung connections = loading spinner forever, unrecoverable)
- Expired/revoked token loops forever with generic error, no guidance

**Medium severity:**
- No API response validation (silent 0% on API changes)
- String-based 429 detection (false positives possible)
- Status bar items accessed after deactivation
- No request deduplication

**Low severity:**
- No reduced polling when no credentials exist
- lastFetchTime set before fetch (penalizes failed fetches)
- hasData flag is dead code

### Phase 3: Architecture Restructure
Restructured from single 267-line file to modular widget-based architecture:

```
src/
  extension.ts              — thin entry point (40 lines), creates service + widgets
  types.ts                  — ServiceState union (7 states), StatusBarWidget interface, UsageResponse
  usageService.ts           — API client with all fixes:
                               - 10s request timeout with AbortController
                               - Request deduplication (inFlight flag)
                               - Response validation (validateResponse)
                               - Typed error handling (401/403 → token-expired, 429 → rate-limited, network → offline)
                               - Cooldown set AFTER fetch in finally block
                               - Disposed check prevents writes to dead items
  formatters.ts             — Pure functions: makeBar (clamped 0-100), formatSessionReset, formatWeeklyReset, getMaxLabel
  widgets/
    sessionWidget.ts        — Session (5-hour) status bar widget, handles all error state display
    weeklyWidget.ts         — Weekly (7-day) status bar widget, hides on error states
    tooltipBuilder.ts       — Shared HTML tooltip with colored progress bars
```

**Extensibility pattern:** New widgets implement `StatusBarWidget` interface with `update(state)` and `dispose()`. Add to widgets array in extension.ts — automatically receives state updates from UsageService.

### Phase 4: Naming Discussion
User wanted a name for the broader project (not just Claude usage). Key requirements:
- Covers Claude AND Codex tools
- Status bar widgets that are toggleable
- Fits the user's "321" brand (GLP321, Lift321, Will's 321)
- Should jump out, be memorable

**Names considered:**
- AI Vitals, AI HUD, AI Gauges, AI Fuel, AI Ticker (all good but missing personal brand)
- VitAI321 (vital + AI), RadAI321, DatAI321 (AI hidden in words)
- WIT321 (Will's Intelligence Tools), WAT321 (Will's AI Tools), WAIT321, WAD321
- Final choice: **WAT321** — short, punchy, the "wat?" energy is a hook not a problem

### Phase 5: Pre-Rename (current)
- Created AIDOCS/SESSION_HANDOFF.md
- Need to: rename all internal references, rename folder, create GitHub repo
- User's convention: AIDOCS/ (AI-managed), WDDOCS/ (collaborative)

## Architecture Details

### ServiceState (typed union in types.ts)
```typescript
| "loading"                              — initial state before first fetch
| "no-auth"                              — no ~/.claude/.credentials.json or no token in it
| "token-expired" { message }            — API returned 401/403
| "rate-limited" { retryAfterMs }        — API returned 429, backed off to 15min polling
| "offline" { message }                  — ENOTFOUND, ETIMEDOUT, etc.
| "error" { message }                    — any other error
| "ok" { data, fetchedAt }               — success, contains UsageResponse
```

### Polling Behavior
- Normal: 122s interval, 61s cooldown between calls
- Rate limited: backs off to 901s (15min), restores on next success
- Manual refresh: `forceRefresh()` bypasses interval but respects cooldown
- Timeout: 10s per request, aborts via AbortController

### Widget Behavior
- SessionWidget: shows all states (loading spinner, error messages, usage bar)
- WeeklyWidget: shows only on "ok" state, hides for all errors (session widget handles those)
- Both share the same tooltip (tooltipBuilder)
- Tooltip has colored HTML progress bars (blue < 50%, yellow 50-80%, red > 80%)

### API Details
- Endpoint: https://api.anthropic.com/api/oauth/usage
- Auth: Bearer token from ~/.claude/.credentials.json → claudeAiOauth.accessToken
- Header: anthropic-beta: oauth-2025-04-20
- Response: { five_hour: {utilization, resets_at}, seven_day: {utilization, resets_at}, extra_usage: {...} }

## What's Next (in order)
1. **Rename everything** to WAT321 — folder, package.json name/displayName/commands, all internal IDs
2. **Create GitHub repo** — needed for marketplace repository field
3. **Create README.md** — this becomes the marketplace listing page
4. **Add LICENSE** — MIT
5. **Upload to marketplace** — direct .vsix upload (bypasses PAT requirement)
6. **Future widgets:** tokens per session, compact limit display, current effort level, Codex metrics

## User Preferences & Conventions
- **321 brand** — all projects end in 321
- **Folder structure:** AIDOCS/ (AI-managed), WDDOCS/ (collaborative)
- **Publisher:** WillyDrucker on VS Code Marketplace
- **Email:** willy.drucker@gmail.com
- **Prefers:** punchy creative names, thorough code review before shipping, extensible architecture
- **Tech:** TypeScript, VS Code extensions, no bundler (tsc only), no external deps

## Files Changed This Session
- `src/extension.ts` — completely rewritten (was 267 lines, now ~40 line entry point)
- `src/types.ts` — NEW: shared types
- `src/usageService.ts` — NEW: API client with all bug fixes
- `src/formatters.ts` — NEW: extracted formatting functions
- `src/widgets/sessionWidget.ts` — NEW: session status bar widget
- `src/widgets/weeklyWidget.ts` — NEW: weekly status bar widget
- `src/widgets/tooltipBuilder.ts` — NEW: shared tooltip builder
- `package.json` — changed publisher from "glp321" to "WillyDrucker"
- `AIDOCS/SESSION_HANDOFF.md` — NEW: this file
