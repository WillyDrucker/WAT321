import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Tier contract, enforced. Tools stand on engine and shared, shared
// stands on engine, engine stands on nothing above it, and no tool
// reaches into another tool. The composition roots `extension.ts` and
// `bootstrap.ts` are the only files that may import from every tier.
// The bridge runtime under `WAT321_MCP_SERVER/bin/` is plain ESM that
// runs in a separate Node process and imports only its own siblings.
const TOOL_DIRS = [
  "WAT321_CLAUDE_SESSION_TOKENS",
  "WAT321_CLAUDE_USAGE_5H",
  "WAT321_CLAUDE_USAGE_ERROR",
  "WAT321_CLAUDE_USAGE_WEEKLY",
  "WAT321_CODEX_SESSION_TOKENS",
  "WAT321_CODEX_USAGE_5H",
  "WAT321_CODEX_USAGE_ERROR",
  "WAT321_CODEX_USAGE_WEEKLY",
  "WAT321_EPIC_HANDSHAKE",
  "WAT321_MCP_SERVER",
  "WAT321_OPENCODE_ROUTES",
];
const COMPOSITION_ROOTS = ["**/extension", "**/bootstrap"];

function forbidImports(group, message) {
  return {
    "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
  };
}

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Type safety
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",

      // Code quality
      "no-console": "error",
      "no-debugger": "error",
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    files: ["src/engine/**/*.ts"],
    rules: forbidImports(
      ["**/shared", "**/shared/**", "**/WAT321_*", "**/WAT321_*/**", ...COMPOSITION_ROOTS],
      "engine imports engine only. Promote the dependency into engine or inject it as a probe."
    ),
  },
  {
    files: ["src/shared/**/*.ts"],
    rules: forbidImports(
      ["**/WAT321_*", "**/WAT321_*/**", ...COMPOSITION_ROOTS],
      "shared never imports a tool tier. Cross-tier state crosses through engine events or injected probes."
    ),
  },
  ...TOOL_DIRS.map((dir) => ({
    files: [`src/${dir}/**/*.ts`],
    rules: forbidImports(
      [
        ...TOOL_DIRS.filter((other) => other !== dir).flatMap((other) => [`**/${other}`, `**/${other}/**`]),
        ...COMPOSITION_ROOTS,
      ],
      "a tool never imports another tool. Route through engine or a VS Code command."
    ),
  })),
  {
    files: ["src/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // stdout is the MCP transport for the bridge runtime, so a stray
      // console call corrupts the JSON-RPC stream.
      "no-console": "error",
      "no-debugger": "error",
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["out/**", "node_modules/**"],
  },
];
