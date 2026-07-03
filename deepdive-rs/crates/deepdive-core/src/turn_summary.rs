//! Previous-turn summarization. Faithful port of `src/turn-summary.ts`.
//!
//! Pure functions over message history: detect the previous user turn, find
//! summarizable regions (whole-turn or runs of ≥2 pure tool blocks), build the
//! summary request, and splice persisted summaries back in place of the raw
//! messages they replace.

use crate::types::{Message, Role, TurnSummaryStrategy};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const TURN_SUMMARY_PREFIX: &str = "<previous-turn-summary>\n";
pub const TURN_SUMMARY_SUFFIX: &str = "\n</previous-turn-summary>";
const TOOL_ONLY_MIN_BLOCKS: usize = 2;

pub const TURN_SUMMARY_INSTRUCTION: &str = "Summarize the selected messages from the previous user turn so the summary can replace those raw messages in future context.\n\nCRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Do NOT include a preamble.\n\nPreserve facts needed for follow-up work:\n- The user's request and intent if it appears in the selected messages.\n- Files, functions, and code regions inspected or changed.\n- Tool results that matter, including exact short snippets when important.\n- The assistant's visible conclusion or proposed plan if present.\n- Any pending next action if the user confirms.";

fn has_tool_calls(msg: &Message) -> bool {
    msg.role == Role::Assistant && !msg.tool_calls.is_empty()
}

fn has_visible_content(msg: &Message) -> bool {
    !msg.content.trim().is_empty()
}

fn is_real_user(msg: &Message) -> bool {
    msg.role == Role::User && !msg.meta && !is_turn_summary_message(msg)
}

fn message_tool_call_ids(msg: &Message) -> HashSet<String> {
    if has_tool_calls(msg) {
        msg.tool_calls.iter().map(|tc| tc.id.clone()).collect()
    } else {
        HashSet::new()
    }
}

pub fn make_turn_summary_message(summary: &str, strategy: TurnSummaryStrategy) -> Message {
    let mut m = Message::user(format!(
        "{TURN_SUMMARY_PREFIX}{summary}{TURN_SUMMARY_SUFFIX}"
    ));
    m.meta = true;
    m.turn_summary_strategy = Some(strategy);
    m
}

pub fn is_turn_summary_message(msg: &Message) -> bool {
    msg.role == Role::User && msg.content.starts_with(TURN_SUMMARY_PREFIX)
}

pub fn previous_turn_start(messages: &[Message]) -> Option<usize> {
    (0..messages.len())
        .rev()
        .find(|&i| is_real_user(&messages[i]))
}

pub fn previous_turn_messages(messages: &[Message]) -> Vec<Message> {
    match previous_turn_start(messages) {
        None => Vec::new(),
        Some(start) => messages[start..]
            .iter()
            .filter(|m| !m.meta)
            .cloned()
            .collect(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnSummaryBlock {
    pub strategy: TurnSummaryStrategy,
    pub messages: Vec<Message>,
}

fn summary_message_payload(msg: &Message) -> Value {
    let mut o = serde_json::Map::new();
    o.insert(
        "role".into(),
        serde_json::to_value(msg.role).expect("Role serializes"),
    );
    match msg.role {
        Role::Assistant => {
            if let Some(rc) = &msg.reasoning_content {
                o.insert("reasoning_content".into(), json!(rc));
            }
            if !msg.tool_calls.is_empty() {
                o.insert(
                    "tool_calls".into(),
                    serde_json::to_value(&msg.tool_calls).expect("ToolCall serializes"),
                );
            }
        }
        Role::Tool => {
            if let Some(id) = &msg.tool_call_id {
                o.insert("tool_call_id".into(), json!(id));
            }
            o.insert("content".into(), json!(msg.content));
        }
        _ => {
            o.insert("content".into(), json!(msg.content));
        }
    }
    Value::Object(o)
}

pub fn build_turn_summary_request(messages: &[Message], instruction: &str) -> Vec<Message> {
    let payloads: Vec<Value> = messages.iter().map(summary_message_payload).collect();
    let json_text = serde_json::to_string_pretty(&Value::Array(payloads)).unwrap();
    let content = format!("{instruction}\n\nSelected messages as JSON text:\n{json_text}");
    vec![Message::user(content)]
}

pub fn previous_turn_summary_blocks(
    messages: &[Message],
    strategy: TurnSummaryStrategy,
) -> Vec<TurnSummaryBlock> {
    if strategy == TurnSummaryStrategy::Off {
        return Vec::new();
    }
    let turn = previous_turn_messages(messages);
    if turn.is_empty() {
        return Vec::new();
    }

    if strategy == TurnSummaryStrategy::WholeTurn {
        let has_non_user = turn.iter().any(|m| !is_real_user(m));
        return if has_non_user {
            vec![TurnSummaryBlock {
                strategy,
                messages: turn,
            }]
        } else {
            Vec::new()
        };
    }

    let mut blocks = Vec::new();
    let mut i = 0;
    while i < turn.len() {
        let run_start = i;
        let mut run_messages: Vec<Message> = Vec::new();
        let mut run_blocks = 0;

        while i < turn.len() {
            match tool_only_can_replace(&turn, i) {
                None => break,
                Some(end) => {
                    run_messages.extend_from_slice(&turn[i..end]);
                    run_blocks += 1;
                    i = end;
                }
            }
        }

        if run_blocks >= TOOL_ONLY_MIN_BLOCKS {
            blocks.push(TurnSummaryBlock {
                strategy,
                messages: run_messages,
            });
            continue;
        }
        i = run_start + 1;
    }
    blocks
}

pub fn should_summarize_previous_turn(messages: &[Message], strategy: TurnSummaryStrategy) -> bool {
    !previous_turn_summary_blocks(messages, strategy).is_empty()
}

fn next_summary_index(
    summaries: &[Message],
    strategy: TurnSummaryStrategy,
    start: usize,
) -> Option<usize> {
    (start..summaries.len()).find(|&i| {
        summaries[i]
            .turn_summary_strategy
            .unwrap_or(TurnSummaryStrategy::WholeTurn)
            == strategy
    })
}

fn tool_only_can_replace(turn: &[Message], index: usize) -> Option<usize> {
    let msg = &turn[index];
    if !has_tool_calls(msg) || has_visible_content(msg) {
        return None;
    }
    let expected = message_tool_call_ids(msg);
    let mut found: HashSet<String> = HashSet::new();
    let mut j = index + 1;
    while j < turn.len() {
        let next = &turn[j];
        if next.role != Role::Tool {
            break;
        }
        match &next.tool_call_id {
            Some(id) if expected.contains(id) => {
                found.insert(id.clone());
                j += 1;
            }
            _ => break,
        }
    }
    (found.len() == expected.len()).then_some(j)
}

fn apply_summaries_to_turn(turn: &[Message], summaries: &[Message]) -> Vec<Message> {
    if let Some(whole_idx) = next_summary_index(summaries, TurnSummaryStrategy::WholeTurn, 0) {
        return vec![turn[0].clone(), summaries[whole_idx].clone()];
    }

    let mut out: Vec<Message> = Vec::new();
    let mut summary_idx = 0;
    let mut i = 0;
    while i < turn.len() {
        let run_start = i;
        let mut run_blocks = 0;

        while i < turn.len() {
            match tool_only_can_replace(turn, i) {
                None => break,
                Some(end) => {
                    run_blocks += 1;
                    i = end;
                }
            }
        }

        let next_idx = next_summary_index(summaries, TurnSummaryStrategy::ToolOnly, summary_idx);
        if run_blocks >= TOOL_ONLY_MIN_BLOCKS {
            if let Some(ni) = next_idx {
                out.push(summaries[ni].clone());
                summary_idx = ni + 1;
                continue;
            }
        }

        if i > run_start {
            out.extend_from_slice(&turn[run_start..i]);
            continue;
        }

        out.push(turn[i].clone());
        i += 1;
    }
    out
}

fn flush_turn(
    out: &mut Vec<Message>,
    turn_start: &mut Option<usize>,
    turn_summaries: &mut Vec<Message>,
) {
    match *turn_start {
        None => out.append(turn_summaries),
        Some(prefix_len) => {
            let turn = out.split_off(prefix_len);
            out.extend(apply_summaries_to_turn(&turn, turn_summaries));
        }
    }
    *turn_start = None;
    turn_summaries.clear();
}

pub fn apply_turn_summaries(messages: &[Message], strategy: TurnSummaryStrategy) -> Vec<Message> {
    if strategy == TurnSummaryStrategy::Off {
        return messages
            .iter()
            .filter(|m| !is_turn_summary_message(m))
            .cloned()
            .collect();
    }

    let mut out: Vec<Message> = Vec::new();
    let mut turn_start: Option<usize> = None;
    let mut turn_summaries: Vec<Message> = Vec::new();

    for msg in messages {
        if is_turn_summary_message(msg) {
            turn_summaries.push(msg.clone());
            continue;
        }
        if is_real_user(msg) {
            flush_turn(&mut out, &mut turn_start, &mut turn_summaries);
            turn_start = Some(out.len());
        }
        out.push(msg.clone());
    }
    flush_turn(&mut out, &mut turn_start, &mut turn_summaries);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionCall, ToolCall};

    fn tool_call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: "{}".into(),
            },
        }
    }
    fn user(content: &str) -> Message {
        Message::user(content)
    }
    fn meta_user(content: &str) -> Message {
        let mut m = Message::user(content);
        m.meta = true;
        m
    }
    fn assistant(content: &str) -> Message {
        Message::assistant(content)
    }
    fn assistant_tools(content: &str, reasoning: Option<&str>, calls: Vec<ToolCall>) -> Message {
        let mut m = Message::assistant(content);
        m.reasoning_content = reasoning.map(String::from);
        m.tool_calls = calls;
        m
    }
    fn tool_msg(id: &str, content: &str) -> Message {
        Message::tool(id, content)
    }

    #[test]
    fn builds_summary_request_as_single_json_text_message() {
        let req = build_turn_summary_request(
            &[
                user("show sample 500"),
                assistant_tools(
                    "",
                    Some("I should inspect the file."),
                    vec![tool_call("call_1", "read_file")],
                ),
                tool_msg("call_1", "file content"),
            ],
            TURN_SUMMARY_INSTRUCTION,
        );
        assert_eq!(req.len(), 1);
        assert_eq!(req[0].role, Role::User);
        assert!(req[0].tool_calls.is_empty());
        let c = &req[0].content;
        assert!(c.contains(r#""reasoning_content": "I should inspect the file.""#));
        assert!(c.contains(r#""tool_calls""#));
        assert!(c.contains(r#""tool_call_id": "call_1""#));
        assert!(c.contains(r#""content": "file content""#));
        assert!(!c.contains(r#""content": """#));
        assert!(!c.contains(r#""usage""#));
    }

    #[test]
    fn disabled_by_default_strategy() {
        let history = vec![
            user("fix it"),
            assistant_tools("", Some("reason"), vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
        ];
        assert!(!should_summarize_previous_turn(
            &history,
            TurnSummaryStrategy::Off
        ));
        assert_eq!(
            apply_turn_summaries(&history, TurnSummaryStrategy::Off),
            history
        );
        let mut with_summary = history.clone();
        with_summary.push(make_turn_summary_message(
            "old summary",
            TurnSummaryStrategy::ToolOnly,
        ));
        assert_eq!(
            apply_turn_summaries(&with_summary, TurnSummaryStrategy::Off),
            history
        );
    }

    #[test]
    fn requires_two_pure_tool_blocks_for_tool_only() {
        let history = vec![
            user("fix it"),
            assistant_tools("", Some("reason"), vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
            assistant("Found it."),
        ];
        assert!(should_summarize_previous_turn(
            &history,
            TurnSummaryStrategy::WholeTurn
        ));
        assert_eq!(
            previous_turn_summary_blocks(&history, TurnSummaryStrategy::WholeTurn).len(),
            1
        );
        assert!(!should_summarize_previous_turn(
            &history,
            TurnSummaryStrategy::ToolOnly
        ));
        assert!(previous_turn_summary_blocks(&history, TurnSummaryStrategy::ToolOnly).is_empty());
    }

    #[test]
    fn groups_consecutive_pure_tool_blocks_into_one_run() {
        let history = vec![
            user("fix it"),
            assistant_tools(
                "",
                Some("I should inspect the file."),
                vec![tool_call("call_1", "read_file")],
            ),
            tool_msg("call_1", "file content"),
            assistant_tools(
                "",
                Some("I should run typecheck."),
                vec![tool_call("call_2", "bash")],
            ),
            tool_msg("call_2", "ok"),
        ];
        let blocks = previous_turn_summary_blocks(&history, TurnSummaryStrategy::ToolOnly);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].strategy, TurnSummaryStrategy::ToolOnly);
        assert_eq!(blocks[0].messages, &history[1..]);
    }

    #[test]
    fn returns_only_non_meta_messages_from_previous_turn() {
        let history = vec![
            user("older"),
            assistant("done"),
            user("fix it"),
            meta_user("<system-reminder>date</system-reminder>"),
            assistant_tools("", None, vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
        ];
        let expected = vec![
            user("fix it"),
            assistant_tools("", None, vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
        ];
        assert_eq!(previous_turn_messages(&history), expected);
    }

    #[test]
    fn whole_turn_keeps_user_and_replaces_history() {
        let summary = make_turn_summary_message(
            "Found a Static rendering bug.",
            TurnSummaryStrategy::WholeTurn,
        );
        let messages = vec![
            user("hello"),
            assistant("hi"),
            user("fix it"),
            assistant_tools(
                "",
                Some("raw reasoning"),
                vec![tool_call("call_1", "read_file")],
            ),
            tool_msg("call_1", "file content"),
            assistant("Found it."),
            summary.clone(),
            user("好的"),
        ];
        let expected = vec![
            user("hello"),
            assistant("hi"),
            user("fix it"),
            summary,
            user("好的"),
        ];
        assert_eq!(
            apply_turn_summaries(&messages, TurnSummaryStrategy::WholeTurn),
            expected
        );
    }

    #[test]
    fn tool_only_keeps_single_pure_block_even_with_old_summary() {
        let summary = make_turn_summary_message(
            "Read file and found the bug.",
            TurnSummaryStrategy::ToolOnly,
        );
        let final_answer = assistant("Found it.");
        let messages = vec![
            user("fix it"),
            assistant_tools(
                "",
                Some("raw reasoning"),
                vec![tool_call("call_1", "read_file")],
            ),
            tool_msg("call_1", "file content"),
            final_answer.clone(),
            summary,
            user("好的"),
        ];
        let expected = vec![
            user("fix it"),
            assistant_tools(
                "",
                Some("raw reasoning"),
                vec![tool_call("call_1", "read_file")],
            ),
            tool_msg("call_1", "file content"),
            final_answer,
            user("好的"),
        ];
        assert_eq!(
            apply_turn_summaries(&messages, TurnSummaryStrategy::ToolOnly),
            expected
        );
    }

    #[test]
    fn tool_only_keeps_visible_tool_assistant_block() {
        let summary = make_turn_summary_message(
            "No block should be replaced.",
            TurnSummaryStrategy::ToolOnly,
        );
        let visible = assistant_tools(
            "确实有乱码。加个 UTF-8 BOM 就能解决：",
            Some("raw reasoning that must stay with tool_calls"),
            vec![tool_call("call_1", "bash")],
        );
        let tool_result = tool_msg("call_1", "done");
        let messages = vec![
            user("怎么有乱码呢"),
            visible.clone(),
            tool_result.clone(),
            assistant("已修复。"),
            summary,
            user("好的"),
        ];
        assert!(previous_turn_summary_blocks(
            &messages[..messages.len() - 2],
            TurnSummaryStrategy::ToolOnly
        )
        .is_empty());
        let expected = vec![
            user("怎么有乱码呢"),
            visible,
            tool_result,
            assistant("已修复。"),
            user("好的"),
        ];
        assert_eq!(
            apply_turn_summaries(&messages, TurnSummaryStrategy::ToolOnly),
            expected
        );
    }

    #[test]
    fn tool_only_replaces_one_run_with_one_summary() {
        let summary = make_turn_summary_message(
            "Read file and ran typecheck.",
            TurnSummaryStrategy::ToolOnly,
        );
        let messages = vec![
            user("fix it"),
            assistant_tools("", None, vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
            assistant_tools("", None, vec![tool_call("call_2", "bash")]),
            tool_msg("call_2", "typecheck ok"),
            summary.clone(),
            user("继续"),
        ];
        let expected = vec![user("fix it"), summary, user("继续")];
        assert_eq!(
            apply_turn_summaries(&messages, TurnSummaryStrategy::ToolOnly),
            expected
        );
    }

    #[test]
    fn tool_only_starts_new_run_after_visible_content() {
        let summary1 =
            make_turn_summary_message("First search run.", TurnSummaryStrategy::ToolOnly);
        let summary2 =
            make_turn_summary_message("Second verification run.", TurnSummaryStrategy::ToolOnly);
        let middle = assistant("Need one more check.");
        let messages = vec![
            user("fix it"),
            assistant_tools("", None, vec![tool_call("call_1", "read_file")]),
            tool_msg("call_1", "file content"),
            assistant_tools("", None, vec![tool_call("call_2", "grep")]),
            tool_msg("call_2", "grep result"),
            middle.clone(),
            assistant_tools("", None, vec![tool_call("call_3", "bash")]),
            tool_msg("call_3", "typecheck ok"),
            assistant_tools("", None, vec![tool_call("call_4", "read_file")]),
            tool_msg("call_4", "file content"),
            summary1.clone(),
            summary2.clone(),
            user("继续"),
        ];
        let expected = vec![user("fix it"), summary1, middle, summary2, user("继续")];
        assert_eq!(
            apply_turn_summaries(&messages, TurnSummaryStrategy::ToolOnly),
            expected
        );
    }
}
