import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { resolveOpenCodeCli } from "../shared/providers/opencode/cliResolver";
import { buildOpenCodeJson } from "../shared/providers/opencode/configBuilder";
import { verifyOutputLimits } from "../shared/providers/opencode/configVerifier";
import { modelBridgeStateDir } from "../shared/wat321Paths";

/**
 * Lifecycle for the WAT321-managed `opencode serve` subprocess.
 *
 * Each VS Code instance spawns its own harness on an OS-allocated
 * ephemeral port, written to its per-client `model-bridge/config.json`
 * for the MCP child to read. Workdir lives at
 * `~/.wat321/clients/<wsId>/model-bridge/opencode-workdir/` and holds
 * a single `opencode.json` describing the providers (`llama.cpp` for
 * local, `zen` for cloud routes). The Zen API key flows in via the
 * `OPENCODE_ZEN_KEY` env so it never lands on disk.
 *
 * Spawn semantics:
 *   - `opencode serve --hostname 127.0.0.1 --port <ephemeralPort>`
 *   - cwd is the workdir so opencode discovers the JSON next to it
 *
 * `getServerUrl()` returns "" until the spawned server passes the
 * readiness probe; consumers gate visibility on that.
 */

export const OPENCODE_WORKDIR = join(modelBridgeStateDir(), "opencode-workdir");
export const OPENCODE_CONFIG_PATH = join(OPENCODE_WORKDIR, "opencode.json");

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

export interface HarnessLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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
  /** Subscribe to URL transitions. The listener fires every time the
   * resolved server URL changes (post-spawn-ready, post-stop, post-
   * crash-exit). Returns a disposable. The activate path uses this to
   * rewrite config.json whenever the URL changes, closing a race where
   * the activate-time `reconcile` resolved with "" but a later spawn
   * succeeded with no observer to capture the new URL. */
  onUrlChanged(listener: (url: string) => void): { dispose(): void };
  /** Stop the subprocess and release any allocated port. */
  dispose(): Promise<void>;
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

/** Probe `http://127.0.0.1:<port>/app` until it answers or times out.
 * OpenCode's serve mode exposes `/app` for the embedded UI; even
 * without HTML it returns a non-network-error response once bound. */
async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app`, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      // not yet listening - keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

interface InputsSnapshot {
  localEndpoint: string;
  zenApiKey: string;
}

function inputsChanged(prev: InputsSnapshot, next: InputsSnapshot): boolean {
  return prev.localEndpoint !== next.localEndpoint || prev.zenApiKey !== next.zenApiKey;
}

export function createOpenCodeManager(logger: HarnessLogger): OpenCodeManager {
  let child: ChildProcess | null = null;
  let port = 0;
  let url = "";
  let lastInputs: InputsSnapshot = { localEndpoint: "", zenApiKey: "" };
  let lastError = "";
  let cliResolvable = false;
  let desired = false;
  let inFlight: Promise<string> | null = null;
  const urlListeners = new Set<(url: string) => void>();
  /** Single point of mutation for `url`. Notifies listeners only on
   * actual change so duplicate set-to-same-value calls do not refire. */
  const setUrl = (next: string): void => {
    if (next === url) return;
    url = next;
    for (const fn of urlListeners) {
      try { fn(url); } catch { /* listener-side errors must not affect manager */ }
    }
  };

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
    setUrl("");
    port = 0;
    // Synchronous SIGKILL up front so an extension-host teardown
    // (VS Code window close) gets the kill in flight before its event
    // loop dies and orphans the child. opencode serve has no on-disk
    // state worth flushing - graceful SIGTERM with a 2s timeout was
    // racing dispose() returns. SIGKILL on Windows maps to
    // TerminateProcess; on POSIX it is the unblockable signal.
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

    // OS-allocated ephemeral port. Static defaults race when two VS
    // Code instances activate simultaneously - both see the port free,
    // both try to bind, second crashes. Ephemeral allocation lets the
    // kernel hand out unique ports per process, removing the race.
    const chosenPort = await pickEphemeralPort();
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
        setUrl("");
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

    setUrl(`http://127.0.0.1:${chosenPort}`);
    lastError = "";
    lastInputs = { localEndpoint: inputs.localEndpoint, zenApiKey: inputs.zenApiKey };
    logger.info(`opencode serve ready at ${url}`);
    void verifyOutputLimits(url, logger);
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
        if (
          child !== null &&
          !inputsChanged(lastInputs, {
            localEndpoint: inputs.localEndpoint,
            zenApiKey: inputs.zenApiKey,
          })
        ) {
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
    onUrlChanged(listener) {
      urlListeners.add(listener);
      return { dispose: () => { urlListeners.delete(listener); } };
    },
    dispose: stop,
  };
}
