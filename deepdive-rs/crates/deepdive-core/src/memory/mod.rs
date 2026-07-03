//! Auto-memory subsystem — a persistent, file-based memory the agent builds up
//! across sessions. Faithful port of the TS `src/memory/*`, which itself follows
//! Claude Code's `memdir` design:
//!
//! - **directory** (`paths`): `~/.deepdive/projects/<slug>/memory/` with a
//!   `MEMORY.md` index + one topic file per fact,
//! - **system-prompt section** (`prompt`, `types`): the four-type taxonomy, when
//!   / how to save & access, and the injected `MEMORY.md` index,
//! - **recall** (`recall`, `scan`): pick topic files relevant to a user turn,
//! - **extraction** (`extract`): a turn-end forked agent that saves durable
//!   memories the main agent didn't.
//!
//! Writes/reads inside the memory dir bypass the approval gate via the
//! `is_auto_mem_path` carve-out in `tools::permissions::check_permission`.

pub mod extract;
pub mod paths;
pub mod prompt;
pub mod recall;
pub mod scan;
pub mod types;
