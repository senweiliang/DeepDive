//! Render layer: pure functions that turn the [`crate::app::AppState`] model into
//! ratatui `Vec<Line>` / widgets. Each submodule owns one component. The function
//! signatures here are FROZEN by the Scaffold stage — Module agents only fill in
//! the bodies of their own file, they do not change signatures, `mod.rs`,
//! `app.rs`'s public types, or `theme.rs`.
//!
//! The frozen signatures/constants below are intentionally ahead of their first
//! use (Module agents fill the bodies that consume them), so dead-code lints are
//! silenced module-wide here.
#![allow(dead_code)]

pub mod banner;
pub mod footer;
pub mod fullscreen;
pub mod input;
pub mod markdown;
pub mod modals;
pub mod running;
pub mod setup;
pub mod transcript;

/// Widest a full-bleed row (user bar, rule line) may be. Leaving the last column
/// empty is load-bearing on Windows: conhost wraps the instant the final column
/// is written, so a `cols`-wide row occupies two physical rows while the renderer
/// counts one — the redraw then under-erases and the previous frame bleeds
/// through (a user message printed twice). Mirrors TS `barWidth`.
pub fn bar_width(cols: usize) -> usize {
    cols.saturating_sub(1)
}
