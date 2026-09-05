/**
 * MCP tool result shapes. Every handler in the runtime returns one of
 * these two so the entry can pass results through untouched.
 */

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
