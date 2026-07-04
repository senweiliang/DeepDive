//! RPC bridge for GUI frontends (Tauri / web). [`AgentEvent`] carries `oneshot`
//! reply channels and a `Message`, neither of which crosses a JSON/IPC boundary;
//! [`Bridge`] converts each event into a serializable [`UiEvent`], stashing any
//! pending reply channel under a numeric `id` the frontend echoes back via
//! [`Bridge::approve`] / [`Bridge::answer`].
//!
//! This is the same role the ratatui TUI's `main.rs` plays inline (holding the
//! oneshots in local `Option`s), extracted into a transport-agnostic, testable
//! unit so the Tauri shell stays a thin wrapper.

use crate::contract::{AgentEvent, ApprovalDecision};
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::oneshot;

/// JSON-serializable mirror of [`AgentEvent`]. The non-serializable reply
/// channels of `ApprovalRequest`/`AskQuestion` become an `id` the frontend
/// echoes back.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiEvent {
    TurnStarted { turn: u32 },
    Thinking { text: String },
    Content { text: String },
    Assistant { content: String, interrupted: bool },
    #[serde(rename_all = "camelCase")]
    ToolStarted { call_id: String, name: String, summary: String },
    #[serde(rename_all = "camelCase")]
    ToolFinished {
        call_id: String,
        tag: Option<String>,
        ok: bool,
        /// The tool's result content (capped) so the UI can show a preview.
        preview: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Approval {
        id: u64,
        tool_name: String,
        args: String,
        warning: Option<String>,
        save_patterns: Vec<String>,
    },
    Question { id: u64, items: Vec<UiQuestion> },
    BashOutput { chunk: String },
    #[serde(rename_all = "camelCase")]
    Usage {
        input: u64,
        output: u64,
        /// Prompt cache hit/miss tokens (for the cache-hit %), when reported.
        cache_hit: Option<u64>,
        cache_miss: Option<u64>,
        /// Reasoning (thinking) tokens, when reported.
        reasoning: Option<u64>,
    },
    Recall { text: String },
    /// Pre-turn memory recall surfaced `count` relevant topic files — the GUI
    /// shows a dim "Recalled N memories" marker.
    MemoryRecalled { count: usize },
    /// The auto router picked `model` for this turn — footer shows `Auto(pro)` /
    /// `Auto(flash)`.
    ModelRouted { model: String },
    BgTasks { running: usize },
    #[serde(rename_all = "camelCase")]
    SubagentProgress {
        call_id: String,
        agent_type: String,
        turn: u32,
        tool_calls: u32,
        activity: String,
    },
    #[serde(rename_all = "camelCase")]
    SubagentStep {
        call_id: String,
        name: String,
        summary: String,
        result: String,
    },
    TurnComplete,
    Error { message: String },
    /// Answer to a `/btw` side question — see `AgentEvent::SideQuestion`.
    SideQuestion {
        question: String,
        response: Option<String>,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiQuestion {
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
}

/// Holds the pending reply channels for in-flight approvals/questions, keyed by
/// the id handed to the frontend. Not `Send`-shared internally — wrap in a
/// `Mutex` at the transport layer if multiple tasks touch it.
#[derive(Default)]
pub struct Bridge {
    next_id: u64,
    approvals: HashMap<u64, (oneshot::Sender<ApprovalDecision>, Vec<String>)>,
    questions: HashMap<u64, oneshot::Sender<Option<HashMap<String, String>>>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convert one engine event into a serializable [`UiEvent`], registering any
    /// pending reply channel under a fresh id.
    pub fn ingest(&mut self, ev: AgentEvent) -> UiEvent {
        match ev {
            AgentEvent::TurnStarted { turn } => UiEvent::TurnStarted { turn },
            AgentEvent::ThinkingDelta(text) => UiEvent::Thinking { text },
            AgentEvent::ContentDelta(text) => UiEvent::Content { text },
            AgentEvent::AssistantMessage(m) => UiEvent::Assistant {
                content: m.content,
                interrupted: m.interrupted,
            },
            AgentEvent::ToolStarted { call_id, name, summary } => {
                UiEvent::ToolStarted { call_id, name, summary }
            }
            AgentEvent::ToolFinished { call_id, result } => {
                let preview: String = result.content.chars().take(4000).collect();
                UiEvent::ToolFinished {
                    call_id,
                    tag: result.tag,
                    ok: !result.is_error,
                    preview: (!preview.trim().is_empty()).then_some(preview),
                }
            }
            AgentEvent::ApprovalRequest { req, reply } => {
                let id = self.alloc();
                self.approvals.insert(id, (reply, req.save_patterns.clone()));
                UiEvent::Approval {
                    id,
                    tool_name: req.tool_name,
                    args: req.args.to_string(),
                    warning: req.warning,
                    save_patterns: req.save_patterns,
                }
            }
            AgentEvent::AskQuestion { items, reply } => {
                let id = self.alloc();
                self.questions.insert(id, reply);
                UiEvent::Question {
                    id,
                    items: items
                        .into_iter()
                        .map(|q| UiQuestion {
                            header: q.header,
                            question: q.question,
                            // GUI contract stays label-only (`string[]`); the
                            // description sub-line is a TUI/CLI feature for now.
                            options: q.options.into_iter().map(|o| o.label).collect(),
                            multi_select: q.multi_select,
                        })
                        .collect(),
                }
            }
            AgentEvent::BashOutput { chunk, .. } => UiEvent::BashOutput { chunk },
            AgentEvent::Usage(u) => UiEvent::Usage {
                input: u.input_tokens,
                output: u.output_tokens,
                cache_hit: u.prompt_cache_hit_tokens,
                cache_miss: u.prompt_cache_miss_tokens,
                reasoning: u.reasoning_tokens,
            },
            AgentEvent::SubagentProgress { call_id, agent_type, turn, tool_calls, activity } => {
                UiEvent::SubagentProgress { call_id, agent_type, turn, tool_calls, activity }
            }
            AgentEvent::SubagentStep { call_id, name, summary, result } => {
                UiEvent::SubagentStep { call_id, name, summary, result }
            }
            AgentEvent::BackgroundCount(running) => UiEvent::BgTasks { running },
            AgentEvent::Recall(text) => UiEvent::Recall { text },
            AgentEvent::MemoryRecalled { count } => UiEvent::MemoryRecalled { count },
            AgentEvent::ModelRouted { model } => UiEvent::ModelRouted { model },
            AgentEvent::TurnComplete { .. } => UiEvent::TurnComplete,
            AgentEvent::Error(message) => UiEvent::Error { message },
            AgentEvent::SideQuestion { question, result } => {
                let (response, error) = match result {
                    Ok(Some(text)) => (Some(text), None),
                    Ok(None) => (None, Some("No response received".to_string())),
                    Err(msg) => (None, Some(msg)),
                };
                UiEvent::SideQuestion { question, response, error }
            }
        }
    }

    fn alloc(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Resolve a pending approval. `decision` is `"approve"` | `"always"` |
    /// anything-else-means-deny. Returns false if the id is unknown / already
    /// resolved. `"always"` replays the patterns captured at request time.
    pub fn approve(&mut self, id: u64, decision: &str) -> bool {
        match self.approvals.remove(&id) {
            Some((tx, patterns)) => {
                let d = match decision {
                    "approve" => ApprovalDecision::Approve,
                    "always" => ApprovalDecision::AllowAlways(patterns),
                    _ => ApprovalDecision::Deny,
                };
                let _ = tx.send(d);
                true
            }
            None => false,
        }
    }

    /// Resolve a pending question (`None` = declined). Returns false if unknown.
    pub fn answer(&mut self, id: u64, answers: Option<HashMap<String, String>>) -> bool {
        match self.questions.remove(&id) {
            Some(tx) => {
                let _ = tx.send(answers);
                true
            }
            None => false,
        }
    }

    /// Drop all pending replies (resolving them negatively for the engine) — used
    /// on shutdown so `run_turn_loop` never hangs waiting on a closed frontend.
    pub fn close(&mut self) {
        self.approvals.clear();
        self.questions.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{ApprovalReq, Question};
    use serde_json::json;

    #[test]
    fn ingest_maps_simple_events() {
        let mut b = Bridge::new();
        assert_eq!(
            b.ingest(AgentEvent::TurnStarted { turn: 3 }),
            UiEvent::TurnStarted { turn: 3 }
        );
        assert_eq!(
            b.ingest(AgentEvent::ThinkingDelta("t".into())),
            UiEvent::Thinking { text: "t".into() }
        );
        assert_eq!(
            b.ingest(AgentEvent::Error("boom".into())),
            UiEvent::Error { message: "boom".into() }
        );
        assert_eq!(
            b.ingest(AgentEvent::TurnComplete { finish_reason: Some("stop".into()) }),
            UiEvent::TurnComplete
        );
    }

    #[test]
    fn approval_round_trips_through_id() {
        let mut b = Bridge::new();
        let (tx, mut rx) = oneshot::channel();
        let ev = AgentEvent::ApprovalRequest {
            req: ApprovalReq {
                tool_name: "bash".into(),
                args: json!({ "command": "ls" }),
                warning: None,
                save_patterns: vec!["Bash(ls:*)".into()],
            },
            reply: tx,
        };
        let ui = b.ingest(ev);
        let id = match ui {
            UiEvent::Approval { id, tool_name, .. } => {
                assert_eq!(tool_name, "bash");
                id
            }
            _ => panic!("expected Approval"),
        };
        // unknown id is a no-op
        assert!(!b.approve(id + 99, "approve"));
        // resolve "always" → replays captured patterns
        assert!(b.approve(id, "always"));
        assert_eq!(
            rx.try_recv().unwrap(),
            ApprovalDecision::AllowAlways(vec!["Bash(ls:*)".into()])
        );
        // second resolve is a no-op (already removed)
        assert!(!b.approve(id, "approve"));
    }

    #[test]
    fn deny_is_the_default_decision() {
        let mut b = Bridge::new();
        let (tx, mut rx) = oneshot::channel();
        let ev = AgentEvent::ApprovalRequest {
            req: ApprovalReq {
                tool_name: "write_file".into(),
                args: json!({}),
                warning: Some("outside".into()),
                save_patterns: vec![],
            },
            reply: tx,
        };
        let id = match b.ingest(ev) {
            UiEvent::Approval { id, .. } => id,
            _ => panic!(),
        };
        assert!(b.approve(id, "nope"));
        assert_eq!(rx.try_recv().unwrap(), ApprovalDecision::Deny);
    }

    #[test]
    fn serializes_all_fields_as_camel_case() {
        let mut b = Bridge::new();
        let js = serde_json::to_value(b.ingest(AgentEvent::ToolStarted {
            call_id: "c1".into(),
            name: "glob".into(),
            summary: "x".into(),
        }))
        .unwrap();
        assert_eq!(js["kind"], "toolStarted");
        assert_eq!(js["callId"], "c1"); // variant-level rename_all → camelCase fields
        let (tx, _rx) = oneshot::channel();
        let js2 = serde_json::to_value(b.ingest(AgentEvent::ApprovalRequest {
            req: ApprovalReq {
                tool_name: "bash".into(),
                args: json!({}),
                warning: None,
                save_patterns: vec!["P".into()],
            },
            reply: tx,
        }))
        .unwrap();
        assert_eq!(js2["kind"], "approval");
        assert_eq!(js2["toolName"], "bash");
        assert_eq!(js2["savePatterns"][0], "P");
    }

    #[test]
    fn subagent_events_serialize_as_camel_case() {
        let mut b = Bridge::new();
        let p = serde_json::to_value(b.ingest(AgentEvent::SubagentProgress {
            call_id: "a1".into(),
            agent_type: "explore".into(),
            turn: 2,
            tool_calls: 3,
            activity: "scan".into(),
        }))
        .unwrap();
        assert_eq!(p["kind"], "subagentProgress");
        assert_eq!(p["callId"], "a1");
        assert_eq!(p["agentType"], "explore");
        assert_eq!(p["toolCalls"], 3);
        let s = serde_json::to_value(b.ingest(AgentEvent::SubagentStep {
            call_id: "a1".into(),
            name: "glob".into(),
            summary: "**/*.rs".into(),
            result: "12 matches".into(),
        }))
        .unwrap();
        assert_eq!(s["kind"], "subagentStep");
        assert_eq!(s["callId"], "a1");
        assert_eq!(s["name"], "glob");
        assert_eq!(s["result"], "12 matches");
    }

    #[test]
    fn usage_carries_cache_and_reasoning_as_camel_case() {
        let mut b = Bridge::new();
        let js = serde_json::to_value(b.ingest(AgentEvent::Usage(crate::types::Usage {
            input_tokens: 1200,
            output_tokens: 80,
            prompt_cache_hit_tokens: Some(900),
            prompt_cache_miss_tokens: Some(300),
            reasoning_tokens: Some(45),
        })))
        .unwrap();
        assert_eq!(js["kind"], "usage");
        assert_eq!(js["input"], 1200);
        assert_eq!(js["output"], 80);
        assert_eq!(js["cacheHit"], 900);
        assert_eq!(js["cacheMiss"], 300);
        assert_eq!(js["reasoning"], 45);
    }

    #[test]
    fn question_round_trips_and_serializes() {
        let mut b = Bridge::new();
        let (tx, mut rx) = oneshot::channel();
        let ev = AgentEvent::AskQuestion {
            items: vec![Question {
                header: "h".into(),
                question: "pick".into(),
                options: vec![
                    crate::contract::AskOption { label: "A".into(), description: String::new() },
                    crate::contract::AskOption { label: "B".into(), description: "second".into() },
                ],
                multi_select: false,
            }],
            reply: tx,
        };
        let ui = b.ingest(ev);
        // serializes with a camelCase tag + fields
        let js = serde_json::to_value(&ui).unwrap();
        assert_eq!(js["kind"], "question");
        assert_eq!(js["items"][0]["multiSelect"], false);
        let id = match ui {
            UiEvent::Question { id, .. } => id,
            _ => panic!(),
        };
        let mut answers = HashMap::new();
        answers.insert("pick".to_string(), "A".to_string());
        assert!(b.answer(id, Some(answers.clone())));
        assert_eq!(rx.try_recv().unwrap(), Some(answers));
    }

    #[test]
    fn ids_are_unique_and_monotonic() {
        let mut b = Bridge::new();
        let mk = || {
            let (tx, _rx) = oneshot::channel();
            AgentEvent::ApprovalRequest {
                req: ApprovalReq {
                    tool_name: "bash".into(),
                    args: json!({}),
                    warning: None,
                    save_patterns: vec![],
                },
                reply: tx,
            }
        };
        let a = b.ingest(mk());
        let c = b.ingest(mk());
        let ida = match a {
            UiEvent::Approval { id, .. } => id,
            _ => panic!(),
        };
        let idc = match c {
            UiEvent::Approval { id, .. } => id,
            _ => panic!(),
        };
        assert_ne!(ida, idc);
        assert!(idc > ida);
    }
}
