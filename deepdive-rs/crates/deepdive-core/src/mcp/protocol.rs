//! MCP wire protocol helpers — JSON-RPC 2.0 framing plus the handful of MCP
//! methods we use (`initialize`, `tools/list`, `tools/call`) and the tool-name
//! namespacing (`mcp__<server>__<tool>`) shared with Claude Code.

use serde_json::{json, Value};

/// JSON-RPC version string.
pub const JSONRPC_VERSION: &str = "2.0";
/// MCP protocol version we advertise in `initialize`.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// Prefix marking a namespaced MCP tool.
pub const MCP_TOOL_PREFIX: &str = "mcp__";

/// Sanitize a server name for use inside a tool name: lowercase-agnostic, keep
/// `[A-Za-z0-9_-]`, everything else → `_`, and collapse the `__` separator so
/// reverse-parsing on `__` stays unambiguous. Mirrors Claude Code's scheme.
pub fn sanitize_server_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    s.trim_matches('_').to_string()
}

/// Build the model-facing namespaced tool name: `mcp__<server>__<tool>`.
pub fn namespaced_tool_name(server: &str, tool: &str) -> String {
    format!("{MCP_TOOL_PREFIX}{}__{}", sanitize_server_name(server), tool)
}

/// Reverse `mcp__<server>__<tool>` → `(server, tool)`. Splits on the FIRST `__`
/// after the prefix, so a tool name that itself contains `__` is preserved.
/// Returns `None` for a non-MCP name.
pub fn parse_tool_name(full: &str) -> Option<(&str, &str)> {
    let rest = full.strip_prefix(MCP_TOOL_PREFIX)?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

/// A JSON-RPC request object with an id.
pub fn request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": JSONRPC_VERSION,
        "id": id,
        "method": method,
        "params": params,
    })
}

/// A JSON-RPC notification (no id, no response expected).
pub fn notification(method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": JSONRPC_VERSION,
        "method": method,
        "params": params,
    })
}

/// Params for the MCP `initialize` handshake.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "deepdive", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// Params for `tools/call`.
pub fn call_tool_params(tool: &str, args: &Value) -> Value {
    json!({
        "name": tool,
        "arguments": if args.is_null() { json!({}) } else { args.clone() },
    })
}

/// Extract the `id` from a JSON-RPC response (numeric ids only, which is all we
/// send).
pub fn response_id(msg: &Value) -> Option<u64> {
    msg.get("id").and_then(Value::as_u64)
}

/// Turn a JSON-RPC response into `Ok(result)` / `Err(message)`.
pub fn response_result(msg: &Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("MCP error {code}: {message}"));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

/// Flatten a `tools/call` result's `content[]` blocks into a display string plus
/// its `isError` flag. Text blocks are joined with newlines; non-text blocks
/// (image/audio/resource) degrade to a short placeholder.
pub fn flatten_tool_result(result: &Value) -> (String, bool) {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut parts: Vec<String> = Vec::new();
    if let Some(Value::Array(blocks)) = result.get("content") {
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        parts.push(t.to_string());
                    }
                }
                Some("image") => parts.push("[image]".to_string()),
                Some("audio") => parts.push("[audio]".to_string()),
                Some("resource") => {
                    // Embedded resource: prefer its inline text if present.
                    let res = block.get("resource");
                    let text = res
                        .and_then(|r| r.get("text"))
                        .and_then(Value::as_str);
                    match text {
                        Some(t) => parts.push(t.to_string()),
                        None => {
                            let uri = res
                                .and_then(|r| r.get("uri"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            parts.push(format!("[resource {uri}]"));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        // Some servers return structured content only; fall back to raw JSON.
        if let Some(sc) = result.get("structuredContent") {
            parts.push(serde_json::to_string(sc).unwrap_or_default());
        }
    }
    (parts.join("\n"), is_error)
}

/// Extract the `tools` array from a `tools/list` result.
pub fn tools_from_list(result: &Value) -> Vec<Value> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespacing_round_trips() {
        assert_eq!(namespaced_tool_name("github", "create_issue"), "mcp__github__create_issue");
        let (s, t) = parse_tool_name("mcp__github__create_issue").unwrap();
        assert_eq!((s, t), ("github", "create_issue"));
    }

    #[test]
    fn tool_name_with_double_underscore_preserved() {
        let (s, t) = parse_tool_name("mcp__srv__a__b").unwrap();
        assert_eq!(s, "srv");
        assert_eq!(t, "a__b");
    }

    #[test]
    fn sanitize_collapses_and_replaces() {
        assert_eq!(sanitize_server_name("my server"), "my_server");
        assert_eq!(sanitize_server_name("a__b"), "a_b");
        assert_eq!(sanitize_server_name("weird!!name"), "weird_name");
        assert_eq!(sanitize_server_name("_leading_"), "leading");
    }

    #[test]
    fn parse_rejects_non_mcp_and_malformed() {
        assert!(parse_tool_name("read_file").is_none());
        assert!(parse_tool_name("mcp__onlyserver").is_none());
        assert!(parse_tool_name("mcp____tool").is_none()); // empty server
    }

    #[test]
    fn flatten_joins_text_and_flags_error() {
        let r = json!({
            "content": [
                { "type": "text", "text": "line1" },
                { "type": "text", "text": "line2" },
                { "type": "image", "data": "..." }
            ],
            "isError": true
        });
        let (s, err) = flatten_tool_result(&r);
        assert_eq!(s, "line1\nline2\n[image]");
        assert!(err);
    }

    #[test]
    fn response_result_ok_and_err() {
        assert_eq!(
            response_result(&json!({ "id": 1, "result": { "x": 1 } })).unwrap(),
            json!({ "x": 1 })
        );
        assert!(response_result(&json!({ "id": 1, "error": { "code": -32601, "message": "no" } }))
            .is_err());
    }
}
