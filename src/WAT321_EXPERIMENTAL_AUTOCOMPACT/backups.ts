import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAutoCompactOverride } from "../shared/claudeSettings";

/**
 * Backup storage for the experimental Force Claude Auto-Compact
 * recovery chain. Two tiers:
 *
 *   - Install snapshot: captured once on first activation that sees a
 *     clean settings.json. Never overwritten after initial capture.
 *     Final tier in the heal precedence chain.
 *
 *   - Arm backup ring (3 entries): rotated on every arm. The oldest
 *     is evicted each rotation. Second tier in the heal precedence
 *     chain so a crash mid-arm can still be recovered even if the
 *     sentinel is missing or corrupt.
 *
 * Poison invariant: no file in either tier ever contains the armed
 * value "1". Any attempt to capture a poisoned value fails silently;
 * the caller's heal path handles the stuck state on its own. This
 * prevents a second crash from re-recording "1" as the "original" and
 * trapping the user permanently.
 */

/** The override value WAT321 writes while armed. */
export const ARMED_OVERRIDE_VALUE = "1";

const WAT321_DIR = join(homedir(), ".wat321");

export const INSTALL_SNAPSHOT_PATH = join(
  WAT321_DIR,
  "settings-install-snapshot.json"
);

const ARM_BACKUP_RING_PATHS: readonly string[] = [
  join(WAT321_DIR, "settings-arm-backup-1.json"),
  join(WAT321_DIR, "settings-arm-backup-2.json"),
  join(WAT321_DIR, "settings-arm-backup-3.json"),
];

interface BackupEntry {
  version: 1;
  capturedAt: number;
  originalOverride: string | null;
}

function ensureDir(): void {
  try {
    if (!existsSync(WAT321_DIR)) mkdirSync(WAT321_DIR, { recursive: true });
  } catch {
    // best-effort
  }
}

function writeBackupFile(path: string, override: string | null): boolean {
  if (override === ARMED_OVERRIDE_VALUE) return false;
  try {
    ensureDir();
    const entry: BackupEntry = {
      version: 1,
      capturedAt: Date.now(),
      originalOverride: override,
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function readBackupFile(path: string): BackupEntry | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BackupEntry>;
    if (parsed.version !== 1) return null;
    if (!("originalOverride" in parsed)) return null;
    const candidate =
      parsed.originalOverride === undefined ? null : parsed.originalOverride;
    if (candidate === ARMED_OVERRIDE_VALUE) return null;
    return {
      version: 1,
      capturedAt: typeof parsed.capturedAt === "number" ? parsed.capturedAt : 0,
      originalOverride: candidate,
    };
  } catch {
    return null;
  }
}

/**
 * Capture the install snapshot if and only if no snapshot file exists
 * yet, settings.json is readable, and the current override is not the
 * armed value. Safe to call on every start(). The poison check is
 * critical: if the user closes VS Code stuck at "1", reopens on a
 * fresh install, and this runs before heal, we must refuse to capture
 * so heal has a clean chain to fall back on.
 */
export function maybeCaptureInstallSnapshot(): void {
  if (existsSync(INSTALL_SNAPSHOT_PATH)) return;
  const read = readAutoCompactOverride();
  if (read.kind !== "present") return;
  if (read.value === ARMED_OVERRIDE_VALUE) return;
  writeBackupFile(INSTALL_SNAPSHOT_PATH, read.value);
}

export function readInstallSnapshotOverride(): string | null {
  const entry = readBackupFile(INSTALL_SNAPSHOT_PATH);
  return entry ? entry.originalOverride : null;
}

/**
 * Rotate the arm backup ring: shift slot 1 -> 2 and 0 -> 1, evict the
 * old slot 2, write the new entry into slot 0. Poisoned values ("1")
 * are refused and leave the ring untouched so a re-arm during a stuck
 * state cannot overwrite a good entry with a bad one.
 */
export function rotateArmBackup(override: string | null): boolean {
  if (override === ARMED_OVERRIDE_VALUE) return false;
  try {
    ensureDir();
    for (let i = ARM_BACKUP_RING_PATHS.length - 1; i >= 1; i--) {
      const src = ARM_BACKUP_RING_PATHS[i - 1];
      const dst = ARM_BACKUP_RING_PATHS[i];
      if (!existsSync(src)) continue;
      try {
        const bytes = readFileSync(src);
        const tmp = `${dst}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, dst);
      } catch {
        // best-effort - keep rotating
      }
    }
    return writeBackupFile(ARM_BACKUP_RING_PATHS[0], override);
  } catch {
    return false;
  }
}

export function readNewestArmBackupOverride(): string | null {
  for (const p of ARM_BACKUP_RING_PATHS) {
    const entry = readBackupFile(p);
    if (entry) return entry.originalOverride;
  }
  return null;
}

/** Delete every arm backup ring entry. Install snapshot untouched.
 * Called by Reset WAT321 before it wipes `~/.wat321/`. */
export function clearArmBackupRing(): void {
  for (const p of ARM_BACKUP_RING_PATHS) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

/** Read install snapshot bytes verbatim so Reset can preserve the
 * file across a recursive wipe of `~/.wat321/`. Returns `null` if
 * missing or unreadable. */
export function readInstallSnapshotBytes(): Buffer | null {
  try {
    if (!existsSync(INSTALL_SNAPSHOT_PATH)) return null;
    return readFileSync(INSTALL_SNAPSHOT_PATH);
  } catch {
    return null;
  }
}

/** Rehydrate the install snapshot from preserved bytes after Reset
 * wipes the directory. Best-effort; a failed rewrite just means the
 * next clean start() will re-capture from the healed settings. */
export function writeInstallSnapshotBytes(bytes: Buffer): void {
  try {
    ensureDir();
    const tmp = `${INSTALL_SNAPSHOT_PATH}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, INSTALL_SNAPSHOT_PATH);
  } catch {
    // best-effort
  }
}
