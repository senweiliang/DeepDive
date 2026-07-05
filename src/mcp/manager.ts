// The session-scoped MCP registry (TS side, built on the official SDK). Connects
// every configured server, freezes their tool schemas (prefix-cache stability),
// routes `mcp__server__tool` calls, and reports status for `/mcp`.
//
// Behavioral parity with deepdive-rs `mcp::manager` — internals differ (SDK vs
// hand-rolled) but config format, tool naming, and results match.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef } from "../tools/schema.js";
import type { McpServerConfig, McpServerStatus } from "./types.js";
import { sanitizeServerName } from "./index.js";

/** Per-server connect timeout (ms). */
const CONNECT_TIMEOUT_MS = 30_000;

interface McpTool {
  fullName: string;
  rawName: string;
  description: string;
  schema: ToolDef;
}

interface ConnectedServer {
  name: string;
  sanitized: string;
  transportKind: "stdio" | "http" | "sse";
  client: Client | null;
  tools: McpTool[];
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

function buildTransport(cfg: McpServerConfig): {
  transport: Transport;
  kind: "stdio" | "http" | "sse";
} {
  const t = cfg.transport;
  if (t.kind === "stdio") {
    return {
      kind: "stdio",
      transport: new StdioClientTransport({
        command: t.command,
        args: t.args,
        env: { ...getDefaultEnvironment(), ...t.env },
        stderr: "pipe",
      }),
    };
  }
  const url = new URL(t.url);
  const requestInit = { headers: t.headers };
  if (t.kind === "sse") {
    return { kind: "sse", transport: new SSEClientTransport(url, { requestInit }) };
  }
  return {
    kind: "http",
    transport: new StreamableHTTPClientTransport(url, { requestInit }),
  };
}

/** Flatten a tool-call result's content blocks into text + isError. */
function flattenResult(result: unknown): { content: string; isError: boolean } {
  const r = (result ?? {}) as Record<string, unknown>;
  const isError = r.isError === true;
  const parts: string[] = [];
  const content = r.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "image") parts.push("[image]");
      else if (b.type === "audio") parts.push("[audio]");
      else if (b.type === "resource") {
        const res = b.resource as Record<string, unknown> | undefined;
        if (res && typeof res.text === "string") parts.push(res.text);
        else parts.push(`[resource ${(res?.uri as string) ?? ""}]`);
      }
    }
  }
  if (parts.length === 0 && r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent));
  }
  return { content: parts.join("\n"), isError };
}

export class McpManager {
  private servers: ConnectedServer[] = [];
  private cachedSchemas: ToolDef[] | null = null;

  /** Connect to every configured server concurrently. Failures are captured
   * per-server (non-fatal). */
  static async connectAll(servers: McpServerConfig[]): Promise<McpManager> {
    const mgr = new McpManager();
    mgr.servers = await Promise.all(servers.map((s) => McpManager.connectOne(s)));
    return mgr;
  }

  private static async connectOne(cfg: McpServerConfig): Promise<ConnectedServer> {
    const sanitized = sanitizeServerName(cfg.name);
    let kind: "stdio" | "http" | "sse" = "stdio";
    try {
      const built = buildTransport(cfg);
      kind = built.kind;
      const client = new Client(
        { name: "deepdive", version: "0.1.0" },
        { capabilities: {} },
      );
      await withTimeout(client.connect(built.transport), CONNECT_TIMEOUT_MS, "connect");
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "tools/list");
      const tools: McpTool[] = (listed.tools ?? []).map((t) => {
        const fullName = `mcp__${sanitized}__${t.name}`;
        const parameters =
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} };
        return {
          fullName,
          rawName: t.name,
          description: t.description ?? "",
          schema: {
            type: "function",
            function: { name: fullName, description: t.description ?? "", parameters },
          },
        };
      });
      return { name: cfg.name, sanitized, transportKind: kind, client, tools };
    } catch (err) {
      return {
        name: cfg.name,
        sanitized,
        transportKind: kind,
        client: null,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  hasServers(): boolean {
    return this.servers.length > 0;
  }

  toolCount(): number {
    return this.servers.reduce((n, s) => n + s.tools.length, 0);
  }

  /** All discovered tool schemas, name-sorted for a byte-stable `tools` array.
   * Cached on first call (frozen for the session). */
  toolSchemas(): ToolDef[] {
    if (this.cachedSchemas === null) {
      this.cachedSchemas = this.servers
        .flatMap((s) => s.tools.map((t) => t.schema))
        .sort((a, b) => a.function.name.localeCompare(b.function.name));
    }
    return this.cachedSchemas;
  }

  /** Route an `mcp__server__tool` call. Matches on the full namespaced name. */
  async call(
    fullName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    for (const s of this.servers) {
      const tool = s.tools.find((t) => t.fullName === fullName);
      if (tool && s.client) {
        try {
          const result = await s.client.callTool({ name: tool.rawName, arguments: args });
          return flattenResult(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Error: MCP call failed: ${msg}`, isError: true };
        }
      }
    }
    return { content: `Unknown MCP tool: ${fullName}`, isError: true };
  }

  statuses(): McpServerStatus[] {
    return this.servers.map((s) => ({
      name: s.name,
      transport: s.transportKind,
      connected: s.client !== null,
      toolCount: s.tools.length,
      error: s.error,
    }));
  }

  /** Close every connection (kill subprocesses / drop streams). Best-effort. */
  async shutdown(): Promise<void> {
    await Promise.all(
      this.servers.map(async (s) => {
        try {
          await s.client?.close();
        } catch {
          // ignore
        }
      }),
    );
  }
}

// ── module singleton ─────────────────────────────────────────────────────────
// buildBody (client.ts) reads the frozen MCP schemas through this singleton so
// the tool list is assembled in one place without threading the manager everywhere.

let singleton: McpManager | null = null;

export function setMcpManager(mgr: McpManager): void {
  singleton = mgr;
}

export function getMcpManager(): McpManager | null {
  return singleton;
}

/** The frozen MCP tool schemas for the current session (empty if none). */
export function getMcpToolSchemas(): ToolDef[] {
  return singleton?.toolSchemas() ?? [];
}
