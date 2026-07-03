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
pub mod input;
pub mod markdown;
pub mod modals;
pub mod running;
pub mod transcript;
