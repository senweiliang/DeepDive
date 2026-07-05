//! `deepdive mcp <sub>` — manage configured MCP servers from the command line.
//!
//! Parity with Claude Code's `claude mcp add/list/get/remove`. Writes to the
//! global `~/.deepdive/settings.json` `mcpServers` (scope `user`, the default)
//! or the project `<cwd>/.mcp.json` (scope `project`) — the same two locations
//! `Config::load` reads and merges. No network, no API key required; changes
//! take effect on the next `deepdive` launch.

use deepdive_core::mcp::{
    add_server, remove_server, scope_servers, McpScope, McpServerConfig, McpTransportConfig,
};
use std::collections::HashMap;
use std::path::Path;

/// Entry point. `argv` is everything after `mcp` (subcommand + its args).
/// Returns the process exit code.
pub fn run(argv: &[String]) -> i32 {
    let cwd = deepdive_core::workspace::original_cwd();
    match argv.first().map(String::as_str) {
        Some("add") => cmd_add(&argv[1..], &cwd),
        Some("list") | Some("ls") => cmd_list(&cwd),
        Some("get") => cmd_get(&argv[1..], &cwd),
        Some("remove") | Some("rm") => cmd_remove(&argv[1..], &cwd),
        None | Some("-h") | Some("--help") | Some("help") => {
            print_help();
            0
        }
        Some(other) => {
            eprintln!("error: unknown mcp subcommand: {other}");
            print_help();
            2
        }
    }
}

fn err(msg: impl std::fmt::Display) -> i32 {
    eprintln!("error: {msg}");
    1
}

/// Consume the argument following a flag at `*i`, advancing `*i` past it.
fn next_val(args: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    *i += 1;
    args.get(*i)
        .cloned()
        .ok_or_else(|| format!("missing value for {flag}"))
}

/// Split `KEY<sep>VALUE` on the first `sep`. Key is trimmed and must be
/// non-empty; the value is returned verbatim (caller trims if desired).
fn split_kv(s: &str, sep: char) -> Option<(String, String)> {
    let idx = s.find(sep)?;
    let key = s[..idx].trim().to_string();
    if key.is_empty() {
        return None;
    }
    Some((key, s[idx + sep.len_utf8()..].to_string()))
}

fn cmd_add(args: &[String], cwd: &Path) -> i32 {
    match try_add(args, cwd) {
        Ok(msg) => {
            println!("{msg}");
            0
        }
        Err(e) => err(e),
    }
}

fn try_add(args: &[String], cwd: &Path) -> Result<String, String> {
    let mut transport: Option<String> = None;
    let mut scope = McpScope::User;
    let mut env: HashMap<String, String> = HashMap::new();
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut rest: Vec<String> = Vec::new();
    let mut positional_only = false;

    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if positional_only {
            rest.push(args[i].clone());
            i += 1;
            continue;
        }
        match a {
            "--" => positional_only = true,
            "-t" | "--transport" => transport = Some(next_val(args, &mut i, "--transport")?),
            "-s" | "--scope" => {
                let v = next_val(args, &mut i, "--scope")?;
                scope = McpScope::parse(&v)
                    .ok_or_else(|| format!("invalid --scope: {v} (expected user or project)"))?;
            }
            "-e" | "--env" => {
                let v = next_val(args, &mut i, "--env")?;
                let (k, val) = split_kv(&v, '=')
                    .ok_or_else(|| format!("invalid --env (expected KEY=VALUE): {v}"))?;
                env.insert(k, val);
            }
            "-H" | "--header" => {
                let v = next_val(args, &mut i, "--header")?;
                let (k, val) = split_kv(&v, ':')
                    .ok_or_else(|| format!("invalid --header (expected 'Name: value'): {v}"))?;
                headers.insert(k, val.trim().to_string());
            }
            s if s.starts_with('-') && s.len() > 1 => return Err(format!("unknown flag: {s}")),
            _ => rest.push(args[i].clone()),
        }
        i += 1;
    }

    let mut rest = rest.into_iter();
    let name = rest.next().ok_or("missing <name>")?;
    if name.is_empty() {
        return Err("server name cannot be empty".into());
    }

    let kind = transport.as_deref().unwrap_or("stdio");
    let transport = match kind {
        "stdio" => {
            let command = rest.next().ok_or("stdio transport requires a <command>")?;
            McpTransportConfig::Stdio {
                command,
                args: rest.collect(),
                env,
            }
        }
        "http" => {
            let url = rest.next().ok_or("http transport requires a <url>")?;
            McpTransportConfig::Http { url, headers }
        }
        "sse" => {
            let url = rest.next().ok_or("sse transport requires a <url>")?;
            McpTransportConfig::Sse { url, headers }
        }
        other => {
            return Err(format!(
                "invalid transport: {other} (expected stdio, http, or sse)"
            ))
        }
    };

    let cfg = McpServerConfig {
        name: name.clone(),
        transport,
    };
    let replaced = add_server(scope, cwd, &cfg).map_err(|e| format!("failed to write config: {e}"))?;
    let verb = if replaced { "Updated" } else { "Added" };
    Ok(format!(
        "{verb} MCP server \"{name}\" ({kind}, scope: {})",
        scope.as_str()
    ))
}

fn transport_kind(t: &McpTransportConfig) -> &'static str {
    match t {
        McpTransportConfig::Stdio { .. } => "stdio",
        McpTransportConfig::Http { .. } => "http",
        McpTransportConfig::Sse { .. } => "sse",
    }
}

fn transport_target(t: &McpTransportConfig) -> String {
    match t {
        McpTransportConfig::Stdio { command, args, .. } => {
            if args.is_empty() {
                command.clone()
            } else {
                format!("{command} {}", args.join(" "))
            }
        }
        McpTransportConfig::Http { url, .. } | McpTransportConfig::Sse { url, .. } => url.clone(),
    }
}

fn cmd_list(cwd: &Path) -> i32 {
    // (name, scope, kind, target) rows across both scopes.
    let mut rows: Vec<(String, &'static str, &'static str, String)> = Vec::new();
    for scope in [McpScope::User, McpScope::Project] {
        for s in scope_servers(scope, cwd) {
            rows.push((
                s.name.clone(),
                scope.as_str(),
                transport_kind(&s.transport),
                transport_target(&s.transport),
            ));
        }
    }
    if rows.is_empty() {
        println!("No MCP servers configured. Add one with:");
        println!("  deepdive mcp add <name> -- <command> [args...]");
        return 0;
    }
    // Column widths account for the header labels so nothing wraps under them.
    let (h_name, h_scope, h_kind, h_target) = ("NAME", "SCOPE", "TRANSPORT", "TARGET");
    let w_name = rows.iter().map(|r| r.0.len()).max().unwrap_or(0).max(h_name.len());
    let w_scope = rows.iter().map(|r| r.1.len()).max().unwrap_or(0).max(h_scope.len());
    let w_kind = rows.iter().map(|r| r.2.len()).max().unwrap_or(0).max(h_kind.len());
    println!("{h_name:<w_name$}  {h_scope:<w_scope$}  {h_kind:<w_kind$}  {h_target}");
    for (name, scope, kind, target) in rows {
        println!("{name:<w_name$}  {scope:<w_scope$}  {kind:<w_kind$}  {target}");
    }
    0
}

fn cmd_get(args: &[String], cwd: &Path) -> i32 {
    let Some(name) = args.first() else {
        eprintln!("usage: deepdive mcp get <name>");
        return 2;
    };
    for scope in [McpScope::User, McpScope::Project] {
        let Some(s) = scope_servers(scope, cwd).into_iter().find(|s| &s.name == name) else {
            continue;
        };
        println!("{name}:");
        println!("  scope:     {}", scope.as_str());
        println!("  transport: {}", transport_kind(&s.transport));
        match &s.transport {
            McpTransportConfig::Stdio { command, args, env } => {
                println!("  command:   {command}");
                if !args.is_empty() {
                    println!("  args:      {}", args.join(" "));
                }
                for (k, v) in sorted_pairs(env) {
                    println!("  env:       {k}={v}");
                }
            }
            McpTransportConfig::Http { url, headers }
            | McpTransportConfig::Sse { url, headers } => {
                println!("  url:       {url}");
                for (k, v) in sorted_pairs(headers) {
                    println!("  header:    {k}: {v}");
                }
            }
        }
        return 0;
    }
    err(format!("no MCP server named \"{name}\""))
}

/// Deterministic ordering for a `HashMap`'s entries (display only).
fn sorted_pairs(m: &HashMap<String, String>) -> Vec<(&String, &String)> {
    let mut v: Vec<_> = m.iter().collect();
    v.sort_by(|a, b| a.0.cmp(b.0));
    v
}

fn cmd_remove(args: &[String], cwd: &Path) -> i32 {
    let mut scope: Option<McpScope> = None;
    let mut name: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-s" | "--scope" => {
                i += 1;
                match args.get(i).and_then(|s| McpScope::parse(s)) {
                    Some(sc) => scope = Some(sc),
                    None => {
                        eprintln!("error: invalid or missing --scope (expected user or project)");
                        return 2;
                    }
                }
            }
            s if s.starts_with('-') && s.len() > 1 => {
                eprintln!("error: unknown flag: {s}");
                return 2;
            }
            _ => {
                if name.is_none() {
                    name = Some(args[i].clone());
                }
            }
        }
        i += 1;
    }
    let Some(name) = name else {
        eprintln!("usage: deepdive mcp remove [--scope user|project] <name>");
        return 2;
    };

    // No explicit scope → remove from wherever it's found (both scopes).
    let scopes: &[McpScope] = match &scope {
        Some(s) => std::slice::from_ref(s),
        None => &[McpScope::User, McpScope::Project],
    };
    let mut removed = false;
    for &sc in scopes {
        match remove_server(sc, cwd, &name) {
            Ok(true) => {
                println!("Removed MCP server \"{name}\" (scope: {})", sc.as_str());
                removed = true;
            }
            Ok(false) => {}
            Err(e) => return err(format!("failed to write config: {e}")),
        }
    }
    if !removed {
        return err(format!("no MCP server named \"{name}\""));
    }
    0
}

fn print_help() {
    let text = r#"deepdive mcp — manage MCP servers

Usage:
  deepdive mcp add [options] <name> <command> [args...]   add a stdio server
  deepdive mcp add --transport http <name> <url>          add a streamable-HTTP server
  deepdive mcp add --transport sse  <name> <url>          add a legacy-SSE server
  deepdive mcp list                                       list configured servers
  deepdive mcp get <name>                                 show one server's config
  deepdive mcp remove [--scope <s>] <name>                remove a server

Options for `add`:
  -t, --transport <stdio|http|sse>   transport type (default: stdio)
  -s, --scope <user|project>         where to write (default: user)
                                       user    → ~/.deepdive/settings.json
                                       project → <cwd>/.mcp.json
  -e, --env KEY=VALUE                stdio environment variable (repeatable)
  -H, --header "Name: value"         http/sse request header (repeatable)
  --                                 end of flags; everything after is command + args

Examples:
  deepdive mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp
  deepdive mcp add --transport http --scope project ctx7 https://mcp.context7.com/mcp
  deepdive mcp add --transport sse api https://example.com/sse -H "Authorization: Bearer TOKEN"

Changes take effect the next time you launch deepdive."#;
    println!("{text}");
}
