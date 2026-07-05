// MCP tool-name namespacing (`mcp__<server>__<tool>`) — parity with the Rust
// `mcp::protocol`. Shared with Claude Code's scheme.

export const MCP_TOOL_PREFIX = "mcp__";

export type { McpServerConfig, McpServerStatus, McpTransportConfig } from "./types.js";
export { loadMcpServers } from "./config.js";
export { McpManager } from "./manager.js";

/**
 * Sanitize a server name for use inside a tool name: keep `[A-Za-z0-9_-]`,
 * everything else → `_`, collapse the `__` separator, trim leading/trailing `_`.
 */
export function sanitizeServerName(name: string): string {
  let s = name.replace(/[^A-Za-z0-9-]/g, "_");
  while (s.includes("__")) s = s.replace(/__/g, "_");
  return s.replace(/^_+|_+$/g, "");
}

/** Model-facing namespaced tool name: `mcp__<server>__<tool>`. */
export function namespacedToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeServerName(server)}__${tool}`;
}

/**
 * Reverse `mcp__<server>__<tool>` → `{ server, tool }`. Splits on the FIRST `__`
 * after the prefix so a tool name that itself contains `__` is preserved.
 * Returns null for a non-MCP name.
 */
export function parseToolName(full: string): { server: string; tool: string } | null {
  if (!full.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = full.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return null;
  const server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Whether a tool name is an MCP tool. */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}
