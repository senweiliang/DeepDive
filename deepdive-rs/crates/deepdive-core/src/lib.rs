//! `deepdive-core` — the framework-agnostic DeepDive engine (Rust rewrite).
//!
//! Port status (P0 vertical slice): config (minimal), the frozen frontend
//! contract, the SSE decoder, the chat stream, and turn assembly. The TUI and
//! GUI frontends consume [`contract::AgentEvent`] / [`contract::UiToCore`].
//!
//! Many contract types are intentionally ahead of first use; allow dead_code
//! until the engine loop (P2) and frontends (P3/P4) consume them.
#![allow(dead_code)]

pub mod agents;
pub mod balance;
pub mod bridge;
pub mod client;
pub mod config;
pub mod contract;
pub mod engine;
pub mod memory;
pub mod session;
pub mod side_question;
pub mod skills;
pub mod sse;
pub mod tasks;
pub mod tools;
pub mod turn;
pub mod turn_summary;
pub mod types;
pub mod workspace;

pub use bridge::{Bridge, UiEvent, UiQuestion};
pub use config::Config;
pub use contract::{AgentEvent, ApprovalDecision, ApprovalMode, Capability, Tool, UiToCore};
pub use tools::permissions::{check_permission, PermissionConfig, PermissionDecision};
pub use types::{
    strip_non_api_fields, ApiMessage, FunctionCall, Message, Role, StreamChunk, ToolCall,
    TurnSummaryStrategy, Usage,
};
