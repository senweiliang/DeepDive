//! MCP (Model Context Protocol) client — connect to external MCP servers,
//! discover their tools, expose them to the model as `mcp__<server>__<tool>`,
//! and route `tools/call` back. Reference: Claude Code's MCP model.
//!
//! v1 scope: **tools only** (`tools/list` + `tools/call`) over stdio, streamable
//! HTTP, and legacy SSE transports. Resources / prompts are future work.
//!
//! Zero new dependencies — stdio uses `tokio::process`, HTTP/SSE reuse `reqwest`.

pub mod client;
pub mod config;
pub mod manager;
pub mod protocol;
pub mod transport;

pub use config::{
    add_server, load_mcp_servers, remove_server, scope_servers, transport_to_json, McpScope,
    McpServerConfig, McpTransportConfig,
};
pub use manager::{McpManager, McpServerStatus};
pub use protocol::{namespaced_tool_name, parse_tool_name, MCP_TOOL_PREFIX};
