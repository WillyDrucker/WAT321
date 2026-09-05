import { createServer } from "node:net";

/**
 * The two network probes `openCodeServeManager.ts` needs around a
 * spawn: an OS-allocated ephemeral port before, and a readiness poll
 * against the bound server after.
 */

/** Per-probe abort budget. A stalled fetch (TCP accept + no response)
 * must not pin the readiness wait past the outer deadline, or a hung
 * connection during spawn would freeze `reconcile()` and block the
 * pending-inputs drain. */
const PROBE_TIMEOUT_MS = 1500;
const PROBE_INTERVAL_MS = 250;

/** Ask the OS for an ephemeral port. Returns 0 on failure (caller
 * surfaces the error). Static defaults race when two VS Code
 * instances activate simultaneously - both see the port free, both
 * try to bind, second crashes. Kernel allocation removes the race. */
export async function pickEphemeralPort(): Promise<number> {
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
 * OpenCode's serve mode exposes `/app` for the embedded UI - even
 * without HTML it returns a non-network-error response once bound. */
export async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const probeTimer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app`, {
        method: "GET",
        signal: controller.signal,
      });
      if (res.status < 500) return true;
    } catch {
      // not yet listening or probe aborted - keep polling
    } finally {
      clearTimeout(probeTimer);
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}
