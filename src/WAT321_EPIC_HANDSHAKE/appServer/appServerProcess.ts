import { spawn, type ChildProcess } from "node:child_process";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * The `codex app-server` child process behind `AppServerClient`:
 * spawn, stdin writes, stdout line splitting, graceful shutdown, and
 * force-kill. Knows nothing about JSON-RPC. Every way the process can
 * end reports through `onFailure` so the client can reject whatever
 * is still pending with the matching reason.
 */

/** Default command that spawns `codex app-server`. Discovered on
 * `PATH` at runtime via the standard child-process search, so the
 * user just needs `codex` installed normally. */
const DEFAULT_CODEX_COMMAND = "codex";

/** Subcommand arguments. `app-server` is the headless JSON-RPC
 * surface over stdio, its documented default transport. */
const CODEX_APP_SERVER_ARGS = ["app-server"];

/** Codex app-server writes one JSON object per line. */
const LINE_TERMINATOR = "\n";

interface AppServerProcessHooks {
  /** One complete stdout line, never blank. */
  onLine(line: string): void;
  /** The process is gone or unusable. Fires for spawn errors, an
   * unexpected exit, and both shutdown paths. */
  onFailure(err: Error): void;
}

export class AppServerProcess {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private isShuttingDown = false;
  private hasSpawned = false;
  private readonly executable: string;

  constructor(
    private readonly logger: EpicHandshakeLogger,
    private readonly instanceId: string,
    executable: string | undefined,
    private readonly hooks: AppServerProcessHooks
  ) {
    this.executable = executable ?? DEFAULT_CODEX_COMMAND;
  }

  /** Spawn the child with stdio pipes wired up. Throws on a second call. */
  spawn(): void {
    if (this.hasSpawned) {
      throw new Error("AppServerClient: already spawned");
    }
    this.hasSpawned = true;
    this.logger.info(
      `[${this.instanceId}] spawning ${this.executable} ${CODEX_APP_SERVER_ARGS.join(" ")}`
    );

    // On Windows, `codex` is typically a `.cmd` shim installed by
    // npm. Node's child_process.spawn without `shell: true` will not
    // find `.cmd`/`.bat` wrappers on PATH, so we enable shell on
    // win32. This matches how other Node tooling (e.g. cross-spawn)
    // handles the same case. On POSIX, `codex` is a real binary and
    // we spawn it directly.
    const useShell = process.platform === "win32";
    const child = spawn(this.executable, CODEX_APP_SERVER_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });

    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stdout?.on("error", (err) => {
      this.logger.error(`[${this.instanceId}] stdout error: ${err.message}`);
    });

    // Codex app-server's stderr is intentionally drained and ignored.
    // The server emits structured operational logs there that the
    // extension cannot act on, and buffering them has leaked memory
    // on chatty builds.
    child.stderr?.resume();

    child.on("error", (err) => {
      this.logger.error(`[${this.instanceId}] spawn error: ${err.message}`);
      this.hooks.onFailure(err);
    });

    child.on("exit", (code, signal) => {
      this.logger.info(
        `[${this.instanceId}] app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`
      );
      this.child = null;
      if (!this.isShuttingDown) {
        this.hooks.onFailure(
          new Error(
            `codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
          )
        );
      }
    });
  }

  /** Is the child process alive and usable? */
  get isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.isShuttingDown;
  }

  /** Write one frame to stdin. Throws when stdin is not writable, and
   * reports an asynchronous write error through `onError`. */
  write(frame: string, onError?: (err: Error) => void): void {
    const stdin = this.child?.stdin ?? null;
    if (stdin === null || stdin.writable !== true) {
      throw new Error("stdin is not writable");
    }
    stdin.write(frame, (err) => {
      if (err !== null && err !== undefined) onError?.(err);
    });
  }

  /** Clean shutdown. Sends SIGTERM to the child, waits briefly for
   * it to exit, then SIGKILLs if still alive. Safe to call multiple
   * times or after the child has already exited. */
  async shutdown(graceMs: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.info(`[${this.instanceId}] shutting down app-server`);

    const child = this.child;
    if (child === null || child.exitCode !== null) {
      this.child = null;
      this.hooks.onFailure(new Error("AppServerClient: shutting down"));
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // best-effort
    }

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    });

    if (!exited) {
      this.logger.warn(
        `[${this.instanceId}] SIGTERM grace expired, sending SIGKILL`
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }

    this.child = null;
    this.hooks.onFailure(new Error("AppServerClient: shut down"));
  }

  /** Immediate kill. Sends SIGKILL straight to the child without
   * the SIGTERM grace period that `shutdown` uses. The bridge's
   * "Restart Codex Bridge" menu action calls this when the user
   * wants the running app-server gone now (cached stale config,
   * misbehaving connection, etc.). Any in-flight pending requests
   * are rejected synchronously so callers unwind cleanly. Idempotent -
   * subsequent calls no-op once `child` is null. */
  forceKill(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.info(`[${this.instanceId}] force-killing app-server (SIGKILL)`);
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
    this.hooks.onFailure(new Error("AppServerClient: force-killed"));
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const nlIndex = this.stdoutBuffer.indexOf(LINE_TERMINATOR);
      if (nlIndex === -1) break;
      const line = this.stdoutBuffer.substring(0, nlIndex);
      this.stdoutBuffer = this.stdoutBuffer.substring(nlIndex + 1);
      if (line.trim() === "") continue;
      this.hooks.onLine(line);
    }
  }
}
