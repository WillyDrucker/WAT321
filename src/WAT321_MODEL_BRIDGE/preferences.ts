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
  /** Phased Model Protocol mode.
   *
   *   - `auto`        - resolves at call time: `gated-v1` for local
   *                     instances, `off` for cloud. Default. Small
   *                     local models benefit from gating; capable
   *                     cloud models lose latency for no quality gain.
   *   - `gated-v1`    - bridge runs the prompt through N separate
   *                     round-trips (RESTATE -> PLAN -> SOLVE ->
   *                     REVIEW -> ANSWER), each phase a discrete HTTP
   *                     call carrying prior phase outputs forward.
   *                     Status bar shows live phase progress.
   *   - `markers-v1`  - single-shot scaffolding: model emits marker
   *                     tokens inline (<<PHASE:STARTED>>, etc.) and
   *                     the bridge surfaces them as a phase trace.
   *                     Faster than gated; weaker steering for small
   *                     models that drift mid-plan.
   *   - `off`         - no scaffolding. */
  phasedProtocol: "off" | "markers-v1" | "gated-v1" | "auto";
  /** Fraction of n_ctx (0-1) at which `model_bridge_thread` auto-
   * compacts. */
  autoCompactThreshold: number;
  /** Default OpenCode agent for `model_bridge_task` calls when the
   * caller does not pass an explicit `agent` argument. OpenCode ships
   * four built-in agents:
   *   - `build`   - default; full file r/w + shell + web tools
   *   - `explore` - read-only investigation
   *   - `general` - mixed; lighter than build
   *   - `plan`    - planning sub-agent that proposes work without
   *                 executing it
   * The click menu lets the user change the default. Per-call
   * overrides via the tool's `agent` argument always win. */
  defaultAgent: "build" | "explore" | "general" | "plan";
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
  defaultAgent: "build",
};

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
