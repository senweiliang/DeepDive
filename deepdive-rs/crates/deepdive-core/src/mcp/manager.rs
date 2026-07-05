//! The session-scoped MCP registry. Owns every [`McpClient`], aggregates their
//! tool schemas (frozen at connect time for prefix-cache stability), routes
//! `mcp__server__tool` calls, and reports connection status for `/mcp`.
//!
//! Held behind `Arc` in `Session` (mirrors `Session.tasks: Arc<TaskStore>`) so a
//! `/clear` can carry the live connections into the fresh session.

use super::client::{ConnState, McpClient};
use super::config::McpServerConfig;
use crate::tools::executor::ToolResult;
use serde_json::Value;

/// One server's status line for the `/mcp` view and the startup status event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerStatus {
    pub name: String,
    pub transport: &'static str,
    pub connected: bool,
    pub tool_count: usize,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct McpManager {
    clients: Vec<McpClient>,
}

impl McpManager {
    /// An empty manager (no configured servers). Cheap default for `Session::new`.
    pub fn empty() -> Self {
        McpManager {
            clients: Vec::new(),
        }
    }

    /// Connect to every configured server concurrently. Failures are captured on
    /// the individual client (non-fatal) — the manager always returns.
    pub async fn connect_all(http: &reqwest::Client, servers: &[McpServerConfig]) -> Self {
        if servers.is_empty() {
            return Self::empty();
        }
        let clients =
            futures_util::future::join_all(servers.iter().map(|s| McpClient::connect(http, s)))
                .await;
        McpManager { clients }
    }

    pub fn has_servers(&self) -> bool {
        !self.clients.is_empty()
    }

    pub fn tool_count(&self) -> usize {
        self.clients.iter().map(|c| c.tools.len()).sum()
    }

    /// All discovered tool schemas, name-sorted for a byte-stable `tools` array.
    pub fn tool_schemas(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self
            .clients
            .iter()
            .flat_map(|c| c.tools.iter().map(|t| t.schema.clone()))
            .collect();
        out.sort_by(|a, b| {
            let name = |v: &Value| {
                v.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            name(a).cmp(&name(b))
        });
        out
    }

    /// Route an `mcp__server__tool` call to its server. Matches on the full
    /// namespaced name (so tool names containing `__` route correctly).
    pub async fn call(&self, full_name: &str, args: &Value) -> ToolResult {
        for client in &self.clients {
            if let Some(tool) = client.tools.iter().find(|t| t.full_name == full_name) {
                let (content, is_error) = client.call_tool(&tool.raw_name, args).await;
                return if is_error {
                    ToolResult::error(content)
                } else {
                    ToolResult::ok(content)
                };
            }
        }
        ToolResult::error(format!("Unknown MCP tool: {full_name}"))
    }

    pub fn statuses(&self) -> Vec<McpServerStatus> {
        self.clients
            .iter()
            .map(|c| McpServerStatus {
                name: c.name.clone(),
                transport: c.transport_kind,
                connected: matches!(c.state, ConnState::Connected),
                tool_count: c.tools.len(),
                error: match &c.state {
                    ConnState::Failed(e) => Some(e.clone()),
                    ConnState::Connected => None,
                },
            })
            .collect()
    }

    /// Close every connection (kill subprocesses, drop streams). Best-effort.
    pub async fn shutdown(&self) {
        for c in &self.clients {
            c.close().await;
        }
    }
}
