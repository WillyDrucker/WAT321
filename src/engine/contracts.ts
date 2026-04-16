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
    displayName: (id) =>
      id.split("-")
        .map((p) => (p === "gpt" ? "GPT" : p.charAt(0).toUpperCase() + p.slice(1)))
        .join(" ")
        .replace(/^GPT /, "GPT-"),
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
 * this interface without knowing the concrete service class. */
export interface Subscribable<TState> {
  subscribe(listener: (state: TState) => void): void;
  unsubscribe(listener: (state: TState) => void): void;
  rebroadcast(): void;
  dispose(): void;
}

/** Extended contract for usage services that support the
 * activity-driven kickstart and escalation reset. Session token
 * services do NOT implement these — they are the activity signal
 * source, not the consumer. */
export interface UsageService<TState> extends Subscribable<TState> {
  start(): void;
  setActivityProbe(probe: () => number | null): void;
  resetKickstartEscalation(): void;
}

/** Contract for session token services that expose the activity
 * signal consumed by usage services via `setActivityProbe`. */
export interface SessionTokenService<TState> extends Subscribable<TState> {
  start(): void;
  getLastActivityMs(): number | null;
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
