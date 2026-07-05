//! MCP server configuration — parse `mcpServers` from the global settings flat
//! key and from a project-root `.mcp.json`, then merge (project overrides same
//! name). Mirrors Claude Code's config shape.
//!
//! Per-server shape (transport inferred):
//! ```jsonc
//! {
//!   "filesystem": { "command": "npx", "args": ["-y","@mcp/fs","/tmp"], "env": {} },
//!   "remote":     { "type": "http", "url": "https://x/mcp", "headers": {} },
//!   "legacy":     { "type": "sse",  "url": "https://x/sse" }
//! }
//! ```
//! `command` present → stdio; else `type` (`http`|`sse`) + `url`.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One configured MCP server (data only — no live connection).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransportConfig,
}

/// How to reach a server. `Stdio` spawns a subprocess; `Http`/`Sse` connect over
/// the network (streamable HTTP and legacy SSE respectively).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTransportConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Http {
        url: String,
        headers: HashMap<String, String>,
    },
    Sse {
        url: String,
        headers: HashMap<String, String>,
    },
}

fn str_vec(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

fn str_map(v: Option<&Value>) -> HashMap<String, String> {
    match v {
        Some(Value::Object(o)) => o
            .iter()
            .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
        _ => HashMap::new(),
    }
}

/// Parse one server entry into a transport. Returns `None` when neither a
/// `command` (stdio) nor a `url` (http/sse) is present.
fn parse_transport(entry: &Value) -> Option<McpTransportConfig> {
    let command = entry.get("command").and_then(Value::as_str);
    if let Some(command) = command.filter(|c| !c.is_empty()) {
        return Some(McpTransportConfig::Stdio {
            command: command.to_string(),
            args: str_vec(entry.get("args")),
            env: str_map(entry.get("env")),
        });
    }
    let url = entry.get("url").and_then(Value::as_str)?.to_string();
    if url.is_empty() {
        return None;
    }
    let headers = str_map(entry.get("headers"));
    // Default remote transport is streamable HTTP; `"type":"sse"` selects legacy.
    match entry.get("type").and_then(Value::as_str) {
        Some("sse") => Some(McpTransportConfig::Sse { url, headers }),
        _ => Some(McpTransportConfig::Http { url, headers }),
    }
}

/// Parse an `mcpServers` object (`{ name: {...} }`) into name→config entries.
fn parse_servers_object(obj: &Value, out: &mut BTreeMap<String, McpServerConfig>) {
    let Some(map) = obj.as_object() else { return };
    for (name, entry) in map {
        if name.is_empty() {
            continue;
        }
        if let Some(transport) = parse_transport(entry) {
            out.insert(
                name.clone(),
                McpServerConfig {
                    name: name.clone(),
                    transport,
                },
            );
        }
    }
}

/// Read `<cwd>/.mcp.json` and return its `mcpServers` object, if any.
fn read_project_mcp_json(cwd: &Path) -> Option<Value> {
    let path = cwd.join(".mcp.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.get("mcpServers").cloned()
}

/// Load and merge MCP server configs. `global_mcp` is the `mcpServers` value from
/// `~/.deepdive/settings.json`; the project `<cwd>/.mcp.json`'s `mcpServers`
/// **overrides same-named** entries. Returns a deterministic, name-sorted list.
pub fn load_mcp_servers(global_mcp: Option<&Value>, cwd: &Path) -> Vec<McpServerConfig> {
    let mut merged: BTreeMap<String, McpServerConfig> = BTreeMap::new();
    if let Some(g) = global_mcp {
        parse_servers_object(g, &mut merged);
    }
    if let Some(p) = read_project_mcp_json(cwd) {
        parse_servers_object(&p, &mut merged);
    }
    merged.into_values().collect()
}

// ── CLI config management (`deepdive mcp add|list|get|remove`) ───────────────

/// Where a server config lives. `User` = the global `~/.deepdive/settings.json`
/// `mcpServers`; `Project` = `<cwd>/.mcp.json`. (The two scopes DeepDive already
/// reads and merges at load time.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpScope {
    User,
    Project,
}

impl McpScope {
    pub fn as_str(self) -> &'static str {
        match self {
            McpScope::User => "user",
            McpScope::Project => "project",
        }
    }

    /// Parse a `--scope` value. Only `user` and `project` are accepted (kept
    /// strict on purpose — no `local` alias, to avoid clashing with Claude
    /// Code's distinct `local` scope semantics).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(McpScope::User),
            "project" => Some(McpScope::Project),
            _ => None,
        }
    }
}

fn str_map_to_json(m: &HashMap<String, String>) -> Value {
    let mut o = Map::new();
    for (k, v) in m {
        o.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(o)
}

/// Serialize a transport back into the on-disk per-server JSON shape that
/// [`parse_transport`] reads. Empty `args` are still written (stdio always has
/// an `args` array); empty `env`/`headers` are omitted for a tidy file.
pub fn transport_to_json(t: &McpTransportConfig) -> Value {
    let mut o = Map::new();
    match t {
        McpTransportConfig::Stdio { command, args, env } => {
            o.insert("command".into(), Value::String(command.clone()));
            o.insert(
                "args".into(),
                Value::Array(args.iter().cloned().map(Value::String).collect()),
            );
            if !env.is_empty() {
                o.insert("env".into(), str_map_to_json(env));
            }
        }
        McpTransportConfig::Http { url, headers } => {
            o.insert("type".into(), Value::String("http".into()));
            o.insert("url".into(), Value::String(url.clone()));
            if !headers.is_empty() {
                o.insert("headers".into(), str_map_to_json(headers));
            }
        }
        McpTransportConfig::Sse { url, headers } => {
            o.insert("type".into(), Value::String("sse".into()));
            o.insert("url".into(), Value::String(url.clone()));
            if !headers.is_empty() {
                o.insert("headers".into(), str_map_to_json(headers));
            }
        }
    }
    Value::Object(o)
}

fn project_path(cwd: &Path) -> PathBuf {
    cwd.join(".mcp.json")
}

/// Read the raw `mcpServers` object for one scope (empty if absent/unreadable).
fn read_scope_servers(scope: McpScope, cwd: &Path) -> Map<String, Value> {
    let raw = match scope {
        McpScope::User => crate::config::read_flat_setting("mcpServers"),
        McpScope::Project => read_project_mcp_json(cwd),
    };
    raw.and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// Persist the raw `mcpServers` object for one scope, preserving other fields
/// (settings.json keeps its env/permissions; `.mcp.json` keeps any extra keys).
fn write_scope_servers(
    scope: McpScope,
    cwd: &Path,
    servers: Map<String, Value>,
) -> std::io::Result<()> {
    match scope {
        McpScope::User => {
            crate::config::write_flat_setting("mcpServers", Value::Object(servers));
            Ok(())
        }
        McpScope::Project => {
            let path = project_path(cwd);
            let mut root = std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            root.insert("mcpServers".into(), Value::Object(servers));
            std::fs::write(&path, serde_json::to_string_pretty(&Value::Object(root))?)
        }
    }
}

/// Add (or overwrite) a server in `scope`. Returns whether it replaced an
/// existing same-named entry.
pub fn add_server(scope: McpScope, cwd: &Path, cfg: &McpServerConfig) -> std::io::Result<bool> {
    let mut servers = read_scope_servers(scope, cwd);
    let existed = servers.contains_key(&cfg.name);
    servers.insert(cfg.name.clone(), transport_to_json(&cfg.transport));
    write_scope_servers(scope, cwd, servers)?;
    Ok(existed)
}

/// Remove a server from `scope`. Returns whether it existed.
pub fn remove_server(scope: McpScope, cwd: &Path, name: &str) -> std::io::Result<bool> {
    let mut servers = read_scope_servers(scope, cwd);
    if servers.remove(name).is_none() {
        return Ok(false);
    }
    write_scope_servers(scope, cwd, servers)?;
    Ok(true)
}

/// Parsed servers configured in one scope, sorted by name (for `list`/`get`).
pub fn scope_servers(scope: McpScope, cwd: &Path) -> Vec<McpServerConfig> {
    let obj = Value::Object(read_scope_servers(scope, cwd));
    let mut out = BTreeMap::new();
    parse_servers_object(&obj, &mut out);
    out.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_stdio_and_remote_transports() {
        let obj = json!({
            "fs": { "command": "npx", "args": ["-y", "@mcp/fs", "/tmp"], "env": { "K": "V" } },
            "http": { "type": "http", "url": "https://x/mcp", "headers": { "Authorization": "Bearer t" } },
            "sse": { "type": "sse", "url": "https://x/sse" },
            "default-remote": { "url": "https://y/mcp" },
            "bad": { "nonsense": true }
        });
        let mut out = BTreeMap::new();
        parse_servers_object(&obj, &mut out);
        assert_eq!(out.len(), 4); // "bad" dropped
        match &out["fs"].transport {
            McpTransportConfig::Stdio { command, args, env } => {
                assert_eq!(command, "npx");
                assert_eq!(args, &["-y", "@mcp/fs", "/tmp"]);
                assert_eq!(env.get("K").map(String::as_str), Some("V"));
            }
            _ => panic!("expected stdio"),
        }
        assert!(matches!(out["http"].transport, McpTransportConfig::Http { .. }));
        assert!(matches!(out["sse"].transport, McpTransportConfig::Sse { .. }));
        // no "type" but a url → default to streamable HTTP
        assert!(matches!(
            out["default-remote"].transport,
            McpTransportConfig::Http { .. }
        ));
    }

    #[test]
    fn project_overrides_global_same_name() {
        let global = json!({
            "fs": { "command": "global-cmd" },
            "only-global": { "command": "g" }
        });
        // simulate project by parsing both into the same map in order
        let mut merged = BTreeMap::new();
        parse_servers_object(&global, &mut merged);
        parse_servers_object(&json!({ "fs": { "command": "project-cmd" } }), &mut merged);
        assert_eq!(merged.len(), 2);
        match &merged["fs"].transport {
            McpTransportConfig::Stdio { command, .. } => assert_eq!(command, "project-cmd"),
            _ => panic!(),
        }
        assert!(merged.contains_key("only-global"));
    }

    #[test]
    fn empty_name_and_empty_command_dropped() {
        let obj = json!({
            "": { "command": "x" },
            "empty-cmd": { "command": "" }
        });
        let mut out = BTreeMap::new();
        parse_servers_object(&obj, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn transport_json_round_trips_through_loader() {
        // The serializer must produce exactly what `parse_transport` reads back —
        // this is the parity contract that keeps `mcp add` output loadable.
        let stdio = McpTransportConfig::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@mcp/fs".into(), "/tmp".into()],
            env: HashMap::from([("K".into(), "V".into())]),
        };
        assert_eq!(parse_transport(&transport_to_json(&stdio)), Some(stdio));

        let http = McpTransportConfig::Http {
            url: "https://x/mcp".into(),
            headers: HashMap::new(),
        };
        assert_eq!(parse_transport(&transport_to_json(&http)), Some(http));

        let sse = McpTransportConfig::Sse {
            url: "https://x/sse".into(),
            headers: HashMap::from([("Authorization".into(), "Bearer t".into())]),
        };
        assert_eq!(parse_transport(&transport_to_json(&sse)), Some(sse));
    }

    #[test]
    fn project_scope_add_get_remove_round_trip() {
        let dir = std::env::temp_dir().join(format!("deepdive_mcp_cfg_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let cfg = McpServerConfig {
            name: "fs".into(),
            transport: McpTransportConfig::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@mcp/fs".into()],
                env: HashMap::new(),
            },
        };

        // new insert reports "did not exist"; the file now has exactly one server
        assert!(!add_server(McpScope::Project, &dir, &cfg).unwrap());
        let listed = scope_servers(McpScope::Project, &dir);
        assert_eq!(listed, vec![cfg.clone()]);

        // overwrite reports "existed"
        assert!(add_server(McpScope::Project, &dir, &cfg).unwrap());

        // remove is idempotent: true then false
        assert!(remove_server(McpScope::Project, &dir, "fs").unwrap());
        assert!(!remove_server(McpScope::Project, &dir, "fs").unwrap());
        assert!(scope_servers(McpScope::Project, &dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
