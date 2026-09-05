import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderKey } from "../../engine/contracts";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { clientStateDir } from "../../engine/wat321Paths";

/**
 * Persistent last-known-good store for the usage widgets at
 * `~/.wat321/clients/<wsId>/usage-snapshot.json`. Widgets hydrate on
 * construction, persist on every ok update, and clear per-provider
 * on identity-changing states. Schema is versioned so a future
 * shape change can ignore old snapshots instead of crashing.
 */

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILENAME = "usage-snapshot.json";

interface SnapshotFile {
  version: number;
  claude?: { payload: unknown; fetchedAt: number };
  codex?: { payload: unknown; fetchedAt: number };
}

function snapshotPath(): string {
  return join(clientStateDir(), SNAPSHOT_FILENAME);
}

function readFile(): SnapshotFile | null {
  const path = snapshotPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Load the persisted last-known-good payload for a provider, or null
 * when nothing is on disk. Returns the payload plus its fetched-at
 * wall-clock so the widget can render "Last updated N ago" without
 * needing to refetch. Lossy on any read or schema error - the widget
 * falls through to its 0% scaffold when this returns null. */
export function loadSnapshot<TData>(
  provider: ProviderKey
): { data: TData; fetchedAt: number } | null {
  const file = readFile();
  if (!file) return null;
  const slot = file[provider];
  if (!slot) return null;
  return {
    data: slot.payload as TData,
    fetchedAt: typeof slot.fetchedAt === "number" ? slot.fetchedAt : Date.now(),
  };
}

/** Persist a provider's last-known-good payload. Atomic tmp+rename
 * so a partial write never corrupts the file. Best-effort: a failed
 * write costs one cache hit on the next restart, never blocks the
 * widget's foreground render. */
export function saveSnapshot(
  provider: ProviderKey,
  payload: unknown,
  fetchedAt: number
): void {
  const current = readFile() ?? { version: SNAPSHOT_VERSION };
  current.version = SNAPSHOT_VERSION;
  current[provider] = { payload, fetchedAt };
  try {
    writeFileAtomic(snapshotPath(), JSON.stringify(current));
  } catch {
    // best-effort
  }
}

/** Clear a single provider's persisted snapshot. Called by the
 * widget on identity-changing service states (sign-out,
 * disconnect) so a subsequent VS Code restart cannot hydrate the
 * prior account's bars. token-expired is deliberately NOT in that
 * caller branch - the OAuth access token rotates inside the same
 * account, so the snapshot survives the refresh window and the
 * widget keeps showing cached bars under the dim skin until the
 * token recovers. Sibling provider's slot stays intact. Atomic
 * rewrite of the remaining slots. Best-effort: a failed clear means
 * the next restart shows one stale frame before the live service
 * overwrites it. */
export function clearProviderSnapshot(provider: ProviderKey): void {
  const current = readFile();
  if (!current) return;
  if (current[provider] === undefined) return;
  delete current[provider];
  try {
    writeFileAtomic(snapshotPath(), JSON.stringify(current));
  } catch {
    // best-effort
  }
}

