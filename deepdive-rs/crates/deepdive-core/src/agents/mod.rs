//! Agents subsystem. Faithful port of `src/agents/*` (minus `run.ts`, the
//! subagent loop, which lands with the engine loop in P2).

pub mod builtin;
pub mod listing;
pub mod load;
pub mod registry;
pub mod run;
pub mod types;

pub use types::AgentDefinition;
