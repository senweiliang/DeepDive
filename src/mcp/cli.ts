// `deepdive mcp <sub>` — manage configured MCP servers from the command line.
//
// Parity with the Rust `deepdive-cli/mcp_cli.rs` and with Claude Code's
// `claude mcp add/list/get/remove`. Writes to the global
// `~/.deepdive/settings.json` `mcpServers` (scope `user`, default) or the
// project `<cwd>/.mcp.json` (scope `project`) — the two locations `loadConfig`
// reads and merges. No network, no API key; changes apply on the next launch.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOriginalCwd } from "../workspace.js";
import { loadMcpServersGlobalRaw, saveMcpServersGlobal } from "../config.js";
import type { McpTransportConfig } from "./types.js";

type Scope = "user" | "project";

/** Parse a `--scope` value. Strict: only `user`/`project` (no `local` alias,
 * to avoid clashing with Claude Code's distinct `local` scope). */
function parseScope(s: string): Scope | null {
  return s === "user" || s === "project" ? s : null;
}

function projectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

/** Read `<cwd>/.mcp.json` as an object ({} if absent/unreadable). */
function readProjectRoot(cwd: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(projectMcpPath(cwd), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Raw `mcpServers` object for one scope (empty if absent). */
export function readScopeServers(scope: Scope, cwd: string): Record<string, unknown> {
  const raw =
    scope === "user" ? loadMcpServersGlobalRaw() : readProjectRoot(cwd).mcpServers;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Persist the `mcpServers` object for one scope, preserving other fields. */
function writeScopeServers(
  scope: Scope,
  cwd: string,
  servers: Record<string, unknown>,
): void {
  if (scope === "user") {
    saveMcpServersGlobal(servers);
    return;
  }
  const root = readProjectRoot(cwd);
  root.mcpServers = servers;
  writeFileSync(projectMcpPath(cwd), JSON.stringify(root, null, 2), "utf-8");
}

/** Serialize a transport into the on-disk per-server JSON that `loadMcpServers`
 * reads back. Empty `env`/`headers` are omitted for a tidy file. */
export function transportToJson(t: McpTransportConfig): Record<string, unknown> {
  if (t.kind === "stdio") {
    const o: Record<string, unknown> = { command: t.command, args: t.args };
    if (Object.keys(t.env).length > 0) o.env = t.env;
    return o;
  }
  const o: Record<string, unknown> = { type: t.kind, url: t.url };
  if (Object.keys(t.headers).length > 0) o.headers = t.headers;
  return o;
}

/** Add (or overwrite) a server in `scope`; returns whether it replaced one. */
export function addServer(
  scope: Scope,
  cwd: string,
  name: string,
  t: McpTransportConfig,
): boolean {
  const servers = readScopeServers(scope, cwd);
  const existed = name in servers;
  servers[name] = transportToJson(t);
  writeScopeServers(scope, cwd, servers);
  return existed;
}

/** Remove a server from `scope`; returns whether it existed. */
export function removeServer(scope: Scope, cwd: string, name: string): boolean {
  const servers = readScopeServers(scope, cwd);
  if (!(name in servers)) return false;
  delete servers[name];
  writeScopeServers(scope, cwd, servers);
  return true;
}

// ── display helpers (operate on raw entries) ────────────────────────────────

function kindOf(entry: unknown): string {
  const e = entry as Record<string, unknown>;
  if (typeof e?.command === "string" && e.command) return "stdio";
  if (e?.type === "sse") return "sse";
  if (typeof e?.url === "string") return "http";
  return "?";
}

function targetOf(entry: unknown): string {
  const e = entry as Record<string, unknown>;
  if (typeof e?.command === "string" && e.command) {
    const args = Array.isArray(e.args) ? e.args.filter((x) => typeof x === "string") : [];
    return args.length ? `${e.command} ${args.join(" ")}` : String(e.command);
  }
  if (typeof e?.url === "string") return String(e.url);
  return "";
}

// ── CLI parsing / dispatch ──────────────────────────────────────────────────

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function errLine(s: string): void {
  process.stderr.write(s + "\n");
}
function fail(msg: string): number {
  errLine(`error: ${msg}`);
  return 1;
}

/** Split `KEY<sep>VALUE` on the first `sep`; key trimmed & non-empty. */
function splitKv(s: string, sep: string): [string, string] | null {
  const idx = s.indexOf(sep);
  if (idx < 0) return null;
  const key = s.slice(0, idx).trim();
  if (!key) return null;
  return [key, s.slice(idx + sep.length)];
}

/** Entry point. `argv` is everything after `mcp`. Returns the exit code. */
export function runMcpCli(argv: string[]): number {
  const cwd = getOriginalCwd();
  const sub = argv[0];
  switch (sub) {
    case "add":
      return cmdAdd(argv.slice(1), cwd);
    case "list":
    case "ls":
      return cmdList(cwd);
    case "get":
      return cmdGet(argv.slice(1), cwd);
    case "remove":
    case "rm":
      return cmdRemove(argv.slice(1), cwd);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    default:
      errLine(`error: unknown mcp subcommand: ${sub}`);
      printHelp();
      return 2;
  }
}

function cmdAdd(args: string[], cwd: string): number {
  let transport = "stdio";
  let scope: Scope = "user";
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const rest: string[] = [];
  let positionalOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (positionalOnly) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      positionalOnly = true;
    } else if (a === "-t" || a === "--transport") {
      const v = args[++i];
      if (v === undefined) return fail("missing value for --transport");
      transport = v;
    } else if (a === "-s" || a === "--scope") {
      const v = args[++i];
      const p = v ? parseScope(v) : null;
      if (!p) return fail(`invalid --scope: ${v ?? ""} (expected user or project)`);
      scope = p;
    } else if (a === "-e" || a === "--env") {
      const v = args[++i];
      const kv = v ? splitKv(v, "=") : null;
      if (!kv) return fail(`invalid --env (expected KEY=VALUE): ${v ?? ""}`);
      env[kv[0]] = kv[1];
    } else if (a === "-H" || a === "--header") {
      const v = args[++i];
      const kv = v ? splitKv(v, ":") : null;
      if (!kv) return fail(`invalid --header (expected 'Name: value'): ${v ?? ""}`);
      headers[kv[0]] = kv[1].trim();
    } else if (a.startsWith("-") && a.length > 1) {
      return fail(`unknown flag: ${a}`);
    } else {
      rest.push(a);
    }
  }

  const name = rest.shift();
  if (!name) return fail("missing <name>");

  let t: McpTransportConfig;
  if (transport === "stdio") {
    const command = rest.shift();
    if (!command) return fail("stdio transport requires a <command>");
    t = { kind: "stdio", command, args: rest, env };
  } else if (transport === "http") {
    const url = rest.shift();
    if (!url) return fail("http transport requires a <url>");
    t = { kind: "http", url, headers };
  } else if (transport === "sse") {
    const url = rest.shift();
    if (!url) return fail("sse transport requires a <url>");
    t = { kind: "sse", url, headers };
  } else {
    return fail(`invalid transport: ${transport} (expected stdio, http, or sse)`);
  }

  try {
    const replaced = addServer(scope, cwd, name, t);
    out(`${replaced ? "Updated" : "Added"} MCP server "${name}" (${transport}, scope: ${scope})`);
    return 0;
  } catch (e) {
    return fail(`failed to write config: ${(e as Error).message}`);
  }
}

function cmdList(cwd: string): number {
  const rows: [string, string, string, string][] = [];
  for (const scope of ["user", "project"] as Scope[]) {
    const servers = readScopeServers(scope, cwd);
    for (const name of Object.keys(servers).sort()) {
      rows.push([name, scope, kindOf(servers[name]), targetOf(servers[name])]);
    }
  }
  if (rows.length === 0) {
    out("No MCP servers configured. Add one with:");
    out("  deepdive mcp add <name> -- <command> [args...]");
    return 0;
  }
  // Column widths account for the header labels so nothing wraps under them.
  const header: [string, string, string, string] = ["NAME", "SCOPE", "TRANSPORT", "TARGET"];
  const w0 = Math.max(header[0].length, ...rows.map((r) => r[0].length));
  const w1 = Math.max(header[1].length, ...rows.map((r) => r[1].length));
  const w2 = Math.max(header[2].length, ...rows.map((r) => r[2].length));
  out(`${header[0].padEnd(w0)}  ${header[1].padEnd(w1)}  ${header[2].padEnd(w2)}  ${header[3]}`);
  for (const [n, s, k, tgt] of rows) {
    out(`${n.padEnd(w0)}  ${s.padEnd(w1)}  ${k.padEnd(w2)}  ${tgt}`);
  }
  return 0;
}

function cmdGet(args: string[], cwd: string): number {
  const name = args[0];
  if (!name) {
    errLine("usage: deepdive mcp get <name>");
    return 2;
  }
  for (const scope of ["user", "project"] as Scope[]) {
    const servers = readScopeServers(scope, cwd);
    if (name in servers) {
      const e = servers[name] as Record<string, unknown>;
      const lines = [`${name}:`, `  scope:     ${scope}`, `  transport: ${kindOf(e)}`];
      if (kindOf(e) === "stdio") {
        lines.push(`  command:   ${String(e.command)}`);
        const a = Array.isArray(e.args) ? e.args.filter((x) => typeof x === "string") : [];
        if (a.length) lines.push(`  args:      ${a.join(" ")}`);
        const env = e.env && typeof e.env === "object" ? (e.env as Record<string, string>) : {};
        for (const k of Object.keys(env).sort()) lines.push(`  env:       ${k}=${env[k]}`);
      } else {
        lines.push(`  url:       ${String(e.url)}`);
        const h =
          e.headers && typeof e.headers === "object" ? (e.headers as Record<string, string>) : {};
        for (const k of Object.keys(h).sort()) lines.push(`  header:    ${k}: ${h[k]}`);
      }
      out(lines.join("\n"));
      return 0;
    }
  }
  return fail(`no MCP server named "${name}"`);
}

function cmdRemove(args: string[], cwd: string): number {
  let scope: Scope | null = null;
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-s" || a === "--scope") {
      const v = args[++i];
      const p = v ? parseScope(v) : null;
      if (!p) {
        errLine("error: invalid or missing --scope (expected user or project)");
        return 2;
      }
      scope = p;
    } else if (a.startsWith("-") && a.length > 1) {
      errLine(`error: unknown flag: ${a}`);
      return 2;
    } else if (name === undefined) {
      name = a;
    }
  }
  if (!name) {
    errLine("usage: deepdive mcp remove [--scope user|project] <name>");
    return 2;
  }
  // No explicit scope → remove from wherever it's found (both scopes).
  const scopes: Scope[] = scope ? [scope] : ["user", "project"];
  let removed = false;
  for (const sc of scopes) {
    try {
      if (removeServer(sc, cwd, name)) {
        out(`Removed MCP server "${name}" (scope: ${sc})`);
        removed = true;
      }
    } catch (e) {
      return fail(`failed to write config: ${(e as Error).message}`);
    }
  }
  if (!removed) return fail(`no MCP server named "${name}"`);
  return 0;
}

function printHelp(): void {
  out(
    [
      "deepdive mcp — manage MCP servers",
      "",
      "Usage:",
      "  deepdive mcp add [options] <name> <command> [args...]   add a stdio server",
      "  deepdive mcp add --transport http <name> <url>          add a streamable-HTTP server",
      "  deepdive mcp add --transport sse  <name> <url>          add a legacy-SSE server",
      "  deepdive mcp list                                       list configured servers",
      "  deepdive mcp get <name>                                 show one server's config",
      "  deepdive mcp remove [--scope <s>] <name>                remove a server",
      "",
      "Options for `add`:",
      "  -t, --transport <stdio|http|sse>   transport type (default: stdio)",
      "  -s, --scope <user|project>         where to write (default: user)",
      "                                       user    → ~/.deepdive/settings.json",
      "                                       project → <cwd>/.mcp.json",
      "  -e, --env KEY=VALUE                stdio environment variable (repeatable)",
      '  -H, --header "Name: value"         http/sse request header (repeatable)',
      "  --                                 end of flags; everything after is command + args",
      "",
      "Examples:",
      "  deepdive mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp",
      "  deepdive mcp add --transport http --scope project ctx7 https://mcp.context7.com/mcp",
      '  deepdive mcp add --transport sse api https://example.com/sse -H "Authorization: Bearer TOKEN"',
      "",
      "Changes take effect the next time you launch deepdive.",
    ].join("\n"),
  );
}
