//! Background-task completion notification. Port of `src/tasks/notification.ts`.

use super::store::{BgTask, BgTaskKind};
use crate::types::Message;

pub const TASK_NOTIFICATION_MARKER: &str = "<task-notification>";
const MAX_RESULT_CHARS: usize = 6_000;

fn truncate_result(text: &str) -> String {
    if text.chars().count() <= MAX_RESULT_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_RESULT_CHARS).collect();
    format!("{head}\n… [truncated — call task_output to read the rest]")
}

/// Build the hidden `<task-notification>` reminder injected when a background
/// task finishes (a `meta` user message).
pub fn make_bg_task_notification(task: &BgTask) -> Message {
    let kind_label = match task.kind {
        BgTaskKind::Agent => "subagent",
        BgTaskKind::Bash => "shell command",
    };
    let result_text = task.result.clone().unwrap_or_else(|| task.output.clone());
    let result = truncate_result(&result_text);
    let accounting = match (task.kind, task.turns) {
        (BgTaskKind::Agent, Some(turns)) => format!(
            "<usage>{turns} turns, {} tool calls</usage>\n",
            task.tool_calls.unwrap_or(0)
        ),
        _ => String::new(),
    };

    let id = &task.id;
    let mut m = Message::user(format!(
        "<system-reminder>\n{TASK_NOTIFICATION_MARKER}\n<task-id>{id}</task-id>\n<kind>{}</kind>\n<status>{}</status>\n<description>{}</description>\n{accounting}<result>\n{result}\n</result>\n</task-notification>\nThe background {kind_label} you launched (task {id}) has {}. Its result is above. Act on it now if it unblocks the user's request; otherwise acknowledge it briefly. Use task_output(\"{id}\") to re-read the full output.\n</system-reminder>",
        task.kind.as_str(),
        task.status.as_str(),
        task.description,
        task.status.as_str(),
    ));
    m.meta = true;
    m
}

#[cfg(test)]
mod tests {
    use super::super::store::{
        BgTaskKind, BgTaskResult, BgTaskStatus, RegisterBgTaskInit, TaskStore,
    };
    use super::*;
    use std::sync::Arc;

    #[test]
    fn notification_has_marker_and_fields() {
        let s = TaskStore::new();
        let id = s.generate_id(BgTaskKind::Agent);
        s.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Agent,
            description: "research auth".into(),
            agent_type: Some("general-purpose".into()),
            command: None,
            abort: Arc::new(|| {}),
        });
        s.finish(
            &id,
            BgTaskResult {
                status: BgTaskStatus::Completed,
                result: "found it".into(),
                is_error: false,
                turns: Some(2),
                tool_calls: Some(4),
            },
        );
        let task = s.get(&id).unwrap();
        let msg = make_bg_task_notification(&task);
        assert!(msg.meta);
        assert!(msg.content.contains(TASK_NOTIFICATION_MARKER));
        assert!(msg.content.contains(&format!("<task-id>{id}</task-id>")));
        assert!(msg.content.contains("<status>completed</status>"));
        assert!(msg.content.contains("<usage>2 turns, 4 tool calls</usage>"));
        assert!(msg.content.contains("found it"));
        assert!(msg.content.contains("subagent"));
    }
}
