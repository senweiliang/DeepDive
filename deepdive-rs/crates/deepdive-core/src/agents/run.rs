//! Headless subagent loop. Faithful port of `src/agents/run.ts`.
//!
//! Mirrors the interactive loop (stream → run tools → feed results back →
//! repeat) but with no UI, no approval prompts, and a scoped tool set. The whole
//! point is context isolation: intermediate tool noise stays in `history` and
//! only the final `text` returns to the caller. This is also the structural
//! template for the P2 `engine::run_turn_loop`.

use super::builtin::general_purpose_agent;
use super::registry::{get_agent, get_all_agents, resolve_agent_tools};
use crate::client::ChatOverrides;
use crate::config::Config;
use crate::contract::ApprovalMode;
use crate::tools::approval::{tool_allowed, tool_needs_approval};
use crate::tools::dispatch::execute_tool;
use crate::tools::format::summarize_args;
use crate::tools::permissions::{check_permission, PermissionConfig, PermissionDecision};
use crate::turn::stream_turn;
use crate::types::Message;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

const DEFAULT_SUBAGENT_MAX_TURNS: u64 = 30;

#[derive(Debug, Clone)]
pub struct SubagentStep {
    pub name: String,
    pub summary: String,
    pub result: String,
}

#[derive(Debug, Clone)]
pub struct SubagentProgress {
    pub agent_type: String,
    pub turn: u32,
    pub tool_calls: u32,
    pub activity: String,
}

pub struct RunSubagentParams {
    pub agent_type: Option<String>,
    pub description: String,
    pub prompt: String,
    pub config: Config,
    pub mode: ApprovalMode,
    pub permissions: PermissionConfig,
    pub workspace: PathBuf,
    pub max_turns: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct RunSubagentResult {
    pub text: String,
    pub is_error: bool,
    pub turns: u32,
    pub tool_calls: u32,
    pub interrupted: bool,
}

/// Run one subagent to completion. `on_progress`/`on_step` mirror the TS
/// callbacks (the engine wires them to the TaskStore / transcript).
pub async fn run_subagent(
    client: &reqwest::Client,
    params: RunSubagentParams,
    cancel: &CancellationToken,
    mut on_progress: impl FnMut(SubagentProgress),
    mut on_step: impl FnMut(SubagentStep),
) -> RunSubagentResult {
    // An explicit-but-unknown type is a model error — report it, don't fall back.
    if let Some(t) = &params.agent_type {
        if !t.is_empty() && get_agent(t).is_none() {
            let available = get_all_agents()
                .iter()
                .map(|a| a.agent_type.clone())
                .collect::<Vec<_>>()
                .join(", ");
            return RunSubagentResult {
                text: format!(
                    "Error: unknown subagent_type \"{t}\". Available types: {available}."
                ),
                is_error: true,
                turns: 0,
                tool_calls: 0,
                interrupted: false,
            };
        }
    }
    let def = params
        .agent_type
        .as_ref()
        .filter(|t| !t.is_empty())
        .and_then(|t| get_agent(t))
        .unwrap_or_else(general_purpose_agent);

    let tools = resolve_agent_tools(&def);
    let mut model_config = params.config.clone();
    if let Some(m) = &def.model {
        model_config.model = m.clone();
    }
    let overrides = ChatOverrides {
        system_prompt: Some(def.system_prompt.clone()),
        tools: Some(tools),
    };
    let cap = params
        .max_turns
        .or(params.config.max_turns)
        .unwrap_or(DEFAULT_SUBAGENT_MAX_TURNS);

    let mut history = vec![Message::user(params.prompt.clone())];
    let mut turn: u32 = 0;
    let mut total_tool_calls: u32 = 0;
    let mut last_text = String::new();

    while (turn as u64) < cap {
        if cancel.is_cancelled() {
            return interrupted_result(&last_text, turn, total_tool_calls);
        }
        turn += 1;
        on_progress(SubagentProgress {
            agent_type: def.agent_type.clone(),
            turn,
            tool_calls: total_tool_calls,
            activity: "thinking".into(),
        });

        let res = match stream_turn(
            client,
            &model_config,
            &history,
            cancel,
            overrides.clone(),
            |_| {},
            |_| {},
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                return RunSubagentResult {
                    text: format!("Error: {e}"),
                    is_error: true,
                    turns: turn,
                    tool_calls: total_tool_calls,
                    interrupted: false,
                }
            }
        };

        if !res.assistant.content.is_empty() {
            last_text = res.assistant.content.clone();
        }
        let calls = res.assistant.tool_calls.clone();
        history.push(res.assistant);

        if res.interrupted {
            return interrupted_result(&last_text, turn, total_tool_calls);
        }

        if calls.is_empty() || res.finish_reason.as_deref() != Some("tool_calls") {
            return RunSubagentResult {
                text: last_text,
                is_error: false,
                turns: turn,
                tool_calls: total_tool_calls,
                interrupted: false,
            };
        }

        let mut tool_results = Vec::new();
        for tc in &calls {
            if cancel.is_cancelled() {
                tool_results.push(Message::tool(&tc.id, "Aborted by user."));
                continue;
            }
            let name = &tc.function.name;
            let args: Value = serde_json::from_str(&tc.function.arguments).unwrap_or(Value::Null);
            total_tool_calls += 1;
            on_progress(SubagentProgress {
                agent_type: def.agent_type.clone(),
                turn,
                tool_calls: total_tool_calls,
                activity: name.clone(),
            });

            let content = match gate_subagent_tool(
                name,
                &args,
                params.mode,
                &params.permissions,
                &params.workspace,
            ) {
                Err(reason) => format!("Error: tool \"{name}\" {reason}."),
                Ok(()) => {
                    execute_tool(
                        client,
                        &params.config,
                        name,
                        &args,
                        &params.workspace,
                        cancel,
                    )
                    .await
                    .content
                }
            };
            tool_results.push(Message::tool(&tc.id, &content));
            on_step(SubagentStep {
                name: name.clone(),
                summary: summarize_args(name, &args),
                result: summarize_step_result(name, &content),
            });
        }
        history.extend(tool_results);
    }

    RunSubagentResult {
        text: if last_text.is_empty() {
            format!("(subagent stopped after reaching the {cap}-turn cap)")
        } else {
            last_text.clone()
        },
        is_error: last_text.is_empty(),
        turns: turn,
        tool_calls: total_tool_calls,
        interrupted: false,
    }
}

fn interrupted_result(last_text: &str, turn: u32, tool_calls: u32) -> RunSubagentResult {
    RunSubagentResult {
        text: if last_text.is_empty() {
            "(interrupted)".to_string()
        } else {
            last_text.to_string()
        },
        is_error: true,
        turns: turn,
        tool_calls,
        interrupted: true,
    }
}

/// Lexically resolve `p` against `base`, collapsing `.`/`..` (no fs access),
/// like node `path.resolve`. Shared with the engine's out-of-workspace check.
pub(crate) fn lexical_resolve(base: &Path, p: &str) -> PathBuf {
    let joined = if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else {
        base.join(p)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A subagent has no UI to approve through, so any path escaping the workspace
/// is refused outright.
fn paths_within_workspace(args: &Value, workspace: &Path) -> bool {
    let ws = lexical_resolve(workspace, ".");
    for key in ["file_path", "path"] {
        if let Some(v) = args.get(key).and_then(Value::as_str) {
            if !v.is_empty() {
                let p = lexical_resolve(&ws, v);
                if p != ws && !p.starts_with(&ws) {
                    return false;
                }
            }
        }
    }
    true
}

/// Headless permission decision. Honour explicit allow/deny; otherwise allow
/// only what would NOT prompt in the current mode. Returns `Err(reason)` when
/// the tool is refused.
fn gate_subagent_tool(
    name: &str,
    args: &Value,
    mode: ApprovalMode,
    permissions: &PermissionConfig,
    workspace: &Path,
) -> Result<(), String> {
    if !paths_within_workspace(args, workspace) {
        return Err("targets a path outside the workspace, which a subagent cannot access".into());
    }
    match check_permission(Some(permissions), name, args) {
        PermissionDecision::Deny => return Err("denied by a permission rule".into()),
        PermissionDecision::Allow => return Ok(()),
        _ => {}
    }
    if !tool_allowed(name, mode) {
        return Err(format!("is not available in {} mode", mode_str(mode)));
    }
    if tool_needs_approval(name, mode) {
        return Err("requires user approval, which a subagent cannot request — run it in the main session, or switch to acceptEdits/yolo mode".into());
    }
    Ok(())
}

fn mode_str(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Plan => "plan",
        ApprovalMode::Default => "default",
        ApprovalMode::AcceptEdits => "acceptEdits",
        ApprovalMode::Yolo => "yolo",
        ApprovalMode::Auto => "auto",
    }
}

fn summarize_step_result(name: &str, content: &str) -> String {
    if content.starts_with("Error:")
        || content.starts_with("Unknown tool")
        || content == "Aborted by user."
    {
        return "error".to_string();
    }
    let lines = if content.trim().is_empty() {
        0
    } else {
        content.trim().split('\n').count()
    };
    if name == "grep" || name == "glob" {
        format!("{lines} matches")
    } else {
        format!("{lines} lines")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn perms() -> PermissionConfig {
        PermissionConfig::default()
    }

    #[test]
    fn gate_blocks_out_of_workspace_paths() {
        let ws = Path::new("/work");
        assert!(paths_within_workspace(
            &json!({ "file_path": "src/a.rs" }),
            ws
        ));
        assert!(paths_within_workspace(
            &json!({ "file_path": "/work/sub/a.rs" }),
            ws
        ));
        assert!(!paths_within_workspace(
            &json!({ "file_path": "../etc/passwd" }),
            ws
        ));
        assert!(!paths_within_workspace(
            &json!({ "path": "/etc/passwd" }),
            ws
        ));
        // a sibling that merely shares a prefix is NOT inside
        assert!(!paths_within_workspace(
            &json!({ "file_path": "/worktree/x" }),
            ws
        ));
    }

    #[test]
    fn gate_default_mode_allows_read_blocks_write() {
        let ws = Path::new("/work");
        // read_file in default mode: not prompted → allowed
        assert!(gate_subagent_tool(
            "read_file",
            &json!({ "file_path": "a.rs" }),
            ApprovalMode::Default,
            &perms(),
            ws
        )
        .is_ok());
        // write_file in default mode: needs approval → refused
        let err = gate_subagent_tool(
            "write_file",
            &json!({ "file_path": "a.rs" }),
            ApprovalMode::Default,
            &perms(),
            ws,
        )
        .unwrap_err();
        assert!(err.contains("requires user approval"));
    }

    #[test]
    fn gate_accept_edits_allows_write() {
        let ws = Path::new("/work");
        assert!(gate_subagent_tool(
            "write_file",
            &json!({ "file_path": "a.rs" }),
            ApprovalMode::AcceptEdits,
            &perms(),
            ws
        )
        .is_ok());
        // a non-read-only bash command still needs approval in acceptEdits
        // ("ls" is auto-allowed by the read-only allowlist before the mode gate).
        assert!(gate_subagent_tool(
            "bash",
            &json!({ "command": "npm publish" }),
            ApprovalMode::AcceptEdits,
            &perms(),
            ws
        )
        .is_err());
    }

    #[test]
    fn gate_respects_explicit_deny() {
        let ws = Path::new("/work");
        let p = PermissionConfig {
            allow: vec![],
            deny: vec!["Bash(rm:*)".into()],
            ask: vec![],
        };
        let err = gate_subagent_tool(
            "bash",
            &json!({ "command": "rm -rf x" }),
            ApprovalMode::Yolo,
            &p,
            ws,
        )
        .unwrap_err();
        assert!(err.contains("denied by a permission rule"));
    }

    #[test]
    fn step_result_summary() {
        assert_eq!(
            summarize_step_result("grep", "a.rs:1: x\nb.rs:2: y"),
            "2 matches"
        );
        assert_eq!(summarize_step_result("read_file", "l1\nl2\nl3"), "3 lines");
        assert_eq!(summarize_step_result("bash", "Error: boom"), "error");
    }
}
