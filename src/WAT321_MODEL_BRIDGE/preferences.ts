import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { MODEL_BRIDGE_DIR, PREFERENCES_PATH } from "./constants";

/**
 * Runtime preferences for the Model Bridge. Anything the user tunes
 * per-task lives here, not in VS Code settings.json:
 *
 *   - activeInstanceId (which catalog instance handles tool calls)
 *   - useOpenCodeHarness (tool-using sub-agent toggle)
 *   - sampling (temperature, max tokens, timeout)
 *   - system prompt
 *   - phased protocol toggle, auto-compact threshold
 *   - OpenCode harness URL override
 *
 * Settings.json carries only the master `enabled` flag plus the
 * local endpoint URL. The instance catalog is hardcoded in
 * `instanceCatalog.ts`; per-task tuning is exclusively click-menu
 * driven so users never hand-edit JSON.
 *
 * Atomic writes ensure channel.mjs reading mid-update never sees a
 * torn JSON parse. Click menu writes per-key via `updatePreference`;
 * channel.mjs reads the merged config (settings + preferences) on
 * every tool call (no in-memory cache).
 */

export interface ModelBridgePreferences {
  /** Active instance id. Empty means "use the local instance" - a
   * sensible default when the user hasn't picked one yet. Driven
   * by the click-menu's Active Instance picker. */
  activeInstanceId: string;
  /** OpenCode harness toggle. Default on - the harness is the
   * cleanest path for tool-using runs against a local model and
   * costs zero context tokens when the OpenCode server is offline
   * (the tool simply does not appear in Claude's surface). */
  useOpenCodeHarness: boolean;
  /** Sampling temperature. */
  temperature: number;
  /** Max response tokens. Reasoning models need generous room
   * because the budget covers thinking AND the visible answer. */
  maxTokens: number;
  /** HTTP timeout per call, seconds. Per-instance override allowed
   * but rarely needed; 180s default suits both local and Zen. */
  timeoutSec: number;
  /** Optional global system prompt prepended to every chat call.
   * Per-call `system` arg overrides. */
  systemPrompt: string;
  /** Phased Model Protocol mode. `markers-v1` prepends the marker
   * prompt and surfaces a phase trace; `off` disables both. Mostly
   * useful with local instances - cloud models tend to ignore the
   * marker scaffolding. */
  phasedProtocol: "off" | "markers-v1";
  /** Fraction of n_ctx (0-1) at which `model_bridge_thread` auto-
   * compacts. */
  autoCompactThreshold: number;
  /** Base URL of the OpenCode HTTP server (`opencode serve`). Empty
   * means "auto-derive from the active local instance's endpoint
   * host" (substituting port 4096, OpenCode's default). The click
   * menu lets the user override when OpenCode runs on a different
   * host or port than the LLM. */
  openCodeServerUrl: string;
}

export const DEFAULT_PREFERENCES: ModelBridgePreferences = {
  activeInstanceId: "",
  useOpenCodeHarness: true,
  temperature: 0.2,
  maxTokens: 2000,
  timeoutSec: 180,
  systemPrompt: "",
  phasedProtocol: "markers-v1",
  autoCompactThreshold: 0.85,
  openCodeServerUrl: "",
};

/** Compute the effective OpenCode server URL. Returns the explicit
 * preference if set; otherwise derives one from the supplied LLM
 * endpoint host using OpenCode's default port (4096). Returns `null`
 * only when neither a preference nor an endpoint is available, in
 * which case the harness can't run. */
export function resolveOpenCodeServerUrl(
  prefs: ModelBridgePreferences,
  llmEndpoint: string
): string | null {
  if (prefs.openCodeServerUrl && prefs.openCodeServerUrl.length > 0) {
    return prefs.openCodeServerUrl.replace(/\/+$/, "");
  }
  if (!llmEndpoint || llmEndpoint.length === 0) return null;
  try {
    const url = new URL(llmEndpoint);
    return `${url.protocol}//${url.hostname}:4096`;
  } catch {
    return null;
  }
}

function ensureDir(): void {
  if (!existsSync(MODEL_BRIDGE_DIR)) {
    mkdirSync(MODEL_BRIDGE_DIR, { recursive: true });
  }
  const dir = dirname(PREFERENCES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Load preferences, merging stored values over the defaults so a
 * partially-written file (or a file from an older version with
 * fewer keys) still produces a complete object. */
export function readPreferences(): ModelBridgePreferences {
  if (!existsSync(PREFERENCES_PATH)) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = readFileSync(PREFERENCES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelBridgePreferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Atomically write the entire preferences object. */
export function writePreferences(prefs: ModelBridgePreferences): boolean {
  ensureDir();
  return writeFileAtomic(PREFERENCES_PATH, `${JSON.stringify(prefs, null, 2)}\n`);
}

/** Update a single preference key without disturbing the rest.
 * Reads the current file, applies the patch, writes atomically. */
export function updatePreference<K extends keyof ModelBridgePreferences>(
  key: K,
  value: ModelBridgePreferences[K]
): boolean {
  const current = readPreferences();
  current[key] = value;
  return writePreferences(current);
}
