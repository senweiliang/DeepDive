//! Wire + persistence types. Faithful port of `src/types.ts`.
//!
//! `Message` carries both API fields and UI/persistence-only fields; the wire
//! format is the separate [`ApiMessage`], produced by [`strip_non_api_fields`]
//! (the port of client.ts `stripNonApiFields`). The plan's recommended split —
//! an explicit `ApiMessage` rather than TS's destructure-omit.

use serde::{Deserialize, Serialize};

/// Message role. Serializes to the lowercase strings the API expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// Previous-turn summary strategy. `off` preserves original full-history
/// behavior. Mirrors types.ts `TurnSummaryStrategy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSummaryStrategy {
    #[default]
    Off,
    WholeTurn,
    ToolOnly,
}

/// A completed tool call as it appears on an assistant message / in the API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    /// Always `"function"`.
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// Token usage. input/output reflect the turn; cache hit/miss are
/// session-cumulative (DeepSeek semantics). Mirrors types.ts `Usage`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_hit_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_miss_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A conversation message with all UI/persistence-only metadata. The UI-only
/// fields (`usage`, `interrupted`, `meta`, `bash`, `bash_output`, `error`) are
/// dropped before the request — see [`strip_non_api_fields`].
///
/// NOTE (P1): `turn_summary_strategy` and `subagent` from types.ts land with
/// the session/turn-summary/agents ports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,

    // ── UI / persistence-only (stripped before API) ──────────────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub meta: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bash: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bash_output: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub error: bool,
    /// Marks a hidden turn-summary message and which raw region it may replace.
    /// Stripped before API requests (ApiMessage omits it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_summary_strategy: Option<TurnSummaryStrategy>,
}

impl Message {
    fn new(role: Role, content: impl Into<String>) -> Self {
        Message {
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
            usage: None,
            interrupted: false,
            meta: false,
            bash: false,
            bash_output: None,
            error: false,
            turn_summary_strategy: None,
        }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::new(Role::System, content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::new(Role::User, content)
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new(Role::Assistant, content)
    }
    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        let mut m = Self::new(Role::Tool, content);
        m.tool_call_id = Some(tool_call_id.into());
        m
    }
}

/// The wire shape actually sent to the API — no UI/persistence fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApiMessage {
    pub role: Role,
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

/// Port of client.ts `stripNonApiFields`:
///  1. Drop client-only error notices entirely.
///  2. DeepSeek V4 reasoning rule: keep `reasoning_content` only on the
///     assistant message that performed `tool_calls`; strip it everywhere else.
///  3. Drop orphan `tool` messages whose `tool_call_id` has no matching
///     assistant `tool_calls` (e.g. synthetic inline-bash results).
pub fn strip_non_api_fields(messages: &[Message]) -> Vec<ApiMessage> {
    let stripped: Vec<ApiMessage> = messages
        .iter()
        .filter(|m| !m.error)
        .map(|m| {
            let keep_reasoning = m.role == Role::Assistant && !m.tool_calls.is_empty();
            ApiMessage {
                role: m.role,
                content: m.content.clone(),
                tool_calls: m.tool_calls.clone(),
                tool_call_id: m.tool_call_id.clone(),
                reasoning_content: if keep_reasoning {
                    m.reasoning_content.clone()
                } else {
                    None
                },
            }
        })
        .collect();

    let mut valid_ids = std::collections::HashSet::new();
    for m in &stripped {
        if m.role == Role::Assistant {
            for tc in &m.tool_calls {
                valid_ids.insert(tc.id.clone());
            }
        }
    }

    stripped
        .into_iter()
        .filter(|m| {
            if m.role != Role::Tool {
                return true;
            }
            m.tool_call_id
                .as_ref()
                .is_some_and(|id| valid_ids.contains(id))
        })
        .collect()
}

// ── Streaming deltas (parse outputs of the SSE decoder) ──────────────────────

/// One assembled SSE chunk. Mirrors types.ts `StreamChunk`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamChunk {
    pub content: String,
    pub reasoning_content: String,
    pub tool_calls: Vec<ToolCallDelta>,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub function: Option<FunctionDelta>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FunctionDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_drops_error_notices_and_ui_fields() {
        let msgs = vec![Message::user("hi"), {
            let mut m = Message::assistant("oops");
            m.error = true;
            m
        }];
        let api = strip_non_api_fields(&msgs);
        assert_eq!(api.len(), 1);
        assert_eq!(api[0].role, Role::User);
        assert_eq!(api[0].content, "hi");
    }

    #[test]
    fn strip_keeps_reasoning_only_on_toolcall_assistant() {
        let mut with_tools = Message::assistant("");
        with_tools.reasoning_content = Some("because".into());
        with_tools.tool_calls = vec![ToolCall {
            id: "c1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "read_file".into(),
                arguments: "{}".into(),
            },
        }];

        let mut plain = Message::assistant("done");
        plain.reasoning_content = Some("dropme".into());

        let api = strip_non_api_fields(&[with_tools, plain]);
        assert_eq!(api[0].reasoning_content.as_deref(), Some("because"));
        assert_eq!(api[1].reasoning_content, None);
    }

    #[test]
    fn strip_drops_orphan_tool_messages() {
        let mut assistant = Message::assistant("");
        assistant.tool_calls = vec![ToolCall {
            id: "keep".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "x".into(),
                arguments: "{}".into(),
            },
        }];
        let answered = Message::tool("keep", "result");
        let orphan = Message::tool("nomatch", "inline bash output");

        let api = strip_non_api_fields(&[assistant, answered, orphan]);
        // assistant + answered tool message survive; orphan dropped.
        assert_eq!(api.len(), 2);
        assert!(api
            .iter()
            .all(|m| m.tool_call_id.as_deref() != Some("nomatch")));
    }
}
