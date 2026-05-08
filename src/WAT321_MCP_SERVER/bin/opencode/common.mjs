import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bridgeStateDir, modelBridgeStateDir } from "../paths.mjs";

/**
 * Shared paths, constants, and small helpers used across the OpenCode
 * bin modules (dispatch, sessions, aliases, heartbeat, sse).
 *
 * Per-workspace partitioning is handled at the directory level by
 * `WAT321_WORKSPACE_ID` - `modelBridgeStateDir()` resolves to
 * `~/.wat321/clients/<wsId>/model-bridge/`, so heartbeat and alias
 * files inside that dir need no per-file hash suffix.
 */

export const BRIDGE_DIR = bridgeStateDir();
export const MB_DIR = modelBridgeStateDir();
export const ALIAS_PATH = join(BRIDGE_DIR, "session-aliases.json");
export const MB_CONFIG_PATH = join(MB_DIR, "config.json");
export const BRIDGE_CONFIG_PATH = join(BRIDGE_DIR, "config.json");
export const CHANNEL_LOG_PATH = join(BRIDGE_DIR, "channel.log");
export const MB_HEARTBEAT_PATH = join(MB_DIR, "heartbeat.json");
export const MB_LAST_USED_PATH = join(MB_DIR, "last-used.json");

export const ANON_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_TIMEOUT_SEC = 120;
export const HEARTBEAT_KEEPALIVE_MS = 5_000;
/** Hard ceiling on `/session` POST. Session creation is local-disk
 * work in opencode serve; without this cap a hung server would wedge
 * the dispatch past the caller's outer `timeout_sec`. */
export const SESSION_CREATE_TIMEOUT_MS = 30_000;

export function ensureDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

/** Append a structured trace line to the bridge channel log. SSE-tap
 * failures are silent in the dispatch path, so this log is the only
 * signal when live tokens fall back to elapsed-seconds. Best-effort. */
export function logSse(message) {
  try {
    if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(
      CHANNEL_LOG_PATH,
      `[${new Date().toISOString()}] [sse] ${message}\n`,
      { flag: "a" }
    );
  } catch {
    // best-effort
  }
}

/** Workspace folder name from the bridge config, "Workspace" fallback
 * when config is absent or the field is missing. */
export function readProjectName() {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8"));
    if (typeof cfg?.projectName === "string" && cfg.projectName.trim().length > 0) {
      return cfg.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Standardized session display label. Pattern: `<ProjectName> Epic
 * Handshake Claude-to-<Target> S<n>`. Alias (`S1`, `S2`, ...) stays
 * the routing key; this string is for display only. */
export function formatSessionDisplayName(target, alias) {
  const targetLabel =
    target === "local" ? "Local" : target === "opencode" ? "OpenCode" : target;
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a JSON `fetch` with an AbortController timeout. For one-shot
 * REST calls (session create, etc.) that need a hard ceiling separate
 * from the dispatch's outer `timeout_sec`. */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
