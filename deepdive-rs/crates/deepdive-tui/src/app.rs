//! The TUI render model — a pure, framework-agnostic fold of [`AgentEvent`]s
//! into a transcript + live streaming state + modal state. ratatui reads this;
//! it never depends on ratatui, so it is unit-testable without a terminal.
//!
//! The engine→UI reply channels (oneshot senders inside `ApprovalRequest`/
//! `AskQuestion`) are intentionally NOT held here — the run loop owns them and
//! tells the model what to display via [`AppState::show_approval`] /
//! [`AppState::show_question`]. This keeps the model `Clone`-free of channels and
//! trivially testable.

use crate::render::input::InputState;
use deepdive_core::config::{model_context_window, CHAT_MODELS};
use deepdive_core::contract::Question;
use deepdive_core::types::{Message, TurnSummaryStrategy};
use deepdive_core::{ApprovalMode, Usage};
use std::collections::{HashMap, HashSet};

/// One line of a structured diff (§5 Diff). `kind` decides row-number color +
/// row background; `old`/`new` are the (optional) line numbers in each side.
#[allow(dead_code)] // consumed by render::transcript (Module stage) + future diff folding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
    /// Line number to show in the gutter (already resolved for the shown side).
    pub num: Option<u32>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Add,
    Del,
    Context,
}

/// One committed transcript row. Each variant renders to `Vec<Line>` in
/// `render::transcript` and is pushed to native scrollback via `insert_before`.
#[allow(dead_code)] // `Diff` is folded once edit/write diffs are wired (Module stage).
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    /// Normal user message (`> ` prompt, `#3a3a3a` bar).
    User(String),
    /// Bash user message (`! ` prompt). `output`, when present, renders as a
    /// `⎿` result block (un-truncated).
    UserBash { command: String, output: Option<String> },
    /// Assistant message — rendered through `render_markdown`; first line `● `,
    /// continuation lines `  `. Used for resumed/whole-message history.
    Assistant(String),
    /// A frozen chunk of a streaming answer (a complete markdown-block prefix).
    /// `bullet` marks the answer's very first chunk (`● `; later chunks `  `).
    StreamChunk { text: String, bullet: bool },
    /// Reasoning. Folded by default (Scaffold may keep it always-folded).
    Thinking { content: String, expanded: bool },
    /// A tool call card: `● Name(args)` + `⎿` result.
    Tool {
        name: String,
        summary: String,
        /// The tool's result body, rendered as the `⎿` block (truncated to 3
        /// lines). `None` hides the result line. `ok` drives only the dot color;
        /// the body is red only when it starts with "Error:" (Chat.tsx `tone`).
        output: Option<String>,
        ok: bool,
    },
    /// edit_file / write_file diff (§5 Diff).
    Diff {
        added: u32,
        removed: u32,
        lines: Vec<DiffLine>,
    },
    /// A subagent run: header tool line + indented step trail + optional summary.
    SubagentGroup {
        header: String,
        steps: Vec<String>,
        summary: Option<String>,
    },
    /// A dim note (e.g. /compact progress).
    Note(String),
    /// An error (first line `● ` red, continuations `  ` red).
    Error(String),
    /// A compaction summary block (rules + centered marker + indented body).
    Compaction(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Busy,
}

/// The resume-picker's committed choice (SessionPicker.tsx `onSelect`): either
/// the `+ New session` row or a concrete session id. Row 0 is always New; a real
/// session lives at `selected - 1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumePick {
    New,
    Session(String),
}

/// One entry in the `/model` picker (mirrors ModelPanel.tsx `ModelOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelEntry {
    pub value: String,
    pub label: String,
    pub desc: String,
    /// Whether this is the currently-active model (renders a trailing `✓`).
    pub selected: bool,
}

/// One selectable option within a `/settings` enum row (SettingsPanel.tsx
/// `SettingOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
    pub desc: String,
}

/// One row of the `/settings` panel (SettingsPanel.tsx `EnumSpec`). `key` decides
/// which config field the chosen option writes to; `secret_when` reveals the
/// Tavily-key sub-line when the selected option's value equals it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsRow {
    pub key: String,
    pub label: String,
    pub options: Vec<SettingOption>,
    pub sel: usize,
    pub secret_when: Option<String>,
}

/// The values collected from the `/settings` panel on save — persisted to disk
/// and applied live to the engine `Config` (port of SettingsPanel `onSave`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsValues {
    pub model: String,
    pub reasoning_effort: String,
    pub tavily_api_key: String,
    pub response_language: String,
    pub turn_summary: TurnSummaryStrategy,
}

/// A blocking modal awaiting user input. The reply oneshot is held by the run
/// loop, not here; the model only carries what to render + local selection state.
#[derive(Debug, Default, Clone, PartialEq)]
pub enum Modal {
    #[default]
    None,
    Approval {
        tool_name: String,
        args_summary: String,
        warning: Option<String>,
        save_patterns: Vec<String>,
        selected: usize,
    },
    Question {
        items: Vec<Question>,
        /// The focused nav tab: `0..items.len()` are questions, `items.len()` is
        /// the Submit tab (AskQuestion.tsx `qIndex` / `submitIndex`).
        idx: usize,
        /// Cursor row within the current question: `0..options.len()` are options,
        /// `options.len()` is the free-form "Other" row.
        selected: usize,
        answers: HashMap<String, String>,
        /// Live multi-select checkbox state for the CURRENT question (cleared on
        /// tab switch, restored from a recorded answer by `question_go_to`).
        checked: HashSet<usize>,
        /// Live "Other" free-form buffer for the CURRENT question.
        other_text: String,
    },
    /// Session picker for `/resume`.
    Resume {
        sessions: Vec<SessionEntry>,
        selected: usize,
    },
    /// `/model` picker (ModelPanel.tsx).
    Model {
        entries: Vec<ModelEntry>,
        selected: usize,
    },
    /// `/settings` panel (SettingsPanel.tsx): `row` is the navigable row, each
    /// row holds its own pending option index, `tavily_key` is the secret buffer.
    Settings {
        rows: Vec<SettingsRow>,
        row: usize,
        tavily_key: String,
    },
    /// `/add-dir` out-of-workspace grant confirm (AddDirConfirm.tsx).
    AddDir { path: String, selected: usize },
    /// `/btw` side question thread (BtwPanel — port of Claude Code's /btw,
    /// extended to allow a few follow-ups). `draft` is the follow-up input
    /// buffer, only editable once the last exchange has settled.
    Btw {
        exchanges: Vec<BtwExchange>,
        draft: String,
    },
}

/// One question/answer pair in a `/btw` side thread. `response`/`error` are
/// both `None` while the fork for this exchange is in flight (spinner shown).
#[derive(Debug, Clone, PartialEq)]
pub struct BtwExchange {
    pub question: String,
    pub response: Option<String>,
    pub error: Option<String>,
}

/// One row in the `/resume` session picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEntry {
    pub id: String,
    pub title: String,
    /// Relative time label (e.g. "2h ago"); optional.
    pub when: Option<String>,
    /// Message count for the dim subtitle; optional.
    pub msgs: Option<usize>,
}

pub struct AppState {
    /// Committed transcript rows. NOTE: in the inline-viewport architecture these
    /// are pushed to native scrollback via `insert_before` as they are committed;
    /// this Vec is the render-model record of what was committed (also used by
    /// `/clear`, `/resume` history reload, and tests).
    pub rows: Vec<Row>,
    /// Index of the first row not yet flushed to scrollback (main.rs flushes the
    /// tail `rows[committed..]` and advances this).
    pub committed: usize,
    /// Whether the session banner has been emitted to scrollback yet.
    pub banner_shown: bool,
    /// Current-turn streaming buffers (shown live in the bottom frame while busy).
    pub live_thinking: String,
    pub live_content: String,
    /// The input-box editor state (multi-line buffer + cursor + slash menu, §7).
    pub input: InputState,
    pub status: Status,
    pub mode: ApprovalMode,
    pub modal: Modal,
    /// A transient user modal bumped by a blocking Approval/Question, restored
    /// when that modal is answered (§15a). None the rest of the time.
    saved_modal: Option<Modal>,
    pub usage: Option<Usage>,
    /// Cumulative token counters for the footer (session-wide).
    pub cumulative_in: u64,
    pub cumulative_out: u64,
    /// Context window size (footer ctx gauge); None hides the gauge.
    #[allow(dead_code)] // read by render::footer once the ctx gauge is wired (Module stage).
    pub context_window: Option<u64>,
    /// Number of background tasks currently running (footer "⚙ N").
    pub bg_tasks: usize,
    /// Account balance string for the footer (e.g. "5.92"), once fetched.
    pub balance: Option<String>,
    /// Model id shown in the footer.
    pub model: String,
    /// The router's per-turn model pick when `model == "auto"` — drives the
    /// footer's `Auto(<resolved>)` label (port of App.tsx `activeModel`). `None`
    /// before the first route; the footer falls back to `resolve_model(model)`.
    pub active_model: Option<String>,
    /// Live settings mirror (source of truth for `/model` & `/settings` modals
    /// and the `ApplySettings` command). Seeded from `Config` at startup so a
    /// later `/model` does not revert earlier `/settings` edits, and vice-versa.
    pub reasoning_effort: String,
    pub tavily_api_key: String,
    pub response_language: String,
    pub turn_summary_strategy: TurnSummaryStrategy,
    /// Transient footer hint that replaces the whole footer (e.g. quit prompt).
    pub footer_hint: Option<String>,
    pub should_quit: bool,
    /// Whether this turn's thinking block has been frozen into scrollback (once
    /// the answer starts streaming). Prevents re-freezing and stops the
    /// thinking/answer gap from flickering in the live frame.
    thinking_committed: bool,
    /// Bytes of `live_content` already frozen into scrollback as StreamChunk rows
    /// (the complete-block prefix). The remaining tail previews in the live frame.
    frozen_content: usize,
    /// Whether the answer's first chunk has been emitted (only it gets `● `).
    answer_started: bool,
    /// call_id → row index, so `tool_finished` can patch the row it started.
    tool_rows: HashMap<String, usize>,
}

impl AppState {
    pub fn new(mode: ApprovalMode) -> Self {
        AppState {
            rows: Vec::new(),
            committed: 0,
            banner_shown: false,
            live_thinking: String::new(),
            live_content: String::new(),
            input: InputState::new(),
            status: Status::Idle,
            mode,
            modal: Modal::None,
            saved_modal: None,
            usage: None,
            cumulative_in: 0,
            cumulative_out: 0,
            context_window: None,
            bg_tasks: 0,
            balance: None,
            model: String::new(),
            active_model: None,
            reasoning_effort: "high".to_string(),
            tavily_api_key: String::new(),
            response_language: "auto".to_string(),
            turn_summary_strategy: TurnSummaryStrategy::Off,
            footer_hint: None,
            should_quit: false,
            thinking_committed: false,
            frozen_content: 0,
            answer_started: false,
            tool_rows: HashMap::new(),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.status == Status::Busy
    }

    pub fn has_modal(&self) -> bool {
        !matches!(self.modal, Modal::None)
    }

    /// Rows committed but not yet flushed to scrollback (main.rs drains these).
    pub fn pending_rows(&self) -> &[Row] {
        &self.rows[self.committed..]
    }

    /// Mark all current rows as flushed to scrollback.
    pub fn mark_committed(&mut self) {
        self.committed = self.rows.len();
    }

    // ── transcript / streaming ────────────────────────────────────────────────

    pub fn push_user(&mut self, text: impl Into<String>) {
        self.rows.push(Row::User(text.into()));
    }

    pub fn push_user_bash(&mut self, command: impl Into<String>) {
        self.rows.push(Row::UserBash {
            command: command.into(),
            output: None,
        });
    }

    /// New model turn: clear the live streaming buffers.
    pub fn turn_started(&mut self) {
        self.status = Status::Busy;
        self.live_thinking.clear();
        self.live_content.clear();
        self.thinking_committed = false;
        self.frozen_content = 0;
        self.answer_started = false;
    }

    /// Deltas carry the FULL accumulated string (turn.rs) — replace, don't append.
    pub fn on_thinking(&mut self, full: impl Into<String>) {
        self.live_thinking = full.into();
    }
    pub fn on_content(&mut self, full: impl Into<String>) {
        let full = full.into();
        // Once the answer starts streaming, freeze the thinking block into
        // scrollback (folded) so it leaves the live frame — mirrors TS
        // StreamPreview dropping `thinking` once `response` is non-empty. This
        // is what stops the thinking/answer gap from flickering each frame.
        if !full.trim().is_empty()
            && !self.thinking_committed
            && !self.live_thinking.trim().is_empty()
        {
            let t = std::mem::take(&mut self.live_thinking);
            self.rows.push(Row::Thinking {
                content: t,
                expanded: false,
            });
            self.thinking_committed = true;
        }
        // Freeze any newly-complete markdown blocks into scrollback (TS
        // stableMarkdownPrefix): a finished block leaves the live frame and lands
        // in native scrollback, so the answer commits block-by-block upward
        // instead of refreshing in place. The trailing (incomplete) block stays
        // in the live preview.
        let stable = crate::render::markdown::stable_prefix(&full);
        if stable > self.frozen_content && stable <= full.len() {
            let chunk = full[self.frozen_content..stable].to_string();
            self.frozen_content = stable;
            if !chunk.trim().is_empty() {
                let bullet = !self.answer_started;
                self.answer_started = true;
                self.rows.push(Row::StreamChunk { text: chunk, bullet });
            }
        }
        self.live_content = full;
    }

    /// The un-frozen tail of the streaming answer (past the frozen block prefix) —
    /// what the live frame previews.
    pub fn live_tail(&self) -> &str {
        let start = self.frozen_content.min(self.live_content.len());
        &self.live_content[start..]
    }
    /// Whether the tail is the answer's start (its first line gets `● `).
    pub fn live_tail_is_first(&self) -> bool {
        !self.answer_started
    }

    /// Commit the streamed turn: thinking becomes a folded row, the authoritative
    /// assistant content becomes an Assistant row. Live buffers are cleared.
    pub fn commit_assistant(&mut self, content: &str) {
        if !self.live_thinking.trim().is_empty() {
            let t = std::mem::take(&mut self.live_thinking);
            self.rows.push(Row::Thinking {
                content: t,
                expanded: false,
            });
        }
        // Freeze the remaining (un-frozen) tail of the answer as the final chunk;
        // earlier complete blocks were already frozen by `on_content`.
        if !content.is_empty() {
            let start = self.frozen_content.min(content.len());
            let remaining = &content[start..];
            if !remaining.trim().is_empty() {
                let bullet = !self.answer_started;
                self.rows.push(Row::StreamChunk {
                    text: remaining.to_string(),
                    bullet,
                });
            }
        }
        self.live_thinking.clear();
        self.live_content.clear();
        self.frozen_content = 0;
        // Mark the answer as started (not reset!). The content commits on the
        // `AssistantMessage` event but the status only flips to Idle one event later
        // (`TurnComplete`). In that in-between frame the status is still Busy with no
        // live answer; if `answer_started` were false the Running waveform would
        // reappear in the live region (live grows by ~2 rows) and, on a full screen,
        // scroll committed history off the top that the next frame's collapse can't
        // pull back — leaving stray blank rows under the footer. Keeping it set holds
        // the commit frame at footer height; `turn_started` resets it next turn.
        self.answer_started = true;
        self.thinking_committed = false;
    }

    pub fn tool_started(&mut self, call_id: &str, name: &str, summary: &str) {
        let idx = self.rows.len();
        self.rows.push(Row::Tool {
            name: name.to_string(),
            summary: summary.to_string(),
            output: None,
            ok: true,
        });
        self.tool_rows.insert(call_id.to_string(), idx);
    }

    pub fn tool_finished(&mut self, call_id: &str, output: Option<String>, ok: bool) {
        if let Some(&idx) = self.tool_rows.get(call_id) {
            if let Some(Row::Tool { output: o_out, ok: o, .. }) = self.rows.get_mut(idx) {
                *o_out = output;
                *o = ok;
                return;
            }
        }
        // No matching start (shouldn't happen) — append a standalone result row.
        self.rows.push(Row::Tool {
            name: String::new(),
            summary: String::new(),
            output,
            ok,
        });
    }

    pub fn push_error(&mut self, msg: impl Into<String>) {
        self.rows.push(Row::Error(msg.into()));
    }
    pub fn push_note(&mut self, msg: impl Into<String>) {
        self.rows.push(Row::Note(msg.into()));
    }
    #[allow(dead_code)] // used once compaction events fold into a Compaction row.
    pub fn push_compaction(&mut self, summary: impl Into<String>) {
        self.rows.push(Row::Compaction(summary.into()));
    }
    /// Append a subagent step to the most recent SubagentGroup, or open one.
    /// The step is formatted like the parent's own tool lines — display name +
    /// `(args)` — via `tool_display_name` (Chat.tsx `stepLabel`), e.g.
    /// `read_file` → `Read(src/auth.ts)`.
    pub fn push_subagent_step(&mut self, name: &str, summary: &str, result: &str) {
        let display = deepdive_core::tools::format::tool_display_name(name);
        let head = if summary.is_empty() {
            display
        } else {
            format!("{display}({summary})")
        };
        // Append the outcome summary (`→ 120 lines`) when present (Chat.tsx stepLabel).
        let step = if result.is_empty() {
            head
        } else {
            format!("{head} \u{2192} {result}")
        };
        if let Some(Row::SubagentGroup { steps, .. }) = self.rows.last_mut() {
            steps.push(step);
        } else {
            self.rows.push(Row::SubagentGroup {
                header: String::new(),
                steps: vec![step],
                summary: None,
            });
        }
    }
    /// Fold a `SubagentProgress` event: fill the most recent group's header
    /// (`Agent(type)`) and summary (`done · N turns · M tool calls`). Opens a
    /// group if none exists yet (progress can arrive before the first step).
    pub fn subagent_progress(&mut self, agent_type: &str, turn: u32, tool_calls: u32) {
        let summary = format!("done · {turn} turns · {tool_calls} tool calls");
        if let Some(Row::SubagentGroup { header, summary: s, .. }) = self.rows.last_mut() {
            if header.is_empty() {
                *header = format!("Agent({agent_type})");
            }
            *s = Some(summary);
            return;
        }
        self.rows.push(Row::SubagentGroup {
            header: format!("Agent({agent_type})"),
            steps: Vec::new(),
            summary: Some(summary),
        });
    }
    /// `/clear`: empty the transcript + reset the footer counters in place.
    pub fn clear_conversation(&mut self) {
        self.rows.clear();
        self.committed = 0;
        self.banner_shown = false;
        self.live_thinking.clear();
        self.live_content.clear();
        self.usage = None;
        self.cumulative_in = 0;
        self.cumulative_out = 0;
        self.bg_tasks = 0;
        self.frozen_content = 0;
        self.answer_started = false;
        self.thinking_committed = false;
        self.tool_rows.clear();
    }
    pub fn set_bg_tasks(&mut self, n: usize) {
        self.bg_tasks = n;
    }
    pub fn set_balance(&mut self, b: Option<String>) {
        self.balance = b;
    }
    pub fn set_usage(&mut self, usage: Usage) {
        self.cumulative_in += usage.input_tokens;
        self.cumulative_out += usage.output_tokens;
        self.usage = Some(usage);
    }
    pub fn turn_complete(&mut self) {
        self.status = Status::Idle;
        self.live_thinking.clear();
        self.live_content.clear();
        self.thinking_committed = false;
        self.frozen_content = 0;
        self.answer_started = false;
    }

    // ── modal ─────────────────────────────────────────────────────────────────

    pub fn show_approval(
        &mut self,
        tool_name: String,
        args_summary: String,
        warning: Option<String>,
        save_patterns: Vec<String>,
    ) {
        self.stash_transient_modal();
        self.modal = Modal::Approval {
            tool_name,
            args_summary,
            warning,
            save_patterns,
            selected: 0,
        };
    }

    pub fn show_question(&mut self, items: Vec<Question>) {
        self.stash_transient_modal();
        self.modal = Modal::Question {
            items,
            idx: 0,
            selected: 0,
            answers: HashMap::new(),
            checked: HashSet::new(),
            other_text: String::new(),
        };
    }

    /// Stash an open *transient* user modal (Model/Settings/Resume/AddDir) so an
    /// incoming *blocking* Approval/Question (from a background-driven turn) does
    /// not discard the user's in-progress selection. `clear_modal` restores it
    /// once the blocking modal is answered (§15a). No-op if nothing to stash or a
    /// stash already exists (approvals are sequential, so this can't clobber).
    fn stash_transient_modal(&mut self) {
        if self.saved_modal.is_none()
            && matches!(
                self.modal,
                Modal::Model { .. }
                    | Modal::Settings { .. }
                    | Modal::Resume { .. }
                    | Modal::AddDir { .. }
                    | Modal::Btw { .. }
            )
        {
            self.saved_modal = Some(std::mem::replace(&mut self.modal, Modal::None));
        }
    }

    /// Close the current modal, restoring a stashed transient modal if one was
    /// bumped by a blocking Approval/Question (§15a); otherwise no modal.
    pub fn clear_modal(&mut self) {
        self.modal = self.saved_modal.take().unwrap_or(Modal::None);
    }

    /// Dismiss the current modal AND drop any stashed one — used on a Ctrl+C
    /// interrupt, where the user wants out, not the stashed panel back (§15b).
    pub fn dismiss_all_modals(&mut self) {
        self.modal = Modal::None;
        self.saved_modal = None;
    }

    pub fn show_resume(&mut self, sessions: Vec<SessionEntry>) {
        // Default highlight: the first real session (index 1), or the New-session
        // row (0) when there are none — parity with SessionPicker.tsx:49.
        let selected = if sessions.is_empty() { 0 } else { 1 };
        self.modal = Modal::Resume { sessions, selected };
    }
    /// Move the selection within the resume picker. The selection space is
    /// `0..=len`: row 0 is `+ New session`, rows `1..=len` are the sessions.
    /// Clamped (not wrapped), matching SessionPicker's Math.max/min.
    pub fn resume_move(&mut self, delta: i32) {
        if let Modal::Resume { sessions, selected } = &mut self.modal {
            let max = sessions.len() as i32; // last row = last session (index len)
            *selected = (*selected as i32 + delta).clamp(0, max) as usize;
        }
    }
    /// Jump the resume selection to the top (New-session row) / bottom (last
    /// session) — g / G.
    pub fn resume_jump(&mut self, to_top: bool) {
        if let Modal::Resume { sessions, selected } = &mut self.modal {
            *selected = if to_top { 0 } else { sessions.len() };
        }
    }
    /// The current resume-picker choice: the `+ New session` row (index 0) or the
    /// highlighted session (`selected - 1`). `None` when no Resume modal is open.
    pub fn resume_pick(&self) -> Option<ResumePick> {
        if let Modal::Resume { sessions, selected } = &self.modal {
            if *selected == 0 {
                Some(ResumePick::New)
            } else {
                sessions
                    .get(*selected - 1)
                    .map(|s| ResumePick::Session(s.id.clone()))
            }
        } else {
            None
        }
    }
    /// Fold a loaded session's messages into transcript rows (after `/resume`).
    /// Resets the scrollback-flush cursor so the reloaded history is re-emitted.
    pub fn load_history(&mut self, rows: Vec<Row>) {
        self.rows = rows;
        self.committed = 0;
        self.banner_shown = false;
    }

    // ── /model modal (ModelPanel.tsx) ────────────────────────────────────────

    /// Open the `/model` picker, highlighting the current model.
    pub fn show_model(&mut self) {
        let entries: Vec<ModelEntry> = CHAT_MODELS
            .iter()
            .map(|m| ModelEntry {
                value: m.value.to_string(),
                label: m.label.to_string(),
                desc: m.description.to_string(),
                selected: m.value == self.model,
            })
            .collect();
        let selected = entries.iter().position(|e| e.selected).unwrap_or(0);
        self.modal = Modal::Model { entries, selected };
    }

    /// Move the `/model` highlight (wraps).
    pub fn model_move(&mut self, delta: i32) {
        if let Modal::Model { entries, selected } = &mut self.modal {
            let n = entries.len() as i32;
            if n > 0 {
                *selected = (((*selected as i32 + delta) % n + n) % n) as usize;
            }
        }
    }

    /// Jump the `/model` highlight to a 1-based index (number-key shortcut).
    pub fn model_jump(&mut self, idx1: usize) {
        if let Modal::Model { entries, selected } = &mut self.modal {
            if idx1 >= 1 && idx1 <= entries.len() {
                *selected = idx1 - 1;
            }
        }
    }

    /// Commit the `/model` selection: update the live model + context-window
    /// gauge, clear the modal, and return the chosen model value (for the caller
    /// to persist + push to the engine via `ApplySettings`). None if no modal.
    pub fn model_commit(&mut self) -> Option<String> {
        let value = if let Modal::Model { entries, selected } = &self.modal {
            entries.get(*selected).map(|e| e.value.clone())
        } else {
            None
        };
        if let Some(v) = &value {
            self.model = v.clone();
            // Reset the routed pick; the footer falls back to resolve_model until
            // the next auto route (parity with App.tsx setActiveModel on /model).
            self.active_model = None;
            self.context_window = Some(model_context_window(v));
        }
        self.clear_modal();
        value
    }

    // ── /settings modal (SettingsPanel.tsx) ──────────────────────────────────

    /// Open the `/settings` panel, seeding each row's pending option from the
    /// live settings mirror.
    pub fn show_settings(&mut self) {
        let model_opts: Vec<SettingOption> = CHAT_MODELS
            .iter()
            .map(|m| SettingOption {
                value: m.value.to_string(),
                label: m.label.to_string(),
                desc: m.description.to_string(),
            })
            .collect();
        let reasoning_opts = build_options(&[
            ("none", "none", "关闭思考（non-thinking 模式）"),
            ("low", "low", "最低推理强度"),
            ("medium", "medium", "中等推理强度"),
            ("high", "high", "默认档位，常规推理强度"),
            ("max", "max", "最大推理强度，思考更深、更慢也更贵"),
            ("xhigh", "xhigh", "超高推理强度（max 之上）"),
        ]);
        let search_opts = build_options(&[("tavily", "tavily", "Tavily，需 TAVILY_API_KEY")]);
        let language_opts = build_options(&[
            ("auto", "auto", "跟随用户输入语言（默认，不强制）"),
            ("zh", "简体中文", "始终用简体中文回复"),
            ("zh-Hant", "繁體中文", "始终用繁体中文回复"),
            ("en", "English", "始终用英文回复"),
            ("ja", "日本語", "始终用日文回复"),
            ("ko", "한국어", "始终用韩文回复"),
        ]);
        let turn_opts = build_options(&[
            ("off", "off", "不压缩上一轮历史，完整保留原始消息"),
            ("whole_turn", "whole_turn", "压缩两个 user 之间的全部 assistant/tool 消息"),
            ("tool_only", "tool_only", "只压缩纯 tool-call 链，保留可见 assistant 输出"),
        ]);
        let rows = vec![
            SettingsRow {
                sel: opt_index(&model_opts, &self.model),
                key: "model".to_string(),
                label: "Model".to_string(),
                options: model_opts,
                secret_when: None,
            },
            SettingsRow {
                sel: opt_index(&reasoning_opts, &self.reasoning_effort),
                key: "reasoning".to_string(),
                label: "Reasoning effort".to_string(),
                options: reasoning_opts,
                secret_when: None,
            },
            SettingsRow {
                sel: 0,
                key: "search".to_string(),
                label: "Web search engine".to_string(),
                options: search_opts,
                secret_when: Some("tavily".to_string()),
            },
            SettingsRow {
                sel: opt_index(&language_opts, &self.response_language),
                key: "language".to_string(),
                label: "Response language".to_string(),
                options: language_opts,
                secret_when: None,
            },
            SettingsRow {
                sel: opt_index(&turn_opts, turn_summary_str(self.turn_summary_strategy)),
                key: "turnSummary".to_string(),
                label: "Previous-turn summary".to_string(),
                options: turn_opts,
                secret_when: None,
            },
        ];
        self.modal = Modal::Settings {
            rows,
            row: 0,
            tavily_key: self.tavily_api_key.clone(),
        };
    }

    /// Move the navigable `/settings` row (↑↓, wraps).
    pub fn settings_row_move(&mut self, delta: i32) {
        if let Modal::Settings { rows, row, .. } = &mut self.modal {
            let n = rows.len() as i32;
            if n > 0 {
                *row = (((*row as i32 + delta) % n + n) % n) as usize;
            }
        }
    }

    /// Change the current row's pending option (←→, wraps).
    pub fn settings_value_move(&mut self, delta: i32) {
        if let Modal::Settings { rows, row, .. } = &mut self.modal {
            if let Some(r) = rows.get_mut(*row) {
                let n = r.options.len() as i32;
                if n > 0 {
                    r.sel = (((r.sel as i32 + delta) % n + n) % n) as usize;
                }
            }
        }
    }

    /// Whether the current row reveals the Tavily-key secret sub-line (its
    /// selected option's value equals `secret_when`).
    pub fn settings_secret_active(&self) -> bool {
        if let Modal::Settings { rows, row, .. } = &self.modal {
            if let Some(r) = rows.get(*row) {
                if let (Some(when), Some(opt)) = (&r.secret_when, r.options.get(r.sel)) {
                    return &opt.value == when;
                }
            }
        }
        false
    }

    /// Replace the Tavily-key buffer with a pasted secret (only when its sub-line
    /// is revealed), stripping all whitespace. SettingsPanel.tsx enters the key
    /// wholesale via paste (`pasted.replace(/\s+/g, "")`) — it is never typed
    /// char by char, so the whole value is replaced rather than appended.
    pub fn settings_secret_paste(&mut self, pasted: &str) {
        if !self.settings_secret_active() {
            return;
        }
        let cleaned: String = pasted.chars().filter(|c| !c.is_whitespace()).collect();
        if let Modal::Settings { tavily_key, .. } = &mut self.modal {
            *tavily_key = cleaned;
        }
    }

    /// Clear the whole Tavily-key buffer (only when revealed) so it can be
    /// re-pasted. SettingsPanel.tsx wipes the secret on ⌫ rather than popping one
    /// char (the key is paste-only).
    pub fn settings_secret_clear(&mut self) {
        if !self.settings_secret_active() {
            return;
        }
        if let Modal::Settings { tavily_key, .. } = &mut self.modal {
            tavily_key.clear();
        }
    }

    /// Collect the pending `/settings` values, write them to the live mirror,
    /// clear the modal, and return them for persistence + `ApplySettings`.
    pub fn settings_commit(&mut self) -> Option<SettingsValues> {
        let values = if let Modal::Settings { rows, tavily_key, .. } = &self.modal {
            let pick = |key: &str| -> Option<String> {
                rows.iter()
                    .find(|r| r.key == key)
                    .and_then(|r| r.options.get(r.sel))
                    .map(|o| o.value.clone())
            };
            Some(SettingsValues {
                model: pick("model").unwrap_or_else(|| self.model.clone()),
                reasoning_effort: pick("reasoning").unwrap_or_else(|| self.reasoning_effort.clone()),
                tavily_api_key: tavily_key.trim().to_string(),
                response_language: pick("language").unwrap_or_else(|| self.response_language.clone()),
                turn_summary: parse_turn_summary(&pick("turnSummary").unwrap_or_default()),
            })
        } else {
            None
        };
        if let Some(v) = &values {
            self.model = v.model.clone();
            self.active_model = None; // re-route on next auto turn (see model_commit).
            self.context_window = Some(model_context_window(&v.model));
            self.reasoning_effort = v.reasoning_effort.clone();
            self.tavily_api_key = v.tavily_api_key.clone();
            self.response_language = v.response_language.clone();
            self.turn_summary_strategy = v.turn_summary;
        }
        self.clear_modal();
        values
    }

    // ── /add-dir modal (AddDirConfirm.tsx) ───────────────────────────────────

    /// Open the `/add-dir` grant-scope confirm for a validated absolute path.
    pub fn show_add_dir(&mut self, path: impl Into<String>) {
        self.modal = Modal::AddDir {
            path: path.into(),
            selected: 0,
        };
    }

    /// Move the `/add-dir` option highlight (wraps over 3 options).
    pub fn adddir_move(&mut self, delta: i32) {
        if let Modal::AddDir { selected, .. } = &mut self.modal {
            // Clamp (not wrap) over the 3 options — AddDirConfirm.tsx Math.max/min.
            *selected = (*selected as i32 + delta).clamp(0, 2) as usize;
        }
    }

    /// The `/add-dir` highlighted (path, option index) — option 0 session,
    /// 1 persist, 2 deny. None if no AddDir modal.
    pub fn adddir_selected(&self) -> Option<(String, usize)> {
        if let Modal::AddDir { path, selected } = &self.modal {
            Some((path.clone(), *selected))
        } else {
            None
        }
    }

    // ── /btw modal (BtwPanel.tsx) ────────────────────────────────────────────

    /// Open a fresh `/btw` thread with a pending (loading) first question.
    pub fn show_btw(&mut self, question: impl Into<String>) {
        self.modal = Modal::Btw {
            exchanges: vec![BtwExchange {
                question: question.into(),
                response: None,
                error: None,
            }],
            draft: String::new(),
        };
    }

    /// True while the thread's last exchange has no response/error yet — the
    /// follow-up input is hidden and typing is ignored during this window.
    pub fn btw_loading(&self) -> bool {
        match &self.modal {
            Modal::Btw { exchanges, .. } => exchanges
                .last()
                .map(|e| e.response.is_none() && e.error.is_none())
                .unwrap_or(false),
            _ => false,
        }
    }

    /// This thread's already-answered exchanges, flattened to replay messages
    /// (mirrors TS `btwExchangesToMessages`) — call BEFORE
    /// [`Self::btw_push_pending`] so the new pending question isn't included.
    pub fn btw_prior_exchange_messages(&self) -> Vec<Message> {
        let Modal::Btw { exchanges, .. } = &self.modal else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for ex in exchanges {
            let Some(resp) = &ex.response else { continue };
            out.push(Message::user(ex.question.clone()));
            out.push(Message::assistant(resp.clone()));
        }
        out
    }

    /// Append a follow-up as a new pending exchange and clear the draft.
    pub fn btw_push_pending(&mut self, question: String) {
        if let Modal::Btw { exchanges, draft } = &mut self.modal {
            exchanges.push(BtwExchange {
                question,
                response: None,
                error: None,
            });
            draft.clear();
        }
    }

    pub fn btw_draft_push(&mut self, c: char) {
        if let Modal::Btw { draft, .. } = &mut self.modal {
            draft.push(c);
        }
    }

    pub fn btw_draft_backspace(&mut self) {
        if let Modal::Btw { draft, .. } = &mut self.modal {
            draft.pop();
        }
    }

    /// Take + trim the draft, leaving it empty (submitted or discarded either way).
    pub fn btw_take_draft(&mut self) -> String {
        if let Modal::Btw { draft, .. } = &mut self.modal {
            std::mem::take(draft).trim().to_string()
        } else {
            String::new()
        }
    }

    /// Apply a `SideQuestion` engine event to whichever exchange is still
    /// pending. Checks `saved_modal` too, since an Approval/Question can bump
    /// the panel out of `modal` while the fork is still in flight (§15a).
    /// Ignored if the last exchange's question no longer matches — the panel
    /// was dismissed (or a stale result arrived) before the answer came back.
    pub fn set_side_question_result(&mut self, question: &str, result: Result<Option<String>, String>) {
        let (response, error) = match result {
            Ok(Some(text)) => (Some(text), None),
            Ok(None) => (None, Some("No response received".to_string())),
            Err(msg) => (None, Some(msg)),
        };
        let apply = |exchanges: &mut Vec<BtwExchange>| -> bool {
            if let Some(last) = exchanges.last_mut() {
                if last.question == question && last.response.is_none() && last.error.is_none() {
                    last.response = response.clone();
                    last.error = error.clone();
                    return true;
                }
            }
            false
        };
        if let Modal::Btw { exchanges, .. } = &mut self.modal {
            if apply(exchanges) {
                return;
            }
        }
        if let Some(Modal::Btw { exchanges, .. }) = &mut self.saved_modal {
            apply(exchanges);
        }
    }

    /// Whether the multi-question nav bar is shown (AskQuestion.tsx `multi`).
    fn question_multi(&self) -> bool {
        matches!(&self.modal, Modal::Question { items, .. } if items.len() > 1)
    }

    /// The cursor sits on the free-form "Other" row (AskQuestion.tsx `onOther`).
    pub fn question_on_other(&self) -> bool {
        matches!(&self.modal,
            Modal::Question { items, idx, selected, .. }
                if items.get(*idx).is_some_and(|q| *selected == q.options.len()))
    }

    /// Switch to nav tab `target` (clamped to `0..=submit`), restoring that
    /// question's previously-recorded answer into the live checked/other/cursor
    /// state so revisiting it keeps the prior choice (AskQuestion.tsx `goTo`).
    pub fn question_go_to(&mut self, target: i32) {
        if let Modal::Question { items, idx, selected, answers, checked, other_text } = &mut self.modal {
            let submit_index = items.len() as i32;
            let clamped = target.clamp(0, submit_index) as usize;
            *idx = clamped;
            restore_question_state(items.get(clamped), answers, checked, other_text, selected);
        }
    }

    /// ← previous tab (only in multi-question mode). AskQuestion.tsx `leftArrow`.
    pub fn question_left(&mut self) {
        if self.question_multi() {
            if let Modal::Question { idx, .. } = &self.modal {
                let cur = *idx as i32;
                self.question_go_to(cur - 1);
            }
        }
    }

    /// → next tab (only in multi-question mode). AskQuestion.tsx `rightArrow`.
    pub fn question_right(&mut self) {
        if self.question_multi() {
            if let Modal::Question { idx, .. } = &self.modal {
                let cur = *idx as i32;
                self.question_go_to(cur + 1);
            }
        }
    }

    /// ↑ within the current question's rows (clamped). No-op on the Submit tab.
    pub fn question_up(&mut self) {
        if let Modal::Question { items, idx, selected, .. } = &mut self.modal {
            if *idx < items.len() && *selected > 0 {
                *selected -= 1;
            }
        }
    }

    /// ↓ within the current question's rows (clamped; last row = Other).
    pub fn question_down(&mut self) {
        if let Modal::Question { items, idx, selected, .. } = &mut self.modal {
            if let Some(q) = items.get(*idx) {
                let row_count = q.options.len() + 1; // options + Other
                if *selected + 1 < row_count {
                    *selected += 1;
                }
            }
        }
    }

    /// Space: toggle the checkbox under the cursor (multi-select, non-Other rows).
    pub fn question_toggle(&mut self) {
        if let Modal::Question { items, idx, selected, checked, .. } = &mut self.modal {
            if let Some(q) = items.get(*idx) {
                if q.multi_select && *selected < q.options.len() && !checked.remove(selected) {
                    checked.insert(*selected);
                }
            }
        }
    }

    /// Type into the Other buffer (only when the cursor is on the Other row).
    pub fn question_type(&mut self, ch: char) {
        if self.question_on_other() {
            if let Modal::Question { other_text, .. } = &mut self.modal {
                other_text.push(ch);
            }
        }
    }

    /// Backspace the Other buffer (only when the cursor is on the Other row).
    pub fn question_backspace(&mut self) {
        if self.question_on_other() {
            if let Modal::Question { other_text, .. } = &mut self.modal {
                other_text.pop();
            }
        }
    }

    /// Enter: commit the current question and advance, or (on the Submit tab)
    /// submit the whole form. Returns `Some(answers)` when the form is complete
    /// (the caller sends them on the reply oneshot and clears the modal), else
    /// `None`. Port of AskQuestion.tsx's `return` handler + `recordAndAdvance`.
    pub fn question_enter(&mut self) -> Option<HashMap<String, String>> {
        // Phase 1 (inside the borrow): finish the form (return Some), reject an
        // incomplete commit (return None early), or yield the next tab to go to.
        let goto: i32 = {
            let Modal::Question { items, idx, selected, answers, checked, other_text } =
                &mut self.modal
            else {
                return None;
            };
            let multi = items.len() > 1;
            let submit_index = items.len();

            if *idx >= submit_index {
                // Submit tab: submit when complete, else jump to the first unanswered.
                match items.iter().position(|q| !answers.contains_key(&q.question)) {
                    None => return Some(std::mem::take(answers)),
                    Some(missing) => missing as i32,
                }
            } else {
                let q = &items[*idx];
                let other = other_text.trim().to_string();
                let answer = if q.multi_select {
                    let mut labels: Vec<String> = q
                        .options
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| checked.contains(i))
                        .map(|(_, o)| o.label.clone())
                        .collect();
                    if !other.is_empty() {
                        labels.push(other);
                    }
                    if labels.is_empty() {
                        return None; // need at least one selection
                    }
                    labels.join(", ")
                } else if *selected == q.options.len() {
                    if other.is_empty() {
                        return None; // require non-empty custom text
                    }
                    other
                } else {
                    q.options[*selected].label.clone()
                };

                answers.insert(q.question.clone(), answer);
                if !multi {
                    // Single question: selecting an option submits immediately.
                    return Some(std::mem::take(answers));
                }
                *idx as i32 + 1
            }
        };
        self.question_go_to(goto);
        None
    }

    /// Move the selection within the approval modal (0..n options).
    pub fn approval_move(&mut self, delta: i32, n_options: usize) {
        if let Modal::Approval { selected, .. } = &mut self.modal {
            // Clamp (not wrap) — ConfirmBox.tsx Math.max/min. (Model/Settings wrap.)
            if n_options > 0 {
                let max = n_options as i32 - 1;
                *selected = (*selected as i32 + delta).clamp(0, max) as usize;
            }
        }
    }
}

/// Restore a question's recorded answer into the live editing state (checked /
/// other_text / cursor) when switching to its tab (AskQuestion.tsx `goTo`). A
/// fresh/unanswered question resets to option 0 with no checks and empty Other.
fn restore_question_state(
    q: Option<&Question>,
    answers: &HashMap<String, String>,
    checked: &mut HashSet<usize>,
    other_text: &mut String,
    selected: &mut usize,
) {
    checked.clear();
    other_text.clear();
    *selected = 0;
    let Some(q) = q else { return }; // Submit tab: nothing to restore
    let Some(ans) = answers.get(&q.question) else { return };
    if q.multi_select {
        let labels: Vec<&str> = ans.split(", ").collect();
        for (i, o) in q.options.iter().enumerate() {
            if labels.contains(&o.label.as_str()) {
                checked.insert(i);
            }
        }
        let others: Vec<&str> = labels
            .iter()
            .copied()
            .filter(|l| !q.options.iter().any(|o| o.label == *l))
            .collect();
        *other_text = others.join(", ");
    } else {
        match q.options.iter().position(|o| o.label == *ans) {
            Some(i) => *selected = i,
            // A single-select answer matching no option was free-form "Other".
            None => {
                *selected = q.options.len();
                *other_text = ans.clone();
            }
        }
    }
}

/// Build a `(value, label, desc)` table into `SettingOption`s.
fn build_options(rows: &[(&str, &str, &str)]) -> Vec<SettingOption> {
    rows.iter()
        .map(|(value, label, desc)| SettingOption {
            value: value.to_string(),
            label: label.to_string(),
            desc: desc.to_string(),
        })
        .collect()
}

/// Index of the option whose `value` matches (0 when none match — the TS
/// `Math.max(0, findIndex(...))`).
fn opt_index(opts: &[SettingOption], value: &str) -> usize {
    opts.iter().position(|o| o.value == value).unwrap_or(0)
}

/// Parse a `turnSummary` option value into the enum (unknown → Off).
fn parse_turn_summary(s: &str) -> TurnSummaryStrategy {
    match s {
        "whole_turn" => TurnSummaryStrategy::WholeTurn,
        "tool_only" => TurnSummaryStrategy::ToolOnly,
        _ => TurnSummaryStrategy::Off,
    }
}

/// The settings/persistence string for a `TurnSummaryStrategy`.
fn turn_summary_str(t: TurnSummaryStrategy) -> &'static str {
    match t {
        TurnSummaryStrategy::Off => "off",
        TurnSummaryStrategy::WholeTurn => "whole_turn",
        TurnSummaryStrategy::ToolOnly => "tool_only",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_commits_thinking_then_assistant() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.turn_started();
        assert!(a.is_busy());
        a.on_thinking("let me think");
        a.on_content("partial");
        a.on_content("partial answer"); // full-string replace, not append
        assert_eq!(a.live_content, "partial answer");
        a.commit_assistant("final answer");
        assert_eq!(
            a.rows,
            vec![
                Row::Thinking {
                    content: "let me think".into(),
                    expanded: false,
                },
                Row::StreamChunk {
                    text: "final answer".into(),
                    bullet: true,
                },
            ]
        );
        assert!(a.live_content.is_empty());
        assert!(a.live_thinking.is_empty());
    }

    #[test]
    fn empty_assistant_commits_no_row() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.turn_started();
        a.commit_assistant("");
        assert!(a.rows.is_empty());
    }

    #[test]
    fn tool_finished_patches_the_started_row() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.tool_started("c1", "glob", "**/*.rs");
        a.tool_finished("c1", Some("35 matches".into()), true);
        assert_eq!(
            a.rows,
            vec![Row::Tool {
                name: "glob".into(),
                summary: "**/*.rs".into(),
                output: Some("35 matches".into()),
                ok: true,
            }]
        );
    }

    #[test]
    fn interleaved_tools_patch_correct_rows() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.tool_started("c1", "read_file", "a.rs");
        a.tool_started("c2", "bash", "ls");
        a.tool_finished("c2", Some("3 lines".into()), true);
        a.tool_finished("c1", None, false);
        match &a.rows[0] {
            Row::Tool { name, ok, .. } => {
                assert_eq!(name, "read_file");
                assert!(!ok);
            }
            _ => panic!(),
        }
        match &a.rows[1] {
            Row::Tool {
                name, output, ok, ..
            } => {
                assert_eq!(name, "bash");
                assert_eq!(output.as_deref(), Some("3 lines"));
                assert!(ok);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn turn_complete_goes_idle_and_clears_live() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.turn_started();
        a.on_thinking("x");
        a.turn_complete();
        assert!(!a.is_busy());
        assert!(a.live_thinking.is_empty());
    }

    #[test]
    fn question_commit_advances_then_returns_answers() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_question(vec![
            Question {
                header: "".into(),
                question: "q1".into(),
                options: vec!["A".into(), "B".into()],
                multi_select: false,
            },
            Question {
                header: "".into(),
                question: "q2".into(),
                options: vec!["X".into(), "Y".into()],
                multi_select: false,
            },
        ]);
        a.question_down(); // cursor → option B for q1
        assert!(a.question_enter().is_none()); // records B, advances to q2 tab
        // q2 defaults to cursor 0 (option X); Enter on the last question in a
        // multi-question form lands on the Submit tab, not an immediate submit.
        assert!(a.question_enter().is_none()); // records X, advances to Submit tab
        let ans = a.question_enter().unwrap(); // Submit tab + all answered → submit
        assert_eq!(ans.get("q1").map(String::as_str), Some("B"));
        assert_eq!(ans.get("q2").map(String::as_str), Some("X"));
    }

    #[test]
    fn question_modal_selection_clamps_over_rows() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_question(vec![Question {
            header: "h".into(),
            question: "pick".into(),
            options: vec!["A".into(), "B".into(), "C".into()],
            multi_select: false,
        }]);
        assert!(a.has_modal());
        a.question_up(); // clamp at the top row (AskQuestion.tsx Math.max)
        if let Modal::Question { selected, .. } = &a.modal {
            assert_eq!(*selected, 0);
        } else {
            panic!();
        }
        // ↓ walks the 3 options then the Other row (rows 0..=3), clamping there.
        a.question_down();
        a.question_down();
        a.question_down(); // → Other row (index 3)
        a.question_down(); // clamp at bottom
        if let Modal::Question { selected, .. } = &a.modal {
            assert_eq!(*selected, 3);
        } else {
            panic!();
        }
        assert!(a.question_on_other());
        a.clear_modal();
        assert!(!a.has_modal());
    }

    #[test]
    fn approval_modal_selection_clamps() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_approval("bash".into(), "ls".into(), None, vec![]);
        a.approval_move(-1, 2); // clamp at top (ConfirmBox.tsx Math.max)
        if let Modal::Approval { selected, .. } = &a.modal {
            assert_eq!(*selected, 0);
        } else {
            panic!();
        }
        a.approval_move(1, 2); // → last
        a.approval_move(1, 2); // clamp at bottom (Math.min)
        if let Modal::Approval { selected, .. } = &a.modal {
            assert_eq!(*selected, 1);
        } else {
            panic!();
        }
    }

    #[test]
    fn resume_picker_navigates_and_selects() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_resume(vec![
            SessionEntry {
                id: "a".into(),
                title: "first".into(),
                when: None,
                msgs: None,
            },
            SessionEntry {
                id: "b".into(),
                title: "second".into(),
                when: None,
                msgs: None,
            },
        ]);
        assert!(a.has_modal());
        // Default highlight is the first real session (index 1 = "a"); New at 0.
        assert_eq!(a.resume_pick(), Some(ResumePick::Session("a".into())));
        a.resume_move(1); // → "b" (last session, index 2)
        assert_eq!(a.resume_pick(), Some(ResumePick::Session("b".into())));
        a.resume_move(1); // clamp at bottom — stays "b"
        assert_eq!(a.resume_pick(), Some(ResumePick::Session("b".into())));
        a.resume_move(-1); // → "a"
        a.resume_move(-1); // → New-session row (0)
        assert_eq!(a.resume_pick(), Some(ResumePick::New));
        a.resume_move(-1); // clamp at top — still New
        assert_eq!(a.resume_pick(), Some(ResumePick::New));
        a.clear_modal();
        assert!(a.resume_pick().is_none());
    }

    #[test]
    fn clear_conversation_resets_rows_and_counters() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.push_user("hi");
        a.set_usage(Usage {
            input_tokens: 5,
            output_tokens: 2,
            ..Default::default()
        });
        a.set_bg_tasks(2);
        a.tool_started("c1", "bash", "ls");
        a.clear_conversation();
        assert!(a.rows.is_empty());
        assert!(a.usage.is_none());
        assert_eq!(a.bg_tasks, 0);
        assert_eq!(a.cumulative_in, 0);
        // a follow-up tool_finished for the cleared call must not panic / patch.
        a.tool_finished("c1", Some("done".into()), true);
        assert_eq!(a.rows.len(), 1); // only the new (orphan) tool row
    }

    #[test]
    fn pending_rows_and_commit_cursor() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.push_user("hi");
        assert_eq!(a.pending_rows().len(), 1);
        a.mark_committed();
        assert_eq!(a.pending_rows().len(), 0);
        a.push_note("note");
        assert_eq!(a.pending_rows().len(), 1);
    }

    #[test]
    fn usage_accumulates_cumulative_tokens() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.set_usage(Usage {
            input_tokens: 10,
            output_tokens: 3,
            ..Default::default()
        });
        a.set_usage(Usage {
            input_tokens: 5,
            output_tokens: 7,
            ..Default::default()
        });
        assert_eq!(a.cumulative_in, 15);
        assert_eq!(a.cumulative_out, 10);
    }

    #[test]
    fn model_modal_commit_changes_model_and_window() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.model = "deepseek-v4-pro".into();
        a.show_model();
        // pro is current → highlighted (index 1, after the auto head); move to flash.
        a.model_move(1);
        let v = a.model_commit().unwrap();
        assert_eq!(v, "deepseek-v4-flash");
        assert_eq!(a.model, "deepseek-v4-flash");
        assert!(a.context_window.is_some());
        assert!(!a.has_modal());
    }

    #[test]
    fn model_modal_jump_by_number() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.model = "deepseek-v4-flash".into();
        a.show_model();
        a.model_jump(1); // 1-based → first entry: "auto" (head of CHAT_MODELS)
        assert_eq!(a.model_commit().as_deref(), Some("auto"));

        // index 2 → pro (auto pushed pro/flash down one slot).
        a.show_model();
        a.model_jump(2);
        assert_eq!(a.model_commit().as_deref(), Some("deepseek-v4-pro"));
    }

    #[test]
    fn settings_modal_value_move_and_commit() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.model = "deepseek-v4-pro".into();
        a.reasoning_effort = "high".into();
        a.show_settings();
        a.settings_row_move(1); // → reasoning row
        a.settings_value_move(1); // high → max
        let v = a.settings_commit().unwrap();
        assert_eq!(v.reasoning_effort, "max");
        assert_eq!(a.reasoning_effort, "max");
        assert!(!a.has_modal());
    }

    #[test]
    fn settings_secret_pasted_replaces_and_clears() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_settings();
        assert!(!a.settings_secret_active()); // model row, no secret
        a.settings_row_move(2); // → search row (tavily)
        assert!(a.settings_secret_active());
        // Paste enters the key wholesale, stripping whitespace; a later paste
        // replaces rather than appends (SettingsPanel.tsx `usePaste`).
        a.settings_secret_paste("  tv x\n");
        a.settings_secret_paste("abc123");
        // ⌫ wipes the whole secret so it can be re-pasted.
        a.settings_secret_clear();
        a.settings_secret_paste("final-key");
        let v = a.settings_commit().unwrap();
        assert_eq!(v.tavily_api_key, "final-key");
    }

    #[test]
    fn blocking_modal_bumps_then_restores_transient_modal() {
        // A background turn's Approval must not discard an open /model picker (§15a).
        let mut a = AppState::new(ApprovalMode::Auto);
        a.model = "deepseek-v4-pro".into();
        a.show_model();
        assert!(matches!(a.modal, Modal::Model { .. }));
        a.show_approval("bash".into(), "ls".into(), None, vec![]);
        assert!(matches!(a.modal, Modal::Approval { .. }));
        // Answering the approval restores the picker...
        a.clear_modal();
        assert!(matches!(a.modal, Modal::Model { .. }));
        // ...and closing the restored picker leaves no modal.
        a.clear_modal();
        assert!(!a.has_modal());
    }

    #[test]
    fn dismiss_all_modals_drops_stash_without_restore() {
        // Ctrl+C interrupt path (§15b): the stashed panel is NOT brought back.
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_settings();
        a.show_question(vec![Question {
            header: "".into(),
            question: "q".into(),
            options: vec!["A".into()],
            multi_select: false,
        }]);
        assert!(matches!(a.modal, Modal::Question { .. }));
        a.dismiss_all_modals();
        assert!(!a.has_modal());
        a.clear_modal(); // no stash to restore
        assert!(!a.has_modal());
    }

    #[test]
    fn adddir_modal_clamps_over_three_options() {
        let mut a = AppState::new(ApprovalMode::Auto);
        a.show_add_dir("/tmp/foo");
        assert_eq!(a.adddir_selected(), Some(("/tmp/foo".into(), 0)));
        a.adddir_move(-1); // clamp at top (AddDirConfirm.tsx Math.max)
        assert_eq!(a.adddir_selected(), Some(("/tmp/foo".into(), 0)));
        a.adddir_move(1);
        a.adddir_move(1); // → deny (index 2)
        a.adddir_move(1); // clamp at bottom (Math.min)
        assert_eq!(a.adddir_selected(), Some(("/tmp/foo".into(), 2)));
        a.clear_modal();
        assert!(a.adddir_selected().is_none());
    }
}
