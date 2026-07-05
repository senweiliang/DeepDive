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

use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;

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
}
