import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex's own state under `~/.codex/`. WAT321 reads these paths on
 * every poll and never writes to them, with one exception: the
 * session-delete commands in `WAT321_EPIC_HANDSHAKE/repair/` unlink
 * rollouts and strip the index after the user confirms.
 */

export const CODEX_HOME_DIR = join(homedir(), ".codex");
/** OAuth tokens the usage service sends to the ChatGPT backend. */
export const CODEX_AUTH_PATH = join(CODEX_HOME_DIR, "auth.json");
/** Rollouts, one `.jsonl` per session under `YYYY/MM/DD/`. */
export const CODEX_SESSIONS_DIR = join(CODEX_HOME_DIR, "sessions");
/** One line per session with its thread name. Codex never removes an
 * entry when a session is deleted, so readers re-check the rollout. */
export const CODEX_SESSION_INDEX_PATH = join(CODEX_HOME_DIR, "session_index.jsonl");
/** The model catalog the last codex binary to run was served. */
export const CODEX_MODELS_CACHE_PATH = join(CODEX_HOME_DIR, "models_cache.json");
