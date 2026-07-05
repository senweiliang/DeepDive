import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeServerName,
  namespacedToolName,
  parseToolName,
  isMcpTool,
} from "../mcp/index.js";
import { loadMcpServers } from "../mcp/config.js";
import { McpManager } from "../mcp/manager.js";

describe("mcp namespacing", () => {
  it("round-trips server/tool names", () => {
    expect(namespacedToolName("github", "create_issue")).toBe(
      "mcp__github__create_issue",
    );
    expect(parseToolName("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
  });

  it("preserves a tool name containing __", () => {
    expect(parseToolName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
  });

  it("sanitizes and collapses server names", () => {
    expect(sanitizeServerName("my server")).toBe("my_server");
    expect(sanitizeServerName("a__b")).toBe("a_b");
    expect(sanitizeServerName("weird!!name")).toBe("weird_name");
    expect(sanitizeServerName("_leading_")).toBe("leading");
  });

  it("rejects non-mcp and malformed names", () => {
    expect(parseToolName("read_file")).toBeNull();
    expect(parseToolName("mcp__onlyserver")).toBeNull();
    expect(parseToolName("mcp____tool")).toBeNull();
    expect(isMcpTool("mcp__x__y")).toBe(true);
    expect(isMcpTool("bash")).toBe(false);
  });
});

describe("mcp config loading", () => {
  it("parses stdio / http / sse and drops invalid entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-mcp-cfg-"));
    const global = {
      fs: { command: "npx", args: ["-y", "@mcp/fs", "/tmp"], env: { K: "V" } },
      http: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
      sse: { type: "sse", url: "https://x/sse" },
      defaultRemote: { url: "https://y/mcp" },
      bad: { nonsense: true },
    };
    const servers = loadMcpServers(global, dir);
    rmSync(dir, { recursive: true, force: true });
    const get = (name: string) => servers.find((s) => s.name === name)!;
    expect(servers.length).toBe(4); // "bad" dropped
    expect(get("fs").transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@mcp/fs", "/tmp"],
      env: { K: "V" },
    });
    expect(get("http").transport.kind).toBe("http");
    expect(get("sse").transport.kind).toBe("sse");
    expect(get("defaultRemote").transport.kind).toBe("http"); // url, no type → http
  });

  it("project .mcp.json overrides same-named global entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-mcp-proj-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "project-cmd" } } }),
    );
    const servers = loadMcpServers({ fs: { command: "global-cmd" }, keep: { command: "g" } }, dir);
    rmSync(dir, { recursive: true, force: true });
    const fs = servers.find((s) => s.name === "fs")!;
    expect(fs.transport).toMatchObject({ kind: "stdio", command: "project-cmd" });
    expect(servers.some((s) => s.name === "keep")).toBe(true);
  });
});

// ── end-to-end: spawn a minimal Node MCP server over stdio ────────────────────

const MOCK_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o)+'\\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2025-06-18', capabilities:{}, serverInfo:{ name:'mock', version:'0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'echo', description:'Echo', inputSchema:{ type:'object', properties:{ text:{ type:'string' } }, required:['text'] } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:'echo: ' + ((m.params&&m.params.arguments&&m.params.arguments.text)||'') }], isError:false } });
  else if (m.id !== undefined) send({ jsonrpc:'2.0', id:m.id, error:{ code:-32601, message:'method not found' } });
});
`;

describe("mcp stdio end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-mcp-e2e-"));
  const script = join(dir, "mock_server.cjs");
  writeFileSync(script, MOCK_SERVER);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("connects, discovers, and calls a tool", async () => {
    const mgr = await McpManager.connectAll([
      { name: "mock", transport: { kind: "stdio", command: "node", args: [script], env: {} } },
    ]);
    try {
      const statuses = mgr.statuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({ connected: true, toolCount: 1, transport: "stdio" });

      const schemas = mgr.toolSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0]!.function.name).toBe("mcp__mock__echo");

      const result = await mgr.call("mcp__mock__echo", { text: "hi" });
      expect(result).toEqual({ content: "echo: hi", isError: false });

      const missing = await mgr.call("mcp__mock__nope", {});
      expect(missing.isError).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  }, 20_000);
});
