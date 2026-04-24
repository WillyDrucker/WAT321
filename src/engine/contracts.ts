import type * as vscode from "vscode";

/**
 * Core contracts for the WAT321 engine. Every interface here is a
 * seam between the engine (lifecycle, wiring, metadata) and the
 * tools (domain logic, rendering, provider-specific behavior).
 *
 * Tools depend on these interfaces. The engine provides implementations.
 * No tool ever imports another tool.
 */

/** Unique key identifying a provider. Used as the map key in the
 * registry and as the setting suffix in `wat321.enable{Key}`. */
export type ProviderKey = "claude" | "codex";

/** Known context window sizes mapped by model slug pattern.
 * Used by session token services to resolve the display
 * denominator from the model ID in the transcript/rollout. */
interface ModelContextWindow {
  match: (modelId: string) => boolean;
  contextWindowSize: number;
  displayName: (modelId: string) => string;
}

/** Registry of known model context windows. Checked in order;
 * first match wins. A third provider adds entries here. */
export const MODEL_CONTEXT_WINDOWS: readonly ModelContextWindow[] = [
  {
    match: (id) => id.includes("claude-opus-4") || id.includes("claude-sonnet-4"),
    contextWindowSize: 1_000_000,
    displayName: (id) => {
      const parts = id.replace(/^claude-/, "").split("-");
      if (parts.length >= 3) {
        const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        return `${family} ${parts[1]}.${parts.slice(2).join(".")}`;
      }
      return id;
    },
  },
  {
    match: (id) => id.startsWith("claude-"),
    contextWindowSize: 200_000,
    displayName: (id) => {
      const parts = id.replace(/^claude-/, "").split("-");
      if (parts.length >= 2) {
        const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        return `${family} ${parts.slice(1).join(".")}`;
      }
      return id;
    },
  },
  {
    match: (id) => id.startsWith("gpt-"),
    contextWindowSize: 272_000,
    // Codex slugs are the user-facing identifier in Codex CLI, so show
    // them raw. Prettifying (e.g. `gpt-5.5` -> `GPT-5.5`) hides the
    // actual stored model ID and masks config drift: an invalid string
    // baked into a session's `session_meta.model` reads as plausible
    // until a turn fires and the API returns 404. Raw slug matches what
    // Codex TUI shows and makes mismatches immediately obvious.
    displayName: (id) => id,
  },
];

/** Resolve context window size for a model slug. Returns the
 * default (200k) if no pattern matches. */
export function resolveContextWindow(modelId: string): number {
  const entry = MODEL_CONTEXT_WINDOWS.find((m) => m.match(modelId));
  return entry?.contextWindowSize ?? 200_000;
}

/** Format a model slug into a human-readable display name.
 * Falls back to the raw slug if no pattern matches. */
export function formatModelDisplayName(modelId: string): string {
  const entry = MODEL_CONTEXT_WINDOWS.find((m) => m.match(modelId));
  return entry?.displayName(modelId) ?? modelId;
}

/** Minimal contract for a service that emits typed state to
 * subscribers. Both usage services and session token services
 * satisfy this. The engine wires widgets to services through
 * this interface without knowing the concrete service class.
 *
 * `getState()` returns the current state snapshot without side
 * effects. Used by the health command for on-demand diagnostics
 * and by callers who need state at a specific moment rather than
 * waiting for the next emission. */
export interface Subscribable<TState> {
  subscribe(listener: (state: TState) => void): void;
  unsubscribe(listener: (state: TState) => void): void;
  rebroadcast(): void;
  getState(): TState;
  dispose(): void;
}

/** Diagnostic snapshot from a usage service. Consumed by the health
 * command. Never drives behavior - display only. */
export interface UsageServiceDiagnostics {
  /** Count of consecutive failed kickstart rounds. Zero means the
   * gate is at its most responsive setting. */
  consecutiveFailedKickstarts: number;
  /** Strikes remaining in the current post-wake window. Zero means
   * the next 429 re-parks instead of retrying. */
  postWakeStrikesRemaining: number;
  /** Most recent rate-limit park timestamp, or null if not currently
   * parked. */
  rateLimitedAt: number | null;
  /** Server-supplied retry-after in ms for the current park, or
   * null. */
  retryAfterMs: number | null;
}

/** Extended contract for usage services that support the
 * activity-driven kickstart and escalation reset. Session token
 * services do NOT implement these - they are the activity signal
 * source, not the consumer. */
export interface UsageService<TState> extends Subscribable<TState> {
  start(): void;
  setActivityProbe(probe: () => number | null): void;
  resetKickstartEscalation(): void;
  getDiagnostics(): UsageServiceDiagnostics;
}

/** Contract for session token services that expose the activity
 * signal consumed by usage services via `setActivityProbe`. */
export interface SessionTokenService<TState> extends Subscribable<TState> {
  start(): void;
  getLastActivityMs(): number | null;
  /** Current transcript / rollout path, or null if no session has
   * been resolved. Used by the notification bridge to read the
   * response preview and by the health command for diagnostics. */
  getActiveTranscriptPath(): string | null;
  /** Clear all cached session state and drop to the idle state.
   * Called by Reset WAT321 so the widget goes blank immediately
   * instead of re-discovering old transcripts on the next poll. */
  reset(): void;
}

/** Static descriptor for a provider. Passed to the registry at
 * registration time. The registry uses this to manage lifecycle,
 * config detection, and display mode resolution. */
export interface ProviderDescriptor {
  key: ProviderKey;
  displayName: string;
  settingKey: string;
}

/** Static descriptor for a widget. The catalog uses this for
 * ID tracking, slot assignment, and Reset WAT321 visibility
 * restore. The widget class itself still creates and owns the
 * VS Code StatusBarItem. */
export interface WidgetDescriptor {
  id: string;
  name: string;
  provider: ProviderKey | "engine";
  slot: number;
}

/** A live provider group after activation. Holds the running
 * services and all disposables for teardown. The registry stores
 * one of these per active provider. */
export interface ProviderGroup {
  disposables: vscode.Disposable[];
  usageService: UsageService<{ status: string }>;
  tokenService: SessionTokenService<{ status: string }>;
}
