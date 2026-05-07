import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { resolveOpenCodeCli } from "../shared/mcp/cliBinaryResolver";
import { MODEL_BRIDGE_DIR } from "./constants";
import type { ModelBridgeLogger } from "./outputChannel";

/**
 * Lifecycle for the WAT321-managed `opencode serve` subprocess.
 *
 * When `wat321.modelBridge.enabled` is on, WAT321 spawns its own
 * OpenCode server in an isolated workdir under
 * `~/.wat321/model-bridge/opencode-workdir/`. The workdir holds a
 * single `opencode.json` describing the providers (`llama.cpp`
 * pointed at the user's local LLM endpoint + `zen` pointed at the
 * OpenCode Zen base URL). The Zen API key flows in via the
 * `OPENCODE_ZEN_KEY` environment variable so it never lands on disk.
 *
 * Spawn semantics:
 *   - `opencode serve --hostname 127.0.0.1 --port <port>`
 *   - Default port 4096; falls back to OS-allocated ephemeral port
 *     if 4096 is bound by another process.
 *   - cwd is the workdir so `opencode` discovers the JSON next to it.
 *
 * The manager exposes `getServerUrl()` so `config.ts` can resolve the
 * harness URL without reaching back into subprocess state. Returns
 * "" until the spawned server passes a readiness probe; the bridge's
 * harness toggle naturally hides `model_bridge_task` while empty.
 */

export const OPENCODE_WORKDIR = join(MODEL_BRIDGE_DIR, "opencode-workdir");
export const OPENCODE_CONFIG_PATH = join(OPENCODE_WORKDIR, "opencode.json");
export const DEFAULT_OPENCODE_PORT = 4096;

export interface OpenCodeManagerStatus {
  desired: boolean;
  running: boolean;
  cliResolvable: boolean;
  url: string;
  port: number;
  lastError: string;
}

export interface OpenCodeManagerInputs {
  enabled: boolean;
  localEndpoint: string;
  zenApiKey: string;
}

export interface OpenCodeManager {
  /** Reconcile the running subprocess against the supplied inputs.
   * Spawns when enabled and not yet running; restarts when the
   * provider-affecting inputs (endpoint or zen key) changed; kills
   * when disabled. Returns the current URL once readiness completes
   * or "" when not yet up. */
  reconcile(inputs: OpenCodeManagerInputs): Promise<string>;
  /** Synchronous accessor for the current resolved URL. Empty when
   * not running or readiness has not yet passed. */
  getServerUrl(): string;
  /** Lightweight status surface for health output / log lines. */
  getStatus(): OpenCodeManagerStatus;
  /** Stop the subprocess and release any allocated port. */
  dispose(): Promise<void>;
}

/** Probe whether `port` is bindable on 127.0.0.1. Uses a short-lived
 * `net.createServer` listen attempt; the kernel hands back EADDRINUSE
 * fast enough that this is cheap to call on every reconcile. */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}

/** Ask the OS for an ephemeral port. Returns 0 on failure (caller
 * surfaces the error). */
async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(0));
    server.once("listening", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    try {
      server.listen(0, "127.0.0.1");
    } catch {
      resolve(0);
    }
  });
}

/** Build the opencode.json content describing both providers. The
 * Zen API key flows via `OPENCODE_ZEN_KEY` env; the JSON only carries
 * the substitution placeholder so the file itself is safe to leave
 * on disk. */
function buildOpenCodeJson(localEndpoint: string): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "llama.cpp": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${localEndpoint.replace(/\/+$/, "")}/v1`,
          apiKey: "not-needed",
        },
        // OpenCode rejects any modelID not declared in this map. The
        // local LLM is whatever llama.cpp / Ollama / vLLM currently
        // has loaded, and llama.cpp ignores the request's `model`
        // field entirely - so we register one fixed canonical name
        // and channel.mjs always sends it for local instances. The
        // user can swap models server-side; the harness keeps working
        // because the wire identifier never changes.
        models: {
          local: { name: "Local LLM" },
        },
      },
      zen: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://opencode.ai/zen/v1",
          apiKey: "{env:OPENCODE_ZEN_KEY}",
        },
        models: {
          "big-pickle": { name: "Big Pickle" },
          "gpt-5-nano": { name: "GPT 5 Nano" },
          "ling-2.6-flash": { name: "Ling 2.6 Flash" },
          "hy3-preview-free": { name: "Hy3 Preview" },
          "nemotron-3-super-free": { name: "Nemotron 3 Super" },
          "minimax-m2.5-free": { name: "MiniMax M2.7" },
        },
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Probe `http://127.0.0.1:<port>/app` until it answers or times out.
 * OpenCode's serve mode exposes `/app` for the embedded UI; even
 * without HTML it returns a non-network-error response once bound. */
async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app`, {
        method: "GET",
      });
      if (res.status < 500) return true;
    } catch {
      // not yet listening - keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Snapshot of the inputs that, when changed, force a respawn. */
interface InputsSnapshot {
  localEndpoint: string;
  zenApiKey: string;
}

function inputsChanged(prev: InputsSnapshot, next: InputsSnapshot): boolean {
  return prev.localEndpoint !== next.localEndpoint || prev.zenApiKey !== next.zenApiKey;
}

export function createOpenCodeManager(logger: ModelBridgeLogger): OpenCodeManager {
  let child: ChildProcess | null = null;
  let port = 0;
  let url = "";
  let lastInputs: InputsSnapshot = { localEndpoint: "", zenApiKey: "" };
  let lastError = "";
  let cliResolvable = false;
  let desired = false;
  let inFlight: Promise<string> | null = null;

  const ensureWorkdir = (): void => {
    if (!existsSync(OPENCODE_WORKDIR)) {
      mkdirSync(OPENCODE_WORKDIR, { recursive: true });
    }
  };

  const writeConfig = (localEndpoint: string): void => {
    ensureWorkdir();
    writeFileAtomic(OPENCODE_CONFIG_PATH, buildOpenCodeJson(localEndpoint), ".opencode.json.tmp");
  };

  const stop = async (): Promise<void> => {
    if (child === null) return;
    const handle = child;
    child = null;
    url = "";
    port = 0;
    // Synchronous SIGKILL up front so an extension-host teardown
    // (VS Code window close) gets the kill in flight before its
    // event loop dies and orphans the child. The graceful SIGTERM
    // path was racing against `dispose()` returns - by the time the
    // 2s timeout fired, the host was already gone and the kill
    // never reached the child. SIGKILL on Windows maps to a hard
    // TerminateProcess; on POSIX it is the unblockable signal that
    // always lands. We do not need a graceful shutdown - opencode
    // serve has no on-disk state worth flushing.
    try {
      handle.kill("SIGKILL");
    } catch {
      // best-effort
    }
  };

  const start = async (inputs: OpenCodeManagerInputs): Promise<string> => {
    const resolved = await resolveOpenCodeCli();
    cliResolvable = resolved !== null;
    if (resolved === null) {
      lastError = "opencode CLI not found on PATH";
      logger.info(
        "managed OpenCode requested but `opencode` CLI is not on PATH; skipping spawn"
      );
      return "";
    }

    writeConfig(inputs.localEndpoint);

    const chosenPort = (await isPortFree(DEFAULT_OPENCODE_PORT))
      ? DEFAULT_OPENCODE_PORT
      : await pickEphemeralPort();
    if (chosenPort === 0) {
      lastError = "could not allocate a port for opencode serve";
      logger.error(lastError);
      return "";
    }

    const env = { ...process.env, OPENCODE_ZEN_KEY: inputs.zenApiKey };
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(chosenPort)];

    let proc: ChildProcess;
    try {
      proc = spawn(resolved.command, args, {
        cwd: OPENCODE_WORKDIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: resolved.needsShell,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error(`opencode serve spawn failed: ${lastError}`);
      return "";
    }

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      logger.info(`opencode: ${chunk.trimEnd()}`);
    });
    proc.stderr?.on("data", (chunk: string) => {
      logger.warn(`opencode: ${chunk.trimEnd()}`);
    });
    proc.on("exit", (code) => {
      logger.info(`opencode serve exited with code ${code}`);
      if (child === proc) {
        child = null;
        url = "";
        port = 0;
      }
    });

    child = proc;
    port = chosenPort;

    const ready = await waitForReady(chosenPort, 10_000);
    if (!ready) {
      lastError = `opencode serve did not become ready on 127.0.0.1:${chosenPort} within 10s`;
      logger.warn(lastError);
      await stop();
      return "";
    }

    url = `http://127.0.0.1:${chosenPort}`;
    lastError = "";
    lastInputs = { localEndpoint: inputs.localEndpoint, zenApiKey: inputs.zenApiKey };
    logger.info(`opencode serve ready at ${url}`);
    return url;
  };

  const reconcile = async (inputs: OpenCodeManagerInputs): Promise<string> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        desired = inputs.enabled;
        if (!inputs.enabled) {
          if (child !== null) {
            logger.info("managed OpenCode disabled; stopping subprocess");
            await stop();
          }
          return "";
        }
        if (child !== null && !inputsChanged(lastInputs, {
          localEndpoint: inputs.localEndpoint,
          zenApiKey: inputs.zenApiKey,
        })) {
          return url;
        }
        if (child !== null) {
          logger.info("managed OpenCode inputs changed; restarting subprocess");
          await stop();
        }
        return await start(inputs);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    reconcile,
    getServerUrl: () => url,
    getStatus: () => ({
      desired,
      running: child !== null,
      cliResolvable,
      url,
      port,
      lastError,
    }),
    dispose: stop,
  };
}
