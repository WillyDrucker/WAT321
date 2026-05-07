import * as vscode from "vscode";

/**
 * SecretStorage wrapper for Model Bridge instance API keys.
 *
 * Cloud instances (`kind: "remote"`) carry an `apiKeyRef` field that
 * names a secret. The extension reads the resolved value via this
 * module at config-write time and embeds it in the atomic config file
 * channel.mjs reads. channel.mjs runs as a separate process spawned
 * by Claude Code and cannot reach VS Code's SecretStorage directly,
 * so the resolution has to happen extension-side and ride the same
 * config.json the rest of the bridge state ships in.
 *
 * NTFS ACL inheritance from the user profile gives `~/.wat321/` an
 * effective `0600` for the resolved-key file. Same posture as Codex
 * keeps its own credentials under `~/.codex/`.
 *
 * All Zen instances share one key (`wat321.modelBridge.zen.apiKey`);
 * any future remote provider with its own auth uses a distinct ref
 * value in its instance entry.
 */

export const ZEN_API_KEY_SECRET = "wat321.modelBridge.zen.apiKey";

/** Read a secret by ref. Returns undefined when not set. Never
 * throws - SecretStorage I/O failures degrade to "no key found",
 * which the bridge surfaces as a clean 401-style error to Claude. */
export async function readSecret(
  context: vscode.ExtensionContext,
  ref: string
): Promise<string | undefined> {
  try {
    return await context.secrets.get(ref);
  } catch {
    return undefined;
  }
}

/** Walk a list of unique apiKeyRef values and resolve each. Returns
 * a `{ref -> value}` map suitable for embedding in config.json. */
export async function resolveApiKeys(
  context: vscode.ExtensionContext,
  refs: readonly string[]
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(refs.filter((r) => r.length > 0)));
  const out: Record<string, string> = {};
  await Promise.all(
    unique.map(async (ref) => {
      const value = await readSecret(context, ref);
      if (value) out[ref] = value;
    })
  );
  return out;
}

/** Prompt the user for the Zen API key and store it. Used by both the
 * `wat321.modelBridge.setZenApiKey` command and the click-menu entry.
 * Echoes a redacted confirmation toast so the user knows the write
 * landed without revealing the secret. */
export async function promptAndStoreZenApiKey(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const existing = await readSecret(context, ZEN_API_KEY_SECRET);
  const placeholder = existing
    ? "Enter to keep current key, or paste a new one"
    : "Paste your OpenCode Zen API key (starts with `oc-`)";

  const value = await vscode.window.showInputBox({
    title: existing
      ? "Update OpenCode Zen API Key"
      : "Set OpenCode Zen API Key",
    prompt:
      "Get a key from https://opencode.ai/ -> Account -> API Keys. Stored in VS Code's SecretStorage (encrypted at rest via the OS keychain). Used by every Zen instance.",
    placeHolder: placeholder,
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (input.length === 0) return undefined;
      if (input.length < 16) return "Key looks too short - check the value.";
      return undefined;
    },
  });

  if (value === undefined) return false;
  if (value.length === 0) {
    if (existing) {
      vscode.window.showInformationMessage(
        "OpenCode Zen API key unchanged."
      );
    }
    return false;
  }

  await context.secrets.store(ZEN_API_KEY_SECRET, value);
  vscode.window.showInformationMessage(
    "OpenCode Zen API key stored. Cloud Model Bridge instances are now usable."
  );
  return true;
}

/** Drop the Zen key. Idempotent. Confirms first - clearing the key
 * leaves every Zen instance unable to call until you paste a new one. */
export async function clearZenApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Clear the OpenCode Zen API key? Every Zen instance (Big Pickle, GPT 5 Nano, Ling, Hy3, Nemotron, MiniMax M2.7) will report 'needs API key' until you set it again.",
    { modal: true },
    "Clear"
  );
  if (confirm !== "Clear") return;
  try {
    await context.secrets.delete(ZEN_API_KEY_SECRET);
    vscode.window.showInformationMessage(
      "OpenCode Zen API key cleared."
    );
  } catch {
    // SecretStorage absent or already empty - degrade silently.
  }
}
