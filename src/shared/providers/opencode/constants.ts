/**
 * OpenCode-related constants shared by the catalog (pure data) and
 * the SecretStorage runtime in the Routes tier. Splitting the
 * constant from the runtime keeps `catalog.ts` free of any VS Code
 * dependency so it remains importable from non-extension contexts.
 */

export const ZEN_API_KEY_SECRET = "wat321.modelBridge.zen.apiKey";
