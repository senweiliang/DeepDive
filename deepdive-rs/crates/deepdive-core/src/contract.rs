//! The frozen engine ↔ frontend contract.
//!
//! This is the seam that lets the TUI (P3) and GUI (P4) be built independently
//! against a stub while the engine is ported. Core emits [`AgentEvent`]s over a
//! `tokio::mpsc` channel and receives [`UiToCore`] commands over a second one;
//! human approvals ride a `oneshot` channel embedded in the event (the moral
//! equivalent of the React `resolve` callback that `App.tsx` awaits).
//!
//! Most of these types are intentionally ahead of their first use — they define
//! the target shape so frontend work can start now.

use crate::types::{Message, TurnSummaryStrategy, Usage};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::oneshot;

/// Approval mode. Port of types.ts `ApprovalMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApprovalMode {
    Plan,
    Default,
    AcceptEdits,
    Yolo,
    #[default]
    Auto,
}

/// What a tool is allowed to do — the single source of truth that drives
/// approval gating (replaces approval.ts's three capability `Set`s).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    ReadOnly,
    Write,
    Exec,
}

/// A human approval decision. Richer than a boolean: `AllowAlways` persists a
/// rule (the patterns), matching `setPendingTool`'s `onAllowAlways`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
    AllowAlways(Vec<String>),
}

/// An approval request handed to the frontend.
#[derive(Debug, Clone)]
pub struct ApprovalReq {
    pub tool_name: String,
    pub args: Value,
    /// Human-readable warning (e.g. out-of-workspace write).
    pub warning: Option<String>,
    /// Candidate patterns the user could choose to "always allow".
    pub save_patterns: Vec<String>,
}

/// One `ask_user_question` item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
}

/// A finished tool result as the UI should render it.
#[derive(Debug, Clone)]
pub struct ToolResultView {
    pub content: String,
    pub is_error: bool,
    /// One-line tag, e.g. "120 lines" / "5 matches".
    pub tag: Option<String>,
}

/// Streamed engine → frontend events. Frontends fold these into their own
/// render model (this is why ratatui needs no `<Static>`/scrollback hacks).
#[derive(Debug)]
pub enum AgentEvent {
    TurnStarted {
        turn: u32,
    },
    ThinkingDelta(String),
    ContentDelta(String),
    AssistantMessage(Message),
    ToolStarted {
        call_id: String,
        name: String,
        summary: String,
    },
    ToolFinished {
        call_id: String,
        result: ToolResultView,
    },
    /// Blocks the loop until the frontend sends a decision back on `reply`.
    ApprovalRequest {
        req: ApprovalReq,
        reply: oneshot::Sender<ApprovalDecision>,
    },
    AskQuestion {
        items: Vec<Question>,
        reply: oneshot::Sender<Option<HashMap<String, String>>>,
    },
    BashOutput {
        task_id: u64,
        chunk: String,
    },
    Usage(Usage),
    /// Live subagent progress, tagged with the `agent` tool's call_id so the UI
    /// can attach it to that tool card (turn / tool-call counters + activity).
    SubagentProgress {
        call_id: String,
        agent_type: String,
        turn: u32,
        tool_calls: u32,
        activity: String,
    },
    /// One intermediate tool call a subagent made (for the step trail).
    SubagentStep {
        call_id: String,
        name: String,
        summary: String,
    },
    /// Number of background tasks currently running (footer "⚙ N" counter).
    BackgroundCount(usize),
    /// First-turn interruption: hand the typed text back to the input box.
    Recall(String),
    /// The pre-turn memory recall surfaced `count` topic files relevant to the
    /// user's query — the frontend shows a dim "Recalled N memories" marker.
    MemoryRecalled {
        count: usize,
    },
    TurnComplete {
        finish_reason: Option<String>,
    },
    Error(String),
    /// Answer to a `/btw` side question (port of Claude Code's /btw + TS
    /// side-question.ts). `Ok(Some(text))` is the model's answer; `Ok(None)`
    /// means no response came back (interrupted / genuinely empty); `Err` is
    /// a transport/API failure. Never mutates the main session.
    SideQuestion {
        question: String,
        result: Result<Option<String>, String>,
    },
}

/// Frontend → engine commands (second mpsc channel).
#[derive(Debug, Clone)]
pub enum UiToCore {
    /// New user input. The loop drains queued inputs after each tool result
    /// (replaces App.tsx's `drainBatch`).
    UserInput(String),
    ModeChange(ApprovalMode),
    Abort,
    /// Compact the conversation now (manual `/compact`). Honoured by the engine
    /// task when idle; ignored mid-submission.
    Compact,
    /// Start a fresh conversation (manual `/clear`). Idle-only; mid-submission
    /// it is ignored.
    Clear,
    /// Add a directory to the session-scoped out-of-workspace grant list
    /// (manual `/add-dir`). The path is already expanded/validated by the caller.
    AddDir(String),
    /// Rename the current session, persisting its title (manual `/rename`).
    /// Applied both idle and mid-submission (it only writes the session meta).
    Rename(String),
    /// Re-scan custom agents and rebuild the in-session agent listing (manual
    /// `/agents`), so a freshly-edited agent becomes dispatchable without a
    /// restart. Port of agents.ts dropping the stale listing for re-injection.
    ReloadAgents,
    /// Apply settings live to the engine `Config` (manual `/model` & `/settings`).
    /// Idle-only, like Compact/Clear: the frontend guards it behind a busy check,
    /// so the engine task's idle arm is the single writer of the live `config`.
    /// `response_language` is deliberately NOT carried — it is frozen per session
    /// at startup (parity with App.tsx: language changes affect new sessions only).
    ApplySettings {
        model: String,
        reasoning_effort: String,
        tavily_api_key: String,
        turn_summary_strategy: TurnSummaryStrategy,
    },
    /// Ask a `/btw` side question (or a follow-up in the same side thread).
    /// Unlike every other command, this is meant to be answered even while a
    /// turn is running — the engine spawns an independent fork off a
    /// snapshot of the current history the moment it dequeues this (idle arm
    /// or the turn loop's next drain checkpoint), so it never blocks on or
    /// interferes with an in-flight turn.
    AskSideQuestion {
        question: String,
        /// This side thread's own already-answered exchanges (plain
        /// user/assistant pairs, no reminder) — empty for a fresh `/btw`.
        prior_exchanges: Vec<Message>,
    },
}

/// Execution context handed to a tool.
pub struct ToolCtx {
    pub cwd: std::path::PathBuf,
}

/// A tool the agent can call. Dynamic dispatch over `Box<dyn Tool>` replaces
/// the TS `switch(name)` scattered across executor/App/run; `capability()` is
/// the single source of truth for approval gating.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    /// The tool's JSON schema, serialized verbatim into the request `tools`
    /// array (kept byte-stable for DeepSeek prefix caching).
    fn schema(&self) -> Value;
    fn capability(&self) -> Capability;
    async fn execute(&self, args: Value, ctx: &ToolCtx) -> ToolResultView;
}
