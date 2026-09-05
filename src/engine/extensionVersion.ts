import * as vscode from "vscode";

/**
 * The installed WAT321 version, read from the manifest VS Code loaded
 * so no version literal lives in source. Protocol handshakes that
 * name their client (the Codex app-server `initialize`) send this.
 */

/** Marketplace identity, `publisher.name` from package.json. */
const EXTENSION_ID = "WillyDrucker.wat321";

export function extensionVersion(): string {
  const raw: unknown = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;
  return typeof raw === "string" ? raw : "unknown";
}
