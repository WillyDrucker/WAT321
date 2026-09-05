/**
 * Bridge-reply decoration. Wraps the alias-driven `wat321_ask`
 * handler results so the user can read both what was asked and what
 * was answered even when the host IDE collapses the MCP tool-call
 * input panel into a single OUT row. Pure: no I/O, no shared state.
 *
 * Cap on prompt echo keeps Claude's reasoning context bounded - long
 * code-review prompts add at most PROMPT_ECHO_MAX chars of overhead
 * to the response, not the full prompt body.
 */

const PROMPT_ECHO_MAX = 500;

/** Prefix a successful wat321_ask result with the prompt rendered as
 * a markdown blockquote. Multi-line prompts get a `>` per line so
 * markdown renders the whole question as one blockquote. Errors and
 * session-retrieval calls (empty prompt) pass through unchanged. */
export function decorateAskResult(result, args, target) {
  if (result?.isError) return result;
  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.trim().length === 0) return result;
  if (
    !Array.isArray(result?.content) ||
    result.content.length === 0 ||
    result.content[0]?.type !== "text"
  ) {
    return result;
  }
  const aliasLabel = friendlyAskAlias(args, target);
  const truncated =
    prompt.length > PROMPT_ECHO_MAX
      ? `${prompt.slice(0, PROMPT_ECHO_MAX).trimEnd()}...`
      : prompt;
  const lines = truncated.split(/\r?\n/);
  const head = lines[0] ?? "";
  const tail = lines.slice(1);
  const quoted =
    tail.length === 0
      ? `> **${aliasLabel}:** ${head}`
      : [`> **${aliasLabel}:** ${head}`, ...tail.map((l) => `> ${l}`)].join(
          "\n"
        );
  const decorated = `${quoted}\n\n${result.content[0].text}`;
  return {
    ...result,
    content: [
      { type: "text", text: decorated },
      ...result.content.slice(1),
    ],
  };
}

/** Resolve the user-facing alias label for the prefix line. Prefer
 * what Claude actually said in the call, and fall back to a sensible
 * default tied to the resolved target. */
function friendlyAskAlias(args, target) {
  const raw = typeof args?.alias === "string" ? args.alias.trim() : "";
  if (raw.length > 0) return raw;
  if (target === "codex") return "Codex";
  if (target === "local") return "Local LLM";
  return "OpenCode";
}
