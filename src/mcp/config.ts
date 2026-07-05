// Parse `mcpServers` from global settings + a project-root `.mcp.json`, then
// merge (project overrides same name). Faithful parity with the Rust
// `mcp::config::load_mcp_servers`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig, McpTransportConfig } from "./types.js";

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

/** Parse one server entry into a transport (null if neither command nor url). */
function parseTransport(entry: unknown): McpTransportConfig | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const command = typeof e.command === "string" ? e.command : "";
  if (command) {
    return { kind: "stdio", command, args: strArray(e.args), env: strMap(e.env) };
  }
  const url = typeof e.url === "string" ? e.url : "";
  if (!url) return null;
  const headers = strMap(e.headers);
  // Default remote transport is streamable HTTP; `"type":"sse"` selects legacy.
  return e.type === "sse"
    ? { kind: "sse", url, headers }
    : { kind: "http", url, headers };
}

/** Parse an `mcpServers` object into name→config entries, mutating `out`. */
function parseServersObject(obj: unknown, out: Map<string, McpServerConfig>): void {
  if (!obj || typeof obj !== "object") return;
  for (const [name, entry] of Object.entries(obj as Record<string, unknown>)) {
    if (!name) continue;
    const transport = parseTransport(entry);
    if (transport) out.set(name, { name, transport });
  }
}

/** Read `<cwd>/.mcp.json` and return its `mcpServers` object, if any. */
function readProjectMcpJson(cwd: string): unknown {
  try {
    const raw = readFileSync(join(cwd, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers;
  } catch {
    return undefined;
  }
}

/**
 * Load and merge MCP server configs. `globalMcp` is the `mcpServers` value from
 * `~/.deepdive/settings.json`; the project `<cwd>/.mcp.json` overrides same-named
 * entries. Returns a deterministic, name-sorted list.
 */
export function loadMcpServers(globalMcp: unknown, cwd: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  parseServersObject(globalMcp, merged);
  parseServersObject(readProjectMcpJson(cwd), merged);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
