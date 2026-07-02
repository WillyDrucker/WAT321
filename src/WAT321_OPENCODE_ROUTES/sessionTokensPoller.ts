import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../shared/wat321Paths";

/**
 * Background poller that reads OpenCode session token data for the
 * bridge's active aliases and exposes a synchronous snapshot. The
 * OpenCode Routes widget renders at 1Hz - this poller runs every 3s
 * to keep the displayed `tokens / window  pct%` figures fresh without
 * blocking the render loop on a network fetch.
 *
 * Source of truth for context-fill: OpenCode's own TUI uses the
 * latest assistant message's
 *   `input + output + reasoning + cache.read + cache.write`
 * as the denominator. The Auto-Compact trigger is computed via
 * OpenCode's `overflow.ts:usable()` which subtracts a reserved
 * buffer (default 20K) from the window.
 *
 * Cache shape: keyed by sessionId. Cleared when the alias map's
 * active entry rotates, so a freshly-created session never inherits
 * the prior session's snapshot.
 *
 * Lives in the OpenCode Routes tier because both the data source
 * (OpenCode harness) and the consumer (OpenCode Routes widget) belong
 * here. Engine never imports from this file - cross-tier consumers
 * subscribe via engine events rather than importing directly.
 */

const BRIDGE_ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");
const POLL_INTERVAL_MS = 3_000;
const FETCH_TIMEOUT_MS = 2_000;
/** OpenCode's `COMPACTION_BUFFER` constant from
 * `packages/opencode/src/session/overflow.ts`. The default reserved
 * window the auto-compact logic subtracts when the model has no
 * separate input limit. We replicate it here so the displayed
 * "Auto-Compact at ~X" matches OpenCode's actual trigger. */
const COMPACTION_BUFFER = 20_000;
/** Soft cap on how many recent messages the poller hydrates per
 * session. Long sessions can carry hundreds of messages - the latest
 * assistant turn with output > 0 is always within the last few
 * positions, so a small page keeps the read cheap. */
const MESSAGE_PAGE_LIMIT = 10;

export type BridgeTarget = "opencode" | "local";

export interface BridgeSessionTokens {
  sessionId: string;
  /** Cumulative tokens the model just saw + emitted on the latest
   * assistant turn. Mirrors OpenCode's TUI formula. */
  contextUsed: number;
  /** Model context window, or null when unknown (Zen routes whose
   * underlying model is undisclosed). When null the widget renders
   * `${used} tokens` without a percentage / bar. */
  contextWindow: number | null;
  /** Auto-compact trigger point in tokens, or null when contextWindow
   * is null. Computed as `contextWindow - COMPACTION_BUFFER`. */
  autoCompactTokens: number | null;
  /** Display name for the active model on this session. Local LLM:
   * llama-server's `model_alias`, stripped of `.gguf` and quantization
   * tag (`Qwen3-8B-Q5_K_M.gguf` -> `Qwen3-8B`). Falls back to null
   * when the probe returns no usable name - the tooltip then omits the
   * specific model and uses the catalog alias instead. Remote
   * (Zen routes): null - the catalog alias (Big Pickle, GPT 5 Nano,
   * etc.) is the right display string for those, and the widget
   * resolves it from the instance catalog directly. */
  modelDisplayName: string | null;
  /** Wall-clock when this snapshot was last refreshed. Lets callers
   * show a relative-time line and detect staleness. */
  lastFetchedAtMs: number;
}

interface AliasMap {
  opencode?: Record<string, { sessionId?: string; instanceId?: string | null } | null>;
  local?: Record<string, { sessionId?: string; instanceId?: string | null } | null>;
  activeAliases?: { opencode?: string | null; local?: string | null };
}

interface OpenCodeMessage {
  info?: {
    role?: string;
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

function readAliasMap(): AliasMap | null {
  if (!existsSync(BRIDGE_ALIAS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BRIDGE_ALIAS_PATH, "utf8")) as AliasMap;
  } catch {
    return null;
  }
}

/** Mirror OpenCode TUI's display formula. Picks the latest assistant
 * message that has output > 0 (skips empty placeholders), then sums
 * input + output + reasoning + cache.read + cache.write. Returns 0
 * when no qualifying message exists yet. */
function computeContextUsed(messages: OpenCodeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "assistant") continue;
    const t = info.tokens;
    if (!t) continue;
    const output = t.output ?? 0;
    if (output <= 0) continue;
    const cache = t.cache ?? {};
    return (
      (t.input ?? 0) +
      output +
      (t.reasoning ?? 0) +
      (cache.read ?? 0) +
      (cache.write ?? 0)
    );
  }
  return 0;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface LocalProps {
  /** Runtime context window from llama-server. */
  nCtx: number | null;
  /** `model_alias` from llama-server, cleaned for display: `.gguf`
   * suffix and quantization tag stripped (`Qwen3-8B-Q5_K_M.gguf` ->
   * `Qwen3-8B`). Null when llama-server reports no alias. */
  modelDisplayName: string | null;
}

/** Strip the `.gguf` suffix and trailing quantization tag (`-Q5_K_M`,
 * `-Q4_0`, `-IQ3_XXS`, etc.) from a llama-server `model_alias` so the
 * tooltip reads as a clean model name instead of a filename. */
function cleanLocalModelName(raw: string): string {
  let name = raw.replace(/\.gguf$/i, "");
  // Quantization tags follow a -Q[0-9] / -IQ[0-9] / -F[0-9] pattern at
  // the very end of the filename. Strip a single trailing tag if
  // present - leave the model identifier intact otherwise.
  name = name.replace(/-(Q|IQ|F)\d+(_[A-Z0-9]+)*$/i, "");
  return name;
}

/** Probe llama-server's `/props` for the runtime context window AND
 * the loaded model alias. Local LLM's catalog `contextWindow` is just
 * a fallback - the loaded model decides the actual limit. Result is
 * cached for 30s on the caller side - this just performs the raw
 * fetch. */
async function probeLocalProps(endpoint: string): Promise<LocalProps> {
  const empty: LocalProps = { nCtx: null, modelDisplayName: null };
  if (!endpoint) return empty;
  const res = await fetchWithTimeout(
    `${endpoint.replace(/\/+$/, "")}/props`,
    FETCH_TIMEOUT_MS
  );
  if (!res?.ok) return empty;
  try {
    const j = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number; n_ctx_train?: number };
      n_ctx?: number;
      model_alias?: string;
    };
    const n =
      j?.default_generation_settings?.n_ctx ??
      j?.default_generation_settings?.n_ctx_train ??
      j?.n_ctx ??
      null;
    const alias =
      typeof j?.model_alias === "string" && j.model_alias.length > 0
        ? cleanLocalModelName(j.model_alias)
        : null;
    return {
      nCtx: typeof n === "number" && n > 0 ? n : null,
      modelDisplayName: alias,
    };
  } catch {
    return empty;
  }
}

interface PollerInputs {
  /** Live OpenCode serve URL. Empty when the manager has not
   * spawned the subprocess yet. The poller no-ops while empty and
   * resumes once the URL appears. */
  serveUrl: () => string;
  /** Local LLM endpoint for the `/props` probe. */
  localEndpoint: () => string;
  /** Catalog context window per target. The OpenCode Routes widget reads from
   * the merged config - this getter abstracts that lookup so the
   * poller does not need to import `config.ts`. */
  catalogContextWindow: (target: BridgeTarget) => number | null;
}

const LOCAL_NCTX_TTL_MS = 30_000;

export class BridgeSessionTokensPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, BridgeSessionTokens>();
  private localPropsCache: { at: number; props: LocalProps } | null = null;
  private disposed = false;

  constructor(private readonly inputs: PollerInputs) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cache.clear();
  }

  snapshot(target: BridgeTarget): BridgeSessionTokens | null {
    const aliases = readAliasMap();
    const activeAlias = aliases?.activeAliases?.[target];
    if (!activeAlias) return null;
    const entry = aliases?.[target]?.[activeAlias];
    const sessionId = entry?.sessionId;
    if (!sessionId) return null;
    return this.cache.get(this.cacheKey(target, sessionId)) ?? null;
  }

  private cacheKey(target: BridgeTarget, sessionId: string): string {
    return `${target}:${sessionId}`;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    const serveUrl = this.inputs.serveUrl();
    if (!serveUrl) return;
    const aliases = readAliasMap();
    if (!aliases) return;

    const targets: BridgeTarget[] = ["opencode", "local"];
    for (const target of targets) {
      const activeAlias = aliases.activeAliases?.[target];
      if (!activeAlias) continue;
      const entry = aliases[target]?.[activeAlias];
      const sessionId = entry?.sessionId;
      if (!sessionId) continue;
      await this.refreshSession(target, sessionId, serveUrl);
    }

    // Drop cache entries whose sessions are no longer active under
    // any alias. Without this, the cache grows unbounded as the user
    // creates new sessions.
    const liveKeys = new Set<string>();
    for (const target of targets) {
      const alias = aliases.activeAliases?.[target];
      if (!alias) continue;
      const sid = aliases[target]?.[alias]?.sessionId;
      if (sid) liveKeys.add(this.cacheKey(target, sid));
    }
    for (const key of this.cache.keys()) {
      if (!liveKeys.has(key)) this.cache.delete(key);
    }
  }

  private async refreshSession(
    target: BridgeTarget,
    sessionId: string,
    serveUrl: string
  ): Promise<void> {
    const url = `${serveUrl.replace(/\/+$/, "")}/session/${sessionId}/message?limit=${MESSAGE_PAGE_LIMIT}`;
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res?.ok) return;
    let messages: OpenCodeMessage[];
    try {
      const data = (await res.json()) as unknown;
      messages = Array.isArray(data) ? (data as OpenCodeMessage[]) : [];
    } catch {
      return;
    }
    // Cache even when contextUsed is 0. Brand-new sessions (no prior
    // assistant turn) and mid-stream dispatches (assistant output still
    // 0) are legitimate zero-states - bailing here stranded the widget
    // in the liveTokens-only fallback for the entire first dispatch.
    // Caching with the resolved contextWindow lets the widget render
    // projected tokens + percent from the first heartbeat.
    const contextUsed = computeContextUsed(messages);

    const { contextWindow, modelDisplayName } = await this.resolveTargetProps(target);
    const autoCompactTokens =
      contextWindow !== null
        ? Math.max(0, contextWindow - COMPACTION_BUFFER)
        : null;

    this.cache.set(this.cacheKey(target, sessionId), {
      sessionId,
      contextUsed,
      contextWindow,
      autoCompactTokens,
      modelDisplayName,
      lastFetchedAtMs: Date.now(),
    });
  }

  /** Resolve context window + model display name for a session. Local
   * probes llama-server's `/props` (cached 30s) and falls back to the
   * catalog window when the probe fails. Remote (Zen) routes use the
   * catalog window and leave `modelDisplayName` null - the widget
   * resolves the display string from the instance catalog. */
  private async resolveTargetProps(
    target: BridgeTarget
  ): Promise<{ contextWindow: number | null; modelDisplayName: string | null }> {
    const catalog = this.inputs.catalogContextWindow(target);
    if (target !== "local") {
      return { contextWindow: catalog, modelDisplayName: null };
    }
    const now = Date.now();
    if (
      this.localPropsCache &&
      now - this.localPropsCache.at < LOCAL_NCTX_TTL_MS
    ) {
      const props = this.localPropsCache.props;
      return {
        contextWindow: props.nCtx ?? catalog,
        modelDisplayName: props.modelDisplayName,
      };
    }
    const endpoint = this.inputs.localEndpoint();
    const props = endpoint
      ? await probeLocalProps(endpoint)
      : { nCtx: null, modelDisplayName: null };
    this.localPropsCache = { at: now, props };
    return {
      contextWindow: props.nCtx ?? catalog,
      modelDisplayName: props.modelDisplayName,
    };
  }
}
