//! A single MCP server connection: does the `initialize` handshake, caches the
//! server's `tools/list`, and routes `tools/call`. One [`McpClient`] per server;
//! the [`super::manager::McpManager`] owns them all.

use super::config::{McpServerConfig, McpTransportConfig};
use super::protocol::{self, sanitize_server_name};
use super::transport::{self, Transport};
use serde_json::{json, Value};

/// A stable, human-readable label for a transport kind.
fn transport_kind(cfg: &McpTransportConfig) -> &'static str {
    match cfg {
        McpTransportConfig::Stdio { .. } => "stdio",
        McpTransportConfig::Http { .. } => "http",
        McpTransportConfig::Sse { .. } => "sse",
    }
}

/// Connection state for a server (surfaced by `/mcp`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnState {
    Connected,
    Failed(String),
}

/// One discovered MCP tool with its (namespaced) name and JSON schema.
#[derive(Debug, Clone)]
pub struct McpToolInfo {
    /// Model-facing name: `mcp__<server>__<tool>`.
    pub full_name: String,
    /// The raw tool name on the server.
    pub raw_name: String,
    /// A short description (for `/mcp` listing).
    pub description: String,
    /// The OpenAI-function tool schema sent to the model.
    pub schema: Value,
}

pub struct McpClient {
    pub name: String,
    pub sanitized: String,
    pub transport_kind: &'static str,
    transport: Box<dyn Transport>,
    pub tools: Vec<McpToolInfo>,
    pub state: ConnState,
}

impl McpClient {
    /// Connect + handshake + discover tools. On any failure the returned client
    /// has `state = Failed` and no tools (non-fatal — other servers still load).
    pub async fn connect(client: &reqwest::Client, cfg: &McpServerConfig) -> McpClient {
        let sanitized = sanitize_server_name(&cfg.name);
        let kind = transport_kind(&cfg.transport);
        match Self::try_connect(client, cfg, &sanitized, kind).await {
            Ok(c) => c,
            Err(e) => McpClient {
                name: cfg.name.clone(),
                sanitized,
                transport_kind: kind,
                transport: Box::new(DeadTransport),
                tools: Vec::new(),
                state: ConnState::Failed(e),
            },
        }
    }

    async fn try_connect(
        client: &reqwest::Client,
        cfg: &McpServerConfig,
        sanitized: &str,
        kind: &'static str,
    ) -> Result<McpClient, String> {
        let transport = transport::connect(client, &cfg.transport).await?;

        // MCP handshake: initialize → notifications/initialized → tools/list.
        transport
            .request("initialize", protocol::initialize_params())
            .await
            .map_err(|e| format!("initialize failed: {e}"))?;
        transport
            .notify("notifications/initialized", json!({}))
            .await
            .ok(); // best-effort; some servers don't require it
        let list = transport
            .request("tools/list", json!({}))
            .await
            .map_err(|e| format!("tools/list failed: {e}"))?;

        let tools = protocol::tools_from_list(&list)
            .iter()
            .filter_map(|t| build_tool_info(sanitized, t))
            .collect();

        Ok(McpClient {
            name: cfg.name.clone(),
            sanitized: sanitized.to_string(),
            transport_kind: kind,
            transport,
            tools,
            state: ConnState::Connected,
        })
    }

    /// Call a tool by its RAW (server-side) name.
    pub async fn call_tool(&self, raw_name: &str, args: &Value) -> (String, bool) {
        match self
            .transport
            .request("tools/call", protocol::call_tool_params(raw_name, args))
            .await
        {
            Ok(result) => protocol::flatten_tool_result(&result),
            Err(e) => (format!("Error: MCP call failed: {e}"), true),
        }
    }

    pub async fn close(&self) {
        self.transport.close().await;
    }
}

/// Turn a raw `tools/list` entry into an [`McpToolInfo`] with a namespaced,
/// model-facing function schema. Returns `None` if the entry has no name.
fn build_tool_info(server_sanitized: &str, tool: &Value) -> Option<McpToolInfo> {
    let raw_name = tool.get("name").and_then(Value::as_str)?.to_string();
    let full_name = format!("mcp__{server_sanitized}__{raw_name}");
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // MCP tools carry `inputSchema` (JSON Schema); reuse it verbatim as the
    // function `parameters`. Fall back to a permissive object schema.
    let parameters = tool
        .get("inputSchema")
        .cloned()
        .filter(|s| s.is_object())
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    let schema = json!({
        "type": "function",
        "function": {
            "name": full_name,
            "description": description,
            "parameters": parameters,
        }
    });
    Some(McpToolInfo {
        full_name,
        raw_name,
        description,
        schema,
    })
}

/// Placeholder transport for a client that failed to connect — every call errors.
struct DeadTransport;

#[async_trait::async_trait]
impl Transport for DeadTransport {
    async fn request(&self, _method: &str, _params: Value) -> Result<Value, String> {
        Err("server not connected".to_string())
    }
    async fn notify(&self, _method: &str, _params: Value) -> Result<(), String> {
        Err("server not connected".to_string())
    }
    async fn close(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_namespaced_function_schema() {
        let tool = json!({
            "name": "create_issue",
            "description": "Create an issue",
            "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }
        });
        let info = build_tool_info("github", &tool).unwrap();
        assert_eq!(info.full_name, "mcp__github__create_issue");
        assert_eq!(info.raw_name, "create_issue");
        assert_eq!(info.schema["type"], "function");
        assert_eq!(info.schema["function"]["name"], "mcp__github__create_issue");
        assert_eq!(info.schema["function"]["parameters"]["required"][0], "title");
    }

    #[test]
    fn missing_input_schema_falls_back_to_object() {
        let info = build_tool_info("srv", &json!({ "name": "ping" })).unwrap();
        assert_eq!(info.schema["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn no_name_is_skipped() {
        assert!(build_tool_info("srv", &json!({ "description": "x" })).is_none());
    }
}
