import type { StatusBarWidget as GenericStatusBarWidget } from "../shared/types";

/** Active session entry from ~/.claude/sessions/<pid>.json */
export interface SessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
}

export interface ResolvedSession {
  sessionId: string;
  label: string; // folder name
  sessionTitle: string; // first user message, truncated
  contextUsed: number; // tokens currently in context
  contextWindowSize: number; // 200k or 1M
  autoCompactPct: number; // e.g. 70
}

export type WidgetState =
  | { status: "not-installed" } // ~/.claude/ does not exist - hide widget
  | { status: "no-session" }
  | { status: "waiting" } // session exists but no usage data yet
  | { status: "ok"; session: ResolvedSession };

/** Claude session token widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<WidgetState>;
