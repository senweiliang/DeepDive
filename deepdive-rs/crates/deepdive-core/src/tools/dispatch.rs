//! Shared tool execution. One place both the interactive loop and the subagent
//! loop route a (non-spawning) tool call through. The spawning/UI tools
//! (`agent`, `skill`, `ask_user_question`, `task_output`, `task_stop`) are
//! handled by the loop itself, not here.

use crate::config::Config;
use crate::tools::bash::{execute_bash, BashOptions};
use crate::tools::executor::{execute, ToolResult};
use crate::tools::webfetch::execute_web_fetch;
use crate::tools::websearch::execute_web_search;
use serde_json::Value;
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// Execute one tool and return its result. `cancel` aborts an in-flight bash
/// (and its process tree).
pub async fn execute_tool(
    client: &reqwest::Client,
    config: &Config,
    name: &str,
    args: &Value,
    workspace: &Path,
    cancel: &CancellationToken,
) -> ToolResult {
    match name {
        "bash" => {
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            let opts = BashOptions {
                background: false,
                timeout_ms: args.get("timeout").and_then(Value::as_u64),
            };
            execute_bash(command, workspace, opts, cancel, |_| {}).await
        }
        "web_search" => execute_web_search(client, args, &config.tavily_api_key).await,
        "web_fetch" => execute_web_fetch(client, args).await,
        // read_file / write_file / edit_file / glob / grep / unknown
        _ => execute(name, args, workspace),
    }
}
