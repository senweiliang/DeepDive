//! End-to-end stdio MCP test: spawn a minimal Node MCP server, connect via
//! `McpManager`, discover its tool, and call it. Skipped if `node` is absent.

use deepdive_core::mcp::{McpManager, McpServerConfig, McpTransportConfig};
use serde_json::json;
use std::collections::HashMap;

const MOCK_SERVER: &str = r#"
const rl = require('readline').createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
    ] } });
  } else if (msg.method === 'tools/call') {
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || '';
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + text }], isError: false } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
"#;

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn stdio_end_to_end_connect_discover_call() {
    if !node_available() {
        eprintln!("skipping: node not available");
        return;
    }
    // Write the mock server to a temp file.
    let dir = std::env::temp_dir().join(format!("deepdive-mcp-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("mock_mcp_server.js");
    std::fs::write(&script, MOCK_SERVER).unwrap();

    let cfg = McpServerConfig {
        name: "mock".to_string(),
        transport: McpTransportConfig::Stdio {
            command: "node".to_string(),
            args: vec![script.to_string_lossy().into_owned()],
            env: HashMap::new(),
        },
    };

    let http = reqwest::Client::new();
    let manager = McpManager::connect_all(&http, std::slice::from_ref(&cfg)).await;

    // Connected, one tool discovered.
    let statuses = manager.statuses();
    assert_eq!(statuses.len(), 1);
    assert!(statuses[0].connected, "expected connected, got {statuses:?}");
    assert_eq!(statuses[0].tool_count, 1);
    assert_eq!(statuses[0].transport, "stdio");

    // Namespaced schema exposed to the model.
    let schemas = manager.tool_schemas();
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0]["function"]["name"], "mcp__mock__echo");
    assert_eq!(schemas[0]["function"]["parameters"]["required"][0], "text");

    // Call routes to the server and flattens its content.
    let result = manager
        .call("mcp__mock__echo", &json!({ "text": "hi" }))
        .await;
    assert!(!result.is_error, "call errored: {}", result.content);
    assert_eq!(result.content, "echo: hi");

    // Unknown tool is a clean error, not a panic.
    let missing = manager.call("mcp__mock__nope", &json!({})).await;
    assert!(missing.is_error);

    manager.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}
