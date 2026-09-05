import { extensionVersion } from "../../engine/extensionVersion";
import type { ResolvedCli } from "../../shared/providers/cliResolver";
import { AppServerClient } from "./appServerClient";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * Spawn a `codex app-server` child and complete the JSON-RPC
 * `initialize` handshake, the one way every WAT321 client comes up.
 * The dispatcher keeps its client warm across turns and the catalog
 * probe reaps its own after one `model/list`. Both come through here
 * so the client identity, the handshake, and the cold-start timing
 * log cannot drift apart.
 */
export async function spawnInitializedAppServer(
  logger: EpicHandshakeLogger,
  instanceId: string,
  resolved: ResolvedCli | null
): Promise<AppServerClient> {
  const spawnStart = Date.now();
  // The resolver prefers the binary bundled with the OpenAI Codex VS
  // Code extension and falls back to PATH, so users without a global
  // codex CLI still drive the bridge. Null leaves the client on its
  // default `codex` command.
  const client = new AppServerClient({
    logger,
    instanceId,
    executable: resolved?.command,
  });
  if (resolved !== null) {
    logger.info(
      `[client] codex binary resolved via ${resolved.source}: ${resolved.command}`
    );
  }
  client.spawn();
  const initStart = Date.now();
  try {
    await client.sendRequest("initialize", {
      clientInfo: {
        name: "wat321_bridge",
        title: "WAT321 Epic Handshake",
        version: extensionVersion(),
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
    });
  } catch (err) {
    // The caller never receives the client when the handshake fails,
    // so nothing else can reap the child. Kill it here or it outlives
    // the request as an orphaned codex process.
    client.forceKill();
    throw err;
  }
  const initEnd = Date.now();
  // `initialized` is a notification, no id
  client.sendNotification("initialized", {});
  logger.info(
    `[timing] app-server cold-start spawn_to_init=${initStart - spawnStart}ms initialize=${initEnd - initStart}ms total=${Date.now() - spawnStart}ms`
  );
  return client;
}
