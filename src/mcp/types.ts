// MCP server configuration types (parity with deepdive-rs mcp::config).

export type McpTransportConfig =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "sse"; url: string; headers: Record<string, string> };

/** One configured MCP server (data only — no live connection). */
export interface McpServerConfig {
  name: string;
  transport: McpTransportConfig;
}

/** One server's status line for the `/mcp` view. */
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  connected: boolean;
  toolCount: number;
  error?: string;
}
