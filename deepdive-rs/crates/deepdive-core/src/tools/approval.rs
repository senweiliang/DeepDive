//! Approval policy by mode. Faithful port of `src/tools/approval.ts`.
//!
//! Capability buckets:
//! - read-only (read/glob/grep/web_search/web_fetch/ask_user_question/
//!   task_output): available in plan mode, never prompts.
//! - write (write_file/edit_file) and exec (bash): gated per mode.
//!
//! `task_stop` is deliberately NOT read-only (killing a process is a real side
//! effect), so it's blocked in plan mode like bash.

use crate::contract::ApprovalMode;

const READ_ONLY_TOOLS: &[&str] = &[
    "read_file",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "ask_user_question",
    "task_output",
];
const WRITE_TOOLS: &[&str] = &["write_file", "edit_file"];
const EXEC_TOOLS: &[&str] = &["bash"];

/// Whether a tool is in the read-only capability bucket. The interactive loop
/// uses this for the "auto mode + read-only + out-of-workspace → auto-approve"
/// shortcut (App.tsx:1271-1280).
pub fn is_read_only_tool(tool_name: &str) -> bool {
    READ_ONLY_TOOLS.contains(&tool_name)
}

pub fn tool_needs_approval(tool_name: &str, mode: ApprovalMode) -> bool {
    match mode {
        ApprovalMode::Yolo => false,
        // Auto-accept file edits this session; bash still asks. Auto mode: only
        // bash needs the classifier; read/write auto-pass.
        ApprovalMode::AcceptEdits | ApprovalMode::Auto => EXEC_TOOLS.contains(&tool_name),
        ApprovalMode::Plan | ApprovalMode::Default => {
            WRITE_TOOLS.contains(&tool_name) || EXEC_TOOLS.contains(&tool_name)
        }
    }
}

pub fn tool_allowed(tool_name: &str, mode: ApprovalMode) -> bool {
    if mode == ApprovalMode::Plan {
        return READ_ONLY_TOOLS.contains(&tool_name);
    }
    // All other modes allow all tools (bash may be blocked by the classifier).
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_blocks_writes_and_exec() {
        assert!(tool_needs_approval("write_file", ApprovalMode::Plan));
        assert!(tool_needs_approval("bash", ApprovalMode::Plan));
        assert!(!tool_needs_approval("read_file", ApprovalMode::Plan));
        // plan mode only ALLOWS read-only tools
        assert!(tool_allowed("read_file", ApprovalMode::Plan));
        assert!(tool_allowed("ask_user_question", ApprovalMode::Plan));
        assert!(!tool_allowed("write_file", ApprovalMode::Plan));
        assert!(!tool_allowed("bash", ApprovalMode::Plan));
        assert!(!tool_allowed("task_stop", ApprovalMode::Plan));
    }

    #[test]
    fn yolo_never_prompts() {
        for t in ["bash", "write_file", "edit_file", "read_file"] {
            assert!(!tool_needs_approval(t, ApprovalMode::Yolo));
            assert!(tool_allowed(t, ApprovalMode::Yolo));
        }
    }

    #[test]
    fn accept_edits_and_auto_only_gate_bash() {
        for mode in [ApprovalMode::AcceptEdits, ApprovalMode::Auto] {
            assert!(tool_needs_approval("bash", mode));
            assert!(!tool_needs_approval("write_file", mode));
            assert!(!tool_needs_approval("edit_file", mode));
            assert!(!tool_needs_approval("read_file", mode));
        }
    }

    #[test]
    fn default_mode_gates_writes_and_exec() {
        assert!(tool_needs_approval("write_file", ApprovalMode::Default));
        assert!(tool_needs_approval("edit_file", ApprovalMode::Default));
        assert!(tool_needs_approval("bash", ApprovalMode::Default));
        assert!(!tool_needs_approval("read_file", ApprovalMode::Default));
    }
}
