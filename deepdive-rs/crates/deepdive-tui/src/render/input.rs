//! Input box: editor state ([`InputState`]) + rendering (§7).
//!
//! Appearance (no rectangle): a full-width `─` rule above and below (dim; BASH
//! color and not dim in bash mode); first-line prompt `> ` (default fg; bash mode
//! `! ` BASH color, eats the leading `!` and shows `value[1:]`); continuation
//! prefix `  `; usable text width `cols - 2`; no placeholder text. Soft cursor:
//! the char under the cursor renders white-on-black; an end-of-line cursor is a
//! white-on-black trailing space.
//!
//! Slash completion (§7): when the value starts with `/` and matches commands,
//! the list REPLACES the bottom rule position and signals the footer to hide.
//!
//! Scaffold defines the full state + method SIGNATURES with minimal working
//! bodies (NO `todo!()`); Module `input` fills the bodies to match §7 without
//! changing the public signatures or struct fields.
//!
//! TODO (later stages, §7): paste-pill collapse (`[Pasted text #N +K lines]`).
//! History recall (↑) and `/add-dir` directory-candidate completion are done.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::{ACCENT, BASH, CURSOR_BG, CURSOR_FG};

/// Max `/add-dir` directory candidates shown at once (InputBox.tsx
/// `MAX_DIR_CANDIDATES`); the list scrolls when there are more.
const MAX_DIR_CANDIDATES: usize = 10;

/// Collapse a paste into a `[Pasted text #N +K lines]` pill when it is longer
/// than this many chars OR spans more than `PASTE_MAX_NEWLINES` line breaks
/// (InputBox.tsx `PASTE_THRESHOLD` / `PASTE_MAX_NEWLINES`).
const PASTE_THRESHOLD: usize = 800;
const PASTE_MAX_NEWLINES: usize = 2;

/// A pasted block held inline inside `text` as raw content but *rendered* as a
/// collapsed placeholder; the cursor treats it atomically (InputBox.tsx
/// `PasteBlock`). Offsets are byte positions into `text`.
#[derive(Debug, Clone, Copy)]
pub struct PasteBlock {
    /// Session-wide paste number shown in the pill (`#N`); never reset.
    pub id: u32,
    /// Raw start offset (inclusive).
    pub start: usize,
    /// Raw end offset (exclusive).
    pub end: usize,
    /// Newline count captured at paste time (the pill's `+K lines`).
    pub lines: usize,
}

/// A built-in slash command shown in the completion list (§7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub desc: String,
    /// Whether this Rust front-end actually implements it yet (else "(未实现)").
    pub implemented: bool,
}

/// Result of a key press, telling main.rs what (if anything) to do.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum InputAction {
    /// Key consumed, editor state changed, nothing else to do.
    #[default]
    None,
    /// Submit the given value (Enter on a non-empty buffer; `/`/`!` semantics are
    /// decided by main.rs from the returned string).
    Submit(String),
}

/// The input editor state. Cursor is a byte offset into `text` (always on a char
/// boundary). `bash` is set when the buffer starts with `!`. The slash menu state
/// is recomputed from `text` on each edit.
#[derive(Debug, Clone, Default)]
pub struct InputState {
    /// The full multi-line buffer (newlines are literal `\n`).
    pub text: String,
    /// Cursor position as a byte offset into `text`.
    pub cursor: usize,
    /// True when the buffer is in bash mode (`text` starts with `!`).
    pub bash: bool,
    /// Slash-completion menu state (open when this is `Some`).
    pub slash: Option<SlashMenu>,
    /// `/add-dir <path>` directory-candidate menu (open when this is `Some`);
    /// mutually exclusive with `slash` (the slash menu needs no space, `/add-dir`
    /// completion needs one).
    pub dir: Option<DirMenu>,
    /// Collapsed paste blocks, sorted by `start` (InputBox.tsx `pasteBlocks`).
    pub paste_blocks: Vec<PasteBlock>,
    /// Next paste number (`#N`); increments across the whole session, never reset.
    paste_counter: u32,
    /// Submitted-line history for ↑ recall, most-recent-first (index 0 = newest).
    pub history: Vec<String>,
    /// Position in `history` while recalling (index 0 = most recent); `None` when
    /// editing the live draft. Mirrors InputBox.tsx `historyIdx`.
    history_idx: Option<usize>,
    /// The live draft stashed when ↑ first enters history, restored on ↓ back out
    /// (InputBox.tsx `draft`).
    draft: Option<String>,
}

/// Slash-completion menu state (§7).
#[derive(Debug, Clone, Default)]
pub struct SlashMenu {
    /// Filtered + alphabetically-sorted candidate commands.
    pub matches: Vec<SlashCommand>,
    /// Currently-highlighted index into `matches`.
    pub selected: usize,
}

/// `/add-dir <path>` directory-completion menu (InputBox.tsx dir candidates).
#[derive(Debug, Clone, Default)]
pub struct DirMenu {
    /// Matching subdirectory names (alphabetical); each Tab-completes to
    /// `rel_prefix + name + "/"`.
    pub candidates: Vec<String>,
    /// Highlighted index into `candidates`.
    pub selected: usize,
    /// Scroll offset so the highlight stays within `MAX_DIR_CANDIDATES` rows.
    pub scroll: usize,
    /// Path prefix prepended to a candidate on Tab (e.g. "src/" or "").
    pub rel_prefix: String,
}

impl InputState {
    pub fn new() -> Self {
        InputState {
            paste_counter: 1, // pastes count from #1 (InputBox.tsx `pasteCounter`)
            ..InputState::default()
        }
    }

    /// The current buffer value.
    pub fn value(&self) -> &str {
        &self.text
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Whether the slash-completion menu is currently open (footer should hide).
    pub fn slash_open(&self) -> bool {
        self.slash.is_some()
    }

    /// Whether ANY completion menu (slash or `/add-dir` dir candidates) is open —
    /// the footer hides for either (both take the footer's slot, InputBox.tsx
    /// `menuOpen`).
    pub fn menu_open(&self) -> bool {
        self.slash.is_some() || self.dir.is_some()
    }

    /// Take (clear + return) the current buffer, resetting cursor + flags.
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        self.bash = false;
        self.slash = None;
        self.dir = None;
        self.paste_blocks.clear();
        self.history_idx = None;
        self.draft = None;
        std::mem::take(&mut self.text)
    }

    /// Replace the whole buffer (e.g. on `Recall`), placing the cursor at the end.
    pub fn set_value(&mut self, value: impl Into<String>) {
        self.text = value.into();
        self.cursor = self.text.len();
        self.bash = self.text.starts_with('!');
        self.slash = None;
        self.dir = None;
        self.paste_blocks.clear();
        self.history_idx = None;
        self.draft = None;
    }

    /// Insert bracketed-paste text at the cursor. Because a bracketed paste
    /// arrives as ONE event, embedded newlines are inserted literally instead of
    /// submitting at the first `\n` (the bug when paste falls through to per-char
    /// Enter events). Refreshes bash/slash derived state afterward.
    ///
    /// Note: this does not (yet) collapse a large paste into a `[Pasted text #N
    /// +K lines]` pill — the text is inserted verbatim. The pill is a display
    /// optimization tracked separately.
    pub fn insert_paste(&mut self, text: &str, commands: &[SlashCommand]) {
        if text.is_empty() {
            return;
        }
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let newlines = normalized.matches('\n').count();
        let char_count = normalized.chars().count();

        // Short paste: inserted verbatim (no pill), shifting existing blocks.
        if char_count <= PASTE_THRESHOLD && newlines <= PASTE_MAX_NEWLINES {
            self.insert_str(&normalized);
            self.refresh(commands);
            return;
        }

        // Long paste → collapse into an atomic pill; a trailing space after it
        // lets typing continue naturally (InputBox.tsx). The block spans the raw
        // content only, not the trailing space.
        let id = self.paste_counter;
        self.paste_counter += 1;
        let at = self.cursor;
        let ins = format!("{normalized} ");
        let ins_len = ins.len();
        let block_start = at;
        let block_end = at + normalized.len();
        for b in &mut self.paste_blocks {
            if b.start >= at {
                b.start += ins_len;
                b.end += ins_len;
            }
        }
        self.text.insert_str(at, &ins);
        self.paste_blocks.push(PasteBlock {
            id,
            start: block_start,
            end: block_end,
            lines: newlines,
        });
        self.paste_blocks.sort_by_key(|b| b.start);
        self.cursor = at + ins_len;
        self.refresh(commands);
    }

    /// Delete the paste block at `paste_blocks[idx]` and its raw content, shifting
    /// later blocks left and landing the cursor at the removed block's start.
    fn delete_block(&mut self, idx: usize) {
        let b = self.paste_blocks[idx];
        let dlen = b.end - b.start;
        self.text.replace_range(b.start..b.end, "");
        self.paste_blocks.remove(idx);
        for x in &mut self.paste_blocks {
            if x.start >= b.end {
                x.start -= dlen;
                x.end -= dlen;
            }
        }
        self.cursor = b.start;
    }

    // ── command history (InputBox.tsx ↑/↓ recall) ────────────────────────────

    /// Record a submitted line for ↑ recall (most-recent-first, skipping an
    /// immediate duplicate) and exit any active history navigation.
    fn push_history(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        if self.history.first().map(String::as_str) != Some(line) {
            self.history.insert(0, line.to_string());
        }
        self.history_idx = None;
        self.draft = None;
    }

    /// ↑ from the first-line start: enter history (stashing the live draft on
    /// first entry) or step toward older entries. No-op with empty history.
    fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        if self.history_idx.is_none() {
            self.draft = Some(self.text.clone());
        }
        let next = match self.history_idx {
            None => 0,
            Some(i) => (i + 1).min(self.history.len() - 1),
        };
        self.load_history_entry(next);
        self.cursor = 0;
    }

    /// ↓ from the last-line end: step toward newer entries, or restore the
    /// stashed draft when leaving history at the newest entry. No-op when not
    /// currently navigating history.
    fn history_next(&mut self) {
        let Some(i) = self.history_idx else {
            return;
        };
        if i > 0 {
            self.load_history_entry(i - 1);
            self.cursor = self.text.len();
        } else {
            self.history_idx = None;
            self.text = self.draft.take().unwrap_or_default();
            self.cursor = self.text.len();
            self.bash = self.text.starts_with('!');
            self.slash = None;
            self.dir = None;
            self.paste_blocks.clear();
        }
    }

    /// Load `history[idx]` into the buffer, refreshing bash/slash derived state.
    /// The cursor is positioned by the caller (0 for ↑, end for ↓).
    fn load_history_entry(&mut self, idx: usize) {
        self.history_idx = Some(idx);
        self.text = self.history[idx].clone();
        self.bash = self.text.starts_with('!');
        self.slash = None;
        self.dir = None;
        self.paste_blocks.clear();
    }

    // ── editing primitives ───────────────────────────────────────────────────

    /// Recompute derived state (`bash`, `slash`) after any edit. Mirrors the TS
    /// `bashMode = value.startsWith("!")` plus the `showSlash` derivation that
    /// rebuilds the suggestion list from the trimmed buffer on each render.
    fn refresh(&mut self, commands: &[SlashCommand]) {
        self.bash = self.text.starts_with('!');
        // `/add-dir <path>` directory completion takes the menu slot; only when it
        // is closed does the slash-command menu apply (they can't both be open — a
        // slash match needs no space, `/add-dir` completion needs one).
        self.dir = self.compute_dir_menu();
        self.slash = if self.dir.is_some() {
            None
        } else {
            self.compute_slash(commands)
        };
    }

    /// Build the `/add-dir` directory-candidate menu when the buffer is
    /// `/add-dir <path>` (InputBox.tsx `useEffect` + `listDirCandidates`). Listing
    /// is synchronous `read_dir` — fast enough per keystroke, so no async plumbing.
    /// Selection/scroll reset to the top on every rebuild (TS `setDirIdx(0)`).
    fn compute_dir_menu(&self) -> Option<DirMenu> {
        let arg = add_dir_arg(&self.text)?;
        let (dir_base, dir_filter, rel_prefix) = parse_add_dir_arg(&arg);
        let candidates = list_dir_candidates(&dir_base, &dir_filter);
        if candidates.is_empty() {
            return None;
        }
        Some(DirMenu {
            candidates,
            selected: 0,
            scroll: 0,
            rel_prefix,
        })
    }

    /// Build the slash suggestion list when applicable (§7). Filter:
    /// `name.starts_with(input) && name != input`, alphabetical. Open only when
    /// the trimmed buffer starts with `/` and contains no space yet (the TS
    /// `showSlash`). Preserves the previously-selected index when possible.
    fn compute_slash(&self, commands: &[SlashCommand]) -> Option<SlashMenu> {
        if self.bash {
            return None;
        }
        let trimmed = self.text.trim_start();
        if !trimmed.starts_with('/') || trimmed.contains(' ') || trimmed.is_empty() {
            return None;
        }
        let mut matches: Vec<SlashCommand> = commands
            .iter()
            .filter(|c| c.name.starts_with(trimmed) && c.name != trimmed)
            .cloned()
            .collect();
        if matches.is_empty() {
            return None;
        }
        matches.sort_by(|a, b| a.name.cmp(&b.name));
        // Keep the old selection if the filter set still contains an item there;
        // the TS code resets to 0 whenever the trimmed text changes, but holding
        // the index steady within a stable filter feels closer to expectation.
        let prev = self.slash.as_ref().map(|m| m.selected).unwrap_or(0);
        let selected = prev.min(matches.len().saturating_sub(1));
        Some(SlashMenu { matches, selected })
    }

    /// Insert a string at the cursor and advance past it, shifting any paste
    /// blocks that begin at/after the cursor (InputBox.tsx regular-input path).
    fn insert_str(&mut self, s: &str) {
        let len = s.len();
        let at = self.cursor;
        for b in &mut self.paste_blocks {
            if b.start >= at {
                b.start += len;
                b.end += len;
            }
        }
        self.text.insert_str(at, s);
        self.cursor = at + len;
    }

    /// Byte offset of the previous char boundary before `cursor` (or `cursor`).
    fn prev_boundary(&self) -> usize {
        if self.cursor == 0 {
            return 0;
        }
        let mut i = self.cursor - 1;
        while i > 0 && !self.text.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    /// Byte offset of the next char boundary after `cursor` (or `cursor`).
    fn next_boundary(&self) -> usize {
        if self.cursor >= self.text.len() {
            return self.text.len();
        }
        let mut i = self.cursor + 1;
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i
    }

    /// Start byte offset of the logical line containing `cursor`.
    fn line_start(&self) -> usize {
        self.text[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0)
    }

    /// End byte offset (exclusive of `\n`) of the logical line containing `cursor`.
    fn line_end(&self) -> usize {
        self.text[self.cursor..]
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len())
    }

    // ── slash menu accept ──────────────────────────────────────────────────────

    /// Accept the highlighted slash command by rewriting the buffer to
    /// `{leading}{name} ` (trailing space) and moving the cursor to the end —
    /// completion ONLY, never execution (mirrors InputBox.tsx, where Tab and
    /// slash-menu Enter both just autocomplete). The command runs on the *next*
    /// Enter: the trailing space closes the menu so the normal submit path fires,
    /// which is what lets arg-taking commands (/rename, /add-dir, /mode) be typed.
    fn accept_slash(&mut self) -> InputAction {
        let Some(menu) = &self.slash else {
            return InputAction::None;
        };
        let Some(cmd) = menu.matches.get(menu.selected).cloned() else {
            return InputAction::None;
        };
        let leading_len = self.text.len() - self.text.trim_start().len();
        let leading = self.text[..leading_len].to_string();
        let completed = format!("{leading}{} ", cmd.name);
        self.text = completed;
        self.cursor = self.text.len();
        self.bash = false;
        self.slash = None;
        self.paste_blocks.clear();
        InputAction::None
    }

    // ── /add-dir candidate menu nav + accept ────────────────────────────────────

    /// Move the `/add-dir` candidate highlight (wraps), keeping it within the
    /// `MAX_DIR_CANDIDATES` scroll window (InputBox.tsx dir-candidate ↑/↓).
    fn dir_move(&mut self, delta: i32) {
        let Some(dir) = &mut self.dir else {
            return;
        };
        let len = dir.candidates.len();
        if len == 0 {
            return;
        }
        if delta < 0 {
            let next = if dir.selected > 0 { dir.selected - 1 } else { len - 1 };
            dir.selected = next;
            if next == len - 1 {
                dir.scroll = len.saturating_sub(MAX_DIR_CANDIDATES);
            } else if next < dir.scroll {
                dir.scroll = next;
            }
        } else {
            let next = if dir.selected + 1 < len { dir.selected + 1 } else { 0 };
            dir.selected = next;
            if next == 0 {
                dir.scroll = 0;
            } else if next >= dir.scroll + MAX_DIR_CANDIDATES {
                dir.scroll = next - MAX_DIR_CANDIDATES + 1;
            }
        }
    }

    /// Tab-complete the highlighted `/add-dir` candidate: replace the argument
    /// with `rel_prefix + name + "/"` (InputBox.tsx dir Tab). The trailing `/`
    /// makes a subsequent Tab cascade into the just-completed directory, so we
    /// refresh to re-list it.
    fn accept_dir(&mut self, commands: &[SlashCommand]) -> InputAction {
        let Some(dir) = &self.dir else {
            return InputAction::None;
        };
        let Some(name) = dir.candidates.get(dir.selected) else {
            return InputAction::None;
        };
        let completion = format!("{}{}/", dir.rel_prefix, name);
        let Some(cmd_pos) = self.text.find("/add-dir") else {
            return InputAction::None;
        };
        let after = cmd_pos + "/add-dir".len();
        let ws_len = self.text[after..].len() - self.text[after..].trim_start().len();
        let arg_start = after + ws_len;
        // The argument is the remainder of the (single-line) `/add-dir` buffer.
        self.text.truncate(arg_start);
        self.text.push_str(&completion);
        self.cursor = self.text.len();
        self.paste_blocks.clear();
        self.refresh(commands);
        InputAction::None
    }

    /// Handle one key press given the available slash commands (for filtering).
    /// Returns what main.rs should do.
    pub fn handle_key(&mut self, key: KeyEvent, commands: &[SlashCommand]) -> InputAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        match key.code {
            // ── /add-dir candidate navigation (only when open, wraps) ────────
            KeyCode::Up if self.dir.is_some() => {
                self.dir_move(-1);
                InputAction::None
            }
            KeyCode::Down if self.dir.is_some() => {
                self.dir_move(1);
                InputAction::None
            }

            // ── Slash menu navigation (only when open) ───────────────────────
            KeyCode::Up if self.slash.is_some() => {
                if let Some(menu) = &mut self.slash {
                    let n = menu.matches.len();
                    if n > 0 {
                        menu.selected = if menu.selected == 0 {
                            n - 1
                        } else {
                            menu.selected - 1
                        };
                    }
                }
                InputAction::None
            }
            KeyCode::Down if self.slash.is_some() => {
                if let Some(menu) = &mut self.slash {
                    let n = menu.matches.len();
                    if n > 0 {
                        menu.selected = (menu.selected + 1) % n;
                    }
                }
                InputAction::None
            }

            // ── Cursor movement (paste pills are skipped atomically) ─────────
            KeyCode::Left => {
                if self.cursor > 0 {
                    self.cursor = self
                        .paste_blocks
                        .iter()
                        .find(|b| b.end == self.cursor)
                        .map(|b| b.start)
                        .unwrap_or_else(|| self.prev_boundary());
                }
                InputAction::None
            }
            KeyCode::Right => {
                if self.cursor < self.text.len() {
                    self.cursor = self
                        .paste_blocks
                        .iter()
                        .find(|b| b.start == self.cursor)
                        .map(|b| b.end)
                        .unwrap_or_else(|| self.next_boundary());
                }
                InputAction::None
            }
            // ↑/↓ operate in DISPLAY space (a folded pill collapses its hidden raw
            // newlines to one line) — InputBox.tsx posToLineCol/lineColToOffset.
            KeyCode::Up => {
                let (display, segs, _) = build_display(&self.text, &self.paste_blocks);
                let d_cur = raw_to_display(&segs, self.cursor);
                let (line, col) = pos_to_line_col(&display, d_cur);
                if line > 0 {
                    let d = line_col_to_offset(&display, line - 1, col);
                    self.cursor = display_to_raw(&segs, d, self.text.len());
                } else if col > 0 {
                    self.cursor = display_to_raw(&segs, 0, self.text.len());
                } else {
                    self.history_prev();
                }
                InputAction::None
            }
            KeyCode::Down => {
                let (display, segs, _) = build_display(&self.text, &self.paste_blocks);
                let d_cur = raw_to_display(&segs, self.cursor);
                let last_line = display.split('\n').count() - 1;
                let (line, col) = pos_to_line_col(&display, d_cur);
                if line < last_line {
                    let d = line_col_to_offset(&display, line + 1, col);
                    self.cursor = display_to_raw(&segs, d, self.text.len());
                } else {
                    let bytes = display.as_bytes();
                    let at_end = d_cur >= display.len() || bytes.get(d_cur) == Some(&b'\n');
                    if !at_end {
                        let mut i = d_cur;
                        while i < display.len() && bytes[i] != b'\n' {
                            i += 1;
                        }
                        self.cursor = display_to_raw(&segs, i, self.text.len());
                    } else if self.history_idx.is_some() {
                        self.history_next();
                    }
                }
                InputAction::None
            }
            // Home/End also work in display space so a pill counts as one column.
            KeyCode::Home => {
                let (display, segs, _) = build_display(&self.text, &self.paste_blocks);
                let d_cur = raw_to_display(&segs, self.cursor);
                let bytes = display.as_bytes();
                let mut i = d_cur;
                while i > 0 && bytes[i - 1] != b'\n' {
                    i -= 1;
                }
                self.cursor = display_to_raw(&segs, i, self.text.len());
                InputAction::None
            }
            KeyCode::End => {
                let (display, segs, _) = build_display(&self.text, &self.paste_blocks);
                let d_cur = raw_to_display(&segs, self.cursor);
                let bytes = display.as_bytes();
                let mut i = d_cur;
                while i < display.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                self.cursor = display_to_raw(&segs, i, self.text.len());
                InputAction::None
            }

            // ── Newline (Ctrl+J / Ctrl+M) ────────────────────────────────────
            KeyCode::Char('j') | KeyCode::Char('m') if ctrl => {
                self.insert_str("\n");
                self.refresh(commands);
                InputAction::None
            }

            // ── Tab: accept dir candidate, else slash completion, if open ────
            KeyCode::Tab => {
                if self.dir.is_some() {
                    self.accept_dir(commands)
                } else if self.slash.is_some() {
                    self.accept_slash()
                } else {
                    InputAction::None
                }
            }

            // ── Enter: accept slash completion, else submit ──────────────────
            KeyCode::Enter => {
                if self.slash.is_some() {
                    self.accept_slash()
                } else if self.text.trim().is_empty() {
                    InputAction::None
                } else {
                    // Trim trailing whitespace like the TS `value.replace(/\s+$/, "")`.
                    let submitted = self.text.trim_end().to_string();
                    self.push_history(&submitted);
                    self.text.clear();
                    self.cursor = 0;
                    self.bash = false;
                    self.slash = None;
                    self.dir = None;
                    self.paste_blocks.clear();
                    InputAction::Submit(submitted)
                }
            }

            // ── Backspace (deleting a pill removes the whole pasted block) ────
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    if let Some(idx) = self.paste_blocks.iter().position(|b| b.end == self.cursor) {
                        self.delete_block(idx);
                    } else {
                        let start = self.prev_boundary();
                        let orig = self.cursor;
                        let dlen = orig - start;
                        self.text.replace_range(start..orig, "");
                        for x in &mut self.paste_blocks {
                            if x.start >= orig {
                                x.start -= dlen;
                                x.end -= dlen;
                            }
                        }
                        self.cursor = start;
                    }
                    self.refresh(commands);
                }
                InputAction::None
            }

            // ── Delete (forward; a pill at the cursor is removed wholesale) ───
            KeyCode::Delete => {
                if self.cursor < self.text.len() {
                    if let Some(idx) = self.paste_blocks.iter().position(|b| b.start == self.cursor) {
                        self.delete_block(idx);
                    } else {
                        let at = self.cursor;
                        let end = self.next_boundary();
                        let dlen = end - at;
                        self.text.replace_range(at..end, "");
                        for x in &mut self.paste_blocks {
                            if x.start > at {
                                x.start -= dlen;
                                x.end -= dlen;
                            }
                        }
                    }
                    self.refresh(commands);
                }
                InputAction::None
            }

            // ── Printable input ──────────────────────────────────────────────
            KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                self.insert_str(s);
                self.refresh(commands);
                InputAction::None
            }

            _ => InputAction::None,
        }
    }

    /// Build the folded display string for rendering: bash mode drops the leading
    /// `!` (shifting blocks by -1), then each paste block's raw content is replaced
    /// by its `[Pasted text …]` label. Returns `(display, pill_mask, segs,
    /// disp_cursor)` where `pill_mask[i]` marks display char `i` as inside a pill
    /// and `disp_cursor` is the cursor's byte offset in `display`.
    fn render_display(&self) -> (String, Vec<bool>, Vec<Seg>, usize) {
        if self.bash {
            let stripped = self.text.strip_prefix('!').unwrap_or(&self.text).to_string();
            // Blocks shift left by the consumed `!`; a block that was only the `!`
            // (end<=1) can't exist, but guard anyway.
            let shifted: Vec<PasteBlock> = self
                .paste_blocks
                .iter()
                .filter(|b| b.end > 1)
                .map(|b| PasteBlock {
                    id: b.id,
                    start: b.start.saturating_sub(1),
                    end: b.end - 1,
                    lines: b.lines,
                })
                .collect();
            let (display, segs, mask) = build_display(&stripped, &shifted);
            let disp_cursor = raw_to_display(&segs, self.cursor.saturating_sub(1));
            (display, mask, segs, disp_cursor)
        } else {
            let (display, segs, mask) = build_display(&self.text, &self.paste_blocks);
            let disp_cursor = raw_to_display(&segs, self.cursor);
            (display, mask, segs, disp_cursor)
        }
    }

    /// Render the input box: top rule + prompt/text lines (with soft cursor,
    /// command-token coloring, and dim paste pills), then either a completion list
    /// (in place of the bottom rule) or the bottom rule. `cols` is the terminal
    /// width.
    pub fn render(&self, cols: usize) -> Vec<Line<'static>> {
        let cols = cols.max(1);
        let mut out: Vec<Line<'static>> = Vec::new();

        // ── top rule ──────────────────────────────────────────────────────────
        out.push(rule_line(cols, self.bash));

        let bash = self.bash;
        let (display, pill_mask, segs, disp_cursor) = self.render_display();

        // Command-token range in DISPLAY offsets (ACCENT): a fully-typed known
        // command followed by whitespace, e.g. "/clear " (§7). Bash mode has none.
        let cmd_range = if bash {
            None
        } else {
            self.command_token_range(&self.text)
                .map(|(s, e)| (raw_to_display(&segs, s), raw_to_display(&segs, e)))
        };

        // ── wrap logical lines into visual chunks, tracking byte offsets ───────
        let visual = wrap_visual(&display, cols, bash);

        // Locate the visual line + local byte offset owning the cursor.
        let (cur_idx, local_cur) = locate_cursor(&visual, disp_cursor);

        for (i, vl) in visual.iter().enumerate() {
            let is_first = i == 0;
            let mut spans: Vec<Span<'static>> = Vec::new();
            if is_first && bash {
                spans.push(Span::styled("! ".to_string(), Style::default().fg(BASH)));
            } else {
                let pfx = if is_first { "> " } else { "  " };
                spans.push(Span::raw(pfx.to_string()));
            }
            let is_cursor_line = i == cur_idx;
            spans.extend(build_runs(
                &vl.text,
                vl.g0,
                is_cursor_line,
                local_cur,
                cmd_range,
                &pill_mask,
            ));
            out.push(Line::from(spans));
        }

        // ── completion list (replaces bottom rule) or bottom rule ─────────────
        if let Some(dir) = &self.dir {
            out.extend(self.render_dir_menu(dir, cols));
        } else if let Some(menu) = &self.slash {
            out.extend(self.render_slash_menu(menu, cols));
        } else {
            out.push(rule_line(cols, bash));
        }

        out
    }

    /// Render the `/add-dir` directory-candidate list: a dim `─` on top, then the
    /// visible window of `  {name}/` rows; the highlighted row is ACCENT, others
    /// default color (InputBox.tsx dir candidates — NOT dimmed, unlike the slash
    /// menu). The list scrolls when there are more than `MAX_DIR_CANDIDATES`.
    fn render_dir_menu(&self, dir: &DirMenu, cols: usize) -> Vec<Line<'static>> {
        let mut out: Vec<Line<'static>> = Vec::new();
        out.push(Line::from(Span::styled(
            "─".repeat(super::bar_width(cols)),
            Style::default().add_modifier(Modifier::DIM),
        )));
        let end = (dir.scroll + MAX_DIR_CANDIDATES).min(dir.candidates.len());
        for actual in dir.scroll..end {
            let name = &dir.candidates[actual];
            let style = if actual == dir.selected {
                Style::default().fg(ACCENT)
            } else {
                Style::default()
            };
            out.push(Line::from(Span::styled(format!("  {name}/"), style)));
        }
        out
    }

    /// Position of the cursor within `render()`'s output: `row` is the line index
    /// (0 = top rule, 1 = first prompt line, …), `col` is the column (prompt width
    /// 2 + display columns before the cursor). The caller places the REAL terminal
    /// cursor here so IME composing/preedit appears at the right spot instead of
    /// at ratatui's default (hidden) cursor location.
    pub fn cursor_view_pos(&self, cols: usize) -> (usize, usize) {
        let cols = cols.max(1);
        let (display, _mask, _segs, disp_cursor) = self.render_display();
        let visual = wrap_visual(&display, cols, self.bash);
        let (cur_idx, local_cur) = locate_cursor(&visual, disp_cursor);
        let col_before = display_width(&visual[cur_idx].text[..local_cur]);
        (1 + cur_idx, 2 + col_before)
    }

    /// The byte range within `display` of a fully-typed known command token (the
    /// `cmdRange` of the TS source), e.g. matching `^(\s*)(/[a-zA-Z][\w-]*)(\s)`.
    /// Returns `None` in bash mode or when no trailing space yet.
    fn command_token_range(&self, display: &str) -> Option<(usize, usize)> {
        if self.bash {
            return None;
        }
        let leading_len = display.len() - display.trim_start().len();
        let rest = &display[leading_len..];
        if !rest.starts_with('/') {
            return None;
        }
        // token = '/' + [A-Za-z] + [\w-]* , then must be followed by whitespace.
        let mut chars = rest.char_indices();
        chars.next(); // '/'
        let first = chars.next();
        if !matches!(first, Some((_, c)) if c.is_ascii_alphabetic()) {
            return None;
        }
        let mut end = first.unwrap().0 + 1; // byte offset within `rest`
        for (idx, c) in chars {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                end = idx + c.len_utf8();
            } else {
                break;
            }
        }
        // Highlight when followed by whitespace OR at end-of-string (e.g.
        // `/btw` typed to completion without trailing space — bug report).
        let after = &rest[end..];
        if !after.is_empty() && !after.starts_with(char::is_whitespace) {
            return None;
        }
        Some((leading_len, leading_len + end))
    }

    /// Render the slash completion list (§7): a dim `─` on top, then each item
    /// `  {name}{pad}  {desc}` with the name column padded to `max(20, longest+2)`;
    /// selected row ACCENT (not dim), others dim. Unimplemented commands append a
    /// `(未实现)` note to the description.
    fn render_slash_menu(&self, menu: &SlashMenu, cols: usize) -> Vec<Line<'static>> {
        let mut out: Vec<Line<'static>> = Vec::new();
        // Top rule for the list always uses dim (the TS `<Text dimColor>`), even
        // though slash mode can't coexist with bash mode.
        out.push(Line::from(Span::styled(
            "─".repeat(super::bar_width(cols)),
            Style::default().add_modifier(Modifier::DIM),
        )));

        let name_col = menu
            .matches
            .iter()
            .map(|c| c.name.chars().count() + 2)
            .max()
            .unwrap_or(0)
            .max(20);

        for (i, c) in menu.matches.iter().enumerate() {
            let name_w = c.name.chars().count();
            let pad = name_col.saturating_sub(name_w).max(2);
            let mut desc = c.desc.clone();
            if !c.implemented {
                desc = if desc.is_empty() {
                    "(未实现)".to_string()
                } else {
                    format!("{desc} (未实现)")
                };
            }
            let label = format!("  {}{}  {}", c.name, " ".repeat(pad), desc);
            let style = if i == menu.selected {
                Style::default().fg(ACCENT)
            } else {
                Style::default().add_modifier(Modifier::DIM)
            };
            out.push(Line::from(Span::styled(label, style)));
        }
        out
    }
}

// ── module-private helpers ──────────────────────────────────────────────────

/// A visual (wrapped) line: its text plus the byte offset where it starts within
/// the displayed string.
struct Visual {
    text: String,
    g0: usize,
}

/// The full-width rule line: dim normally, BASH color (not dim) in bash mode.
fn rule_line(cols: usize, bash: bool) -> Line<'static> {
    let bar = "─".repeat(super::bar_width(cols));
    let style = if bash {
        Style::default().fg(BASH)
    } else {
        Style::default().add_modifier(Modifier::DIM)
    };
    Line::from(Span::styled(bar, style))
}

/// Terminal display width of `s` (CJK / wide chars count as 2). Minimal port of
/// `string-width` — no third-party crate per §0.1.
fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// Display columns for one char: 0 for combining/zero-width, 2 for wide East
/// Asian / emoji ranges, 1 otherwise. Heuristic (no unicode_width crate).
fn char_width(c: char) -> usize {
    let cp = c as u32;
    // Control chars (other than already-split newlines) — treat as width 0.
    if cp < 0x20 || cp == 0x7f {
        return 0;
    }
    // Zero-width / combining marks.
    if (0x300..=0x36f).contains(&cp)        // combining diacritical marks
        || (0x200b..=0x200f).contains(&cp)  // zero-width space/joiners, marks
        || cp == 0xfeff
        || (0x1ab0..=0x1aff).contains(&cp)
        || (0x1dc0..=0x1dff).contains(&cp)
        || (0x20d0..=0x20ff).contains(&cp)
        || (0xfe20..=0xfe2f).contains(&cp)
    {
        return 0;
    }
    // Wide ranges (East Asian Wide/Fullwidth + common emoji blocks).
    if (0x1100..=0x115f).contains(&cp)       // Hangul Jamo
        || (0x2e80..=0x303e).contains(&cp)   // CJK radicals … punctuation
        || (0x3041..=0x33ff).contains(&cp)   // Hiragana … CJK compat
        || (0x3400..=0x4dbf).contains(&cp)   // CJK Ext A
        || (0x4e00..=0x9fff).contains(&cp)   // CJK Unified
        || (0xa000..=0xa4cf).contains(&cp)   // Yi
        || (0xac00..=0xd7a3).contains(&cp)   // Hangul syllables
        || (0xf900..=0xfaff).contains(&cp)   // CJK compat ideographs
        || (0xfe10..=0xfe19).contains(&cp)   // vertical forms
        || (0xfe30..=0xfe6f).contains(&cp)   // CJK compat forms / small forms
        || (0xff00..=0xff60).contains(&cp)   // fullwidth forms
        || (0xffe0..=0xffe6).contains(&cp)   // fullwidth signs
        || (0x1f300..=0x1faff).contains(&cp) // emoji / symbols & pictographs
        || (0x20000..=0x3fffd).contains(&cp) // CJK Ext B+
    {
        return 2;
    }
    1
}

/// Within byte range `[start, end)` of `text`, return the byte offset whose
/// preceding display width best matches `target_col` (snapping to a char
/// boundary; clamps to `end` when the line is shorter than `target_col`).
fn offset_at_col(text: &str, start: usize, end: usize, target_col: usize) -> usize {
    let mut col = 0usize;
    let segment = &text[start..end];
    for (i, c) in segment.char_indices() {
        if col >= target_col {
            return start + i;
        }
        col += char_width(c);
    }
    end
}

/// Wrap the displayed string into visual lines (per §7: split logical lines on
/// `\n`, then hard-wrap each to the usable width `cols - prefix_width`). The
/// first visual line uses the `> `/`! ` prompt width (2); continuations `  ` (2).
fn wrap_visual(display: &str, cols: usize, _bash: bool) -> Vec<Visual> {
    // Both the prompt and the continuation indent are width 2.
    let max_cols = cols.saturating_sub(2).max(1);
    let mut visual: Vec<Visual> = Vec::new();

    // Split into logical lines, each carrying its global byte offset.
    let mut logical: Vec<(usize, &str)> = Vec::new();
    let mut start = 0usize;
    for (i, b) in display.bytes().enumerate() {
        if b == b'\n' {
            logical.push((start, &display[start..i]));
            start = i + 1;
        }
    }
    logical.push((start, &display[start..]));

    for (g0, line) in logical {
        if line.is_empty() {
            visual.push(Visual {
                text: String::new(),
                g0,
            });
            continue;
        }
        let mut chunk = String::new();
        let mut chunk_cols = 0usize;
        let mut chunk_start = g0;
        for (ci, c) in line.char_indices() {
            let w = char_width(c);
            if chunk_cols + w > max_cols && !chunk.is_empty() {
                visual.push(Visual {
                    text: std::mem::take(&mut chunk),
                    g0: chunk_start,
                });
                chunk_cols = 0;
                chunk_start = g0 + ci;
            }
            chunk.push(c);
            chunk_cols += w;
        }
        if !chunk.is_empty() {
            visual.push(Visual {
                text: chunk,
                g0: chunk_start,
            });
        }
    }
    if visual.is_empty() {
        visual.push(Visual {
            text: String::new(),
            g0: 0,
        });
    }
    visual
}

/// Find which visual line owns the cursor and the local byte offset within it.
fn locate_cursor(visual: &[Visual], disp_cursor: usize) -> (usize, usize) {
    for (i, vl) in visual.iter().enumerate() {
        let g_end = vl.g0 + vl.text.len();
        if disp_cursor >= vl.g0 && disp_cursor < g_end {
            return (i, disp_cursor - vl.g0);
        }
    }
    // Cursor at the very end (or on a wrap boundary): put it on the last line.
    let last = visual.len() - 1;
    (last, visual[last].text.len())
}

/// The style class of a display char (InputBox.tsx `RunKind`, minus the cursor
/// which is handled inline). Priority: pill > command > text.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RunKind {
    Text,
    Command,
    Pill,
}

/// Build the styled spans for one visual line, embedding the soft cursor (white
/// on black) at `cur` when this is the cursor line, coloring the command token
/// range ACCENT and paste-pill placeholders DIM (§7). `g_start` is the byte
/// offset of `text` in `display`; `pill_mask[g]` marks display char `g` as pill.
fn build_runs(
    text: &str,
    g_start: usize,
    is_cursor_line: bool,
    cur: usize,
    cmd_range: Option<(usize, usize)>,
    pill_mask: &[bool],
) -> Vec<Span<'static>> {
    let cursor_style = Style::default().bg(CURSOR_BG).fg(CURSOR_FG);

    let kind_at = |g: usize| -> RunKind {
        if pill_mask.get(g).copied().unwrap_or(false) {
            RunKind::Pill
        } else if matches!(cmd_range, Some((s, e)) if g >= s && g < e) {
            RunKind::Command
        } else {
            RunKind::Text
        }
    };

    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut buf = String::new();
    let mut buf_kind = RunKind::Text;

    let flush = |spans: &mut Vec<Span<'static>>, buf: &mut String, kind: RunKind| {
        if !buf.is_empty() {
            let style = match kind {
                RunKind::Command => Style::default().fg(ACCENT),
                RunKind::Pill => Style::default().add_modifier(Modifier::DIM),
                RunKind::Text => Style::default(),
            };
            spans.push(Span::styled(std::mem::take(buf), style));
        }
    };

    for (i, c) in text.char_indices() {
        if is_cursor_line && i == cur {
            flush(&mut spans, &mut buf, buf_kind);
            spans.push(Span::styled(c.to_string(), cursor_style));
            continue;
        }
        let k = kind_at(g_start + i);
        if !buf.is_empty() && k != buf_kind {
            flush(&mut spans, &mut buf, buf_kind);
        }
        if buf.is_empty() {
            buf_kind = k;
        }
        buf.push(c);
    }
    flush(&mut spans, &mut buf, buf_kind);

    // End-of-line cursor: a trailing white-on-black space.
    if is_cursor_line && cur >= text.len() {
        spans.push(Span::styled(" ".to_string(), cursor_style));
    }
    spans
}

// ── paste-pill display layer (InputBox.tsx buildDisplay / raw↔display) ──────

/// The pill label for paste block `#id` (InputBox.tsx `formatPasteLabel`).
fn format_paste_label(id: u32, lines: usize) -> String {
    if lines == 0 {
        format!("[Pasted text #{id}]")
    } else {
        format!("[Pasted text #{id} +{lines} lines]")
    }
}

/// A display segment: ordinary text or a collapsed paste placeholder. Offsets are
/// bytes; `raw*` index into the source text, `d_start` into the display string.
#[derive(Debug, Clone)]
enum Seg {
    Text { raw0: usize, raw1: usize, d_start: usize },
    Paste { raw0: usize, raw1: usize, d_start: usize, label_len: usize },
}

/// Build the display string (each block's raw content replaced by its pill label)
/// plus the segment table and a per-display-char `pill_mask` (InputBox.tsx
/// `buildDisplay`). `blocks` need not be pre-sorted.
fn build_display(text: &str, blocks: &[PasteBlock]) -> (String, Vec<Seg>, Vec<bool>) {
    let mut sorted: Vec<&PasteBlock> = blocks.iter().collect();
    sorted.sort_by_key(|b| b.start);

    let mut segs: Vec<Seg> = Vec::new();
    let mut pill_mask: Vec<bool> = Vec::new();
    let mut display = String::new();
    let mut pos = 0usize;

    for b in sorted {
        if b.start > pos {
            let d_start = display.len();
            segs.push(Seg::Text { raw0: pos, raw1: b.start, d_start });
            display.push_str(&text[pos..b.start]);
            pill_mask.resize(display.len(), false);
        }
        let label = format_paste_label(b.id, b.lines);
        let d_start = display.len();
        segs.push(Seg::Paste { raw0: b.start, raw1: b.end, d_start, label_len: label.len() });
        display.push_str(&label);
        pill_mask.resize(display.len(), true);
        pos = b.end;
    }
    if pos < text.len() || segs.is_empty() {
        let d_start = display.len();
        segs.push(Seg::Text { raw0: pos, raw1: text.len(), d_start });
        display.push_str(&text[pos..]);
        pill_mask.resize(display.len(), false);
    }
    (display, segs, pill_mask)
}

/// Raw byte offset (never inside a block) → display byte offset.
fn raw_to_display(segs: &[Seg], raw: usize) -> usize {
    for seg in segs {
        match *seg {
            Seg::Text { raw0, raw1, d_start } => {
                if raw >= raw0 && raw <= raw1 {
                    return d_start + (raw - raw0);
                }
            }
            Seg::Paste { raw0, raw1, d_start, label_len } => {
                if raw == raw0 {
                    return d_start;
                }
                if raw == raw1 {
                    return d_start + label_len;
                }
            }
        }
    }
    0
}

/// Display byte offset → raw byte offset, snapping out of any placeholder label
/// so the cursor never lands *inside* a pill (InputBox.tsx `displayToRaw`).
fn display_to_raw(segs: &[Seg], d: usize, raw_len: usize) -> usize {
    for seg in segs {
        match *seg {
            Seg::Text { raw0, raw1, d_start } => {
                let d_end = d_start + (raw1 - raw0);
                if d >= d_start && d <= d_end {
                    return raw0 + (d - d_start);
                }
            }
            Seg::Paste { raw0, raw1, d_start, label_len } => {
                let d_end = d_start + label_len;
                if d >= d_start && d <= d_end {
                    return if d < d_start + label_len / 2 { raw0 } else { raw1 };
                }
            }
        }
    }
    raw_len
}

/// Map a display byte offset to `(line, col)` where `col` is measured in terminal
/// columns (InputBox.tsx `posToLineCol`).
fn pos_to_line_col(display: &str, offset: usize) -> (usize, usize) {
    let mut line = 0usize;
    let mut col = 0usize;
    for (i, c) in display.char_indices() {
        if i >= offset {
            break;
        }
        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += char_width(c);
        }
    }
    (line, col)
}

/// Convert `(target_line, target_col)` back to a display byte offset (InputBox.tsx
/// `lineColToOffset`); `target_col` is terminal columns.
fn line_col_to_offset(display: &str, target_line: usize, target_col: usize) -> usize {
    let mut line = 0usize;
    let mut col = 0usize;
    for (i, c) in display.char_indices() {
        if line == target_line {
            if col >= target_col {
                return i;
            }
            col += char_width(c);
        } else if c == '\n' {
            line += 1;
            if line > target_line {
                return i;
            }
        }
    }
    display.len()
}

// ── /add-dir directory completion (InputBox.tsx) ────────────────────────────

/// Extract the `<path>` argument of a `/add-dir <path>` buffer, or `None` when
/// the buffer is not `/add-dir` followed by whitespace (InputBox.tsx regex
/// `/^\s*\/add-dir\s+(.*)/`). An empty arg (`/add-dir ` with a trailing space)
/// returns `Some("")` → list every subdirectory of the cwd.
fn add_dir_arg(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix("/add-dir")?;
    // Require at least one whitespace char after the command name.
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim_start().to_string())
}

/// Expand a leading `~` / `~/` to `$HOME` (InputBox.tsx `expandTilde`).
fn expand_tilde(p: &str) -> String {
    if p == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

/// Parse a `/add-dir` argument into `(dir_base, dir_filter, rel_prefix)`
/// (InputBox.tsx `parseAddDirArg`, Unix subset):
/// - `dir_base`: absolute directory to list (cwd, moving on each `/`)
/// - `dir_filter`: prefix to filter subdirectory names ("" = all)
/// - `rel_prefix`: the path prefix prepended to a candidate on Tab-complete
fn parse_add_dir_arg(arg: &str) -> (PathBuf, String, String) {
    let cwd = deepdive_core::workspace::original_cwd();
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return (cwd, String::new(), String::new());
    }
    // Bare "~" → list $HOME; completions display as "~/<name>/".
    if trimmed == "~" {
        return (PathBuf::from(expand_tilde("~")), String::new(), "~/".to_string());
    }
    let Some(sep_idx) = trimmed.rfind(['/', '\\']) else {
        // No separator — filter against cwd entries.
        return (cwd, trimmed.to_string(), String::new());
    };
    let path_part = &trimmed[..sep_idx];
    let filter_part = trimmed[sep_idx + 1..].to_string();

    let dir_base: PathBuf = if path_part.is_empty() {
        // Leading `/` → filesystem root.
        PathBuf::from("/")
    } else {
        let expanded = expand_tilde(path_part);
        let p = Path::new(&expanded);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };

    let rel_prefix = if dir_base == cwd {
        String::new()
    } else if path_part.is_empty() || path_part == "/" {
        "/".to_string()
    } else {
        format!("{path_part}/")
    };
    (dir_base, filter_part, rel_prefix)
}

/// List subdirectory names under `dir_base`, filtered case-insensitively by the
/// `filter` prefix, sorted (InputBox.tsx `listDirCandidates`). A directory that
/// cannot be read yields an empty list.
fn list_dir_candidates(dir_base: &Path, filter: &str) -> Vec<String> {
    let lower = filter.to_lowercase();
    let Ok(read) = std::fs::read_dir(dir_base) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.to_lowercase().starts_with(&lower))
        .collect();
    names.sort();
    names
}

/// The built-in slash command autocomplete list (§7), alphabetical. Mirrors the
/// TS `slashCommands` registry (commands/index.ts) verbatim — same 8 commands,
/// same English descriptions. `/help`, `/mode` and `/resume` stay dispatchable
/// via `handle_slash` but (like the TS menu) are NOT surfaced here.
pub fn builtin_commands() -> Vec<SlashCommand> {
    let c = |name: &str, desc: &str| SlashCommand {
        name: name.to_string(),
        desc: desc.to_string(),
        implemented: true,
    };
    vec![
        c("/add-dir", "Add an extra workspace directory"),
        c("/agents", "List available subagents (built-in + custom)"),
        c("/btw", "Ask a quick side question without interrupting the main conversation"),
        c("/clear", "Clear the current conversation"),
        c("/compact", "Manually compact context to save tokens"),
        c("/model", "Choose the chat model"),
        c("/rename", "Rename the current session"),
        c("/settings", "Adjust runtime settings"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, KeyModifiers};

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    #[test]
    fn typing_and_backspace() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        for ch in "hi".chars() {
            s.handle_key(key(KeyCode::Char(ch)), &cmds);
        }
        assert_eq!(s.value(), "hi");
        assert_eq!(s.cursor, 2);
        s.handle_key(key(KeyCode::Backspace), &cmds);
        assert_eq!(s.value(), "h");
    }

    #[test]
    fn command_history_recall() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        // Submit two lines — history is most-recent-first.
        s.set_value("first");
        assert_eq!(
            s.handle_key(key(KeyCode::Enter), &cmds),
            InputAction::Submit("first".into())
        );
        s.set_value("second");
        assert_eq!(
            s.handle_key(key(KeyCode::Enter), &cmds),
            InputAction::Submit("second".into())
        );
        // Buffer empty; ↑ recalls newest → older, clamping at the oldest.
        s.handle_key(key(KeyCode::Up), &cmds);
        assert_eq!(s.value(), "second");
        s.handle_key(key(KeyCode::Up), &cmds);
        assert_eq!(s.value(), "first");
        s.handle_key(key(KeyCode::Up), &cmds);
        assert_eq!(s.value(), "first"); // clamped at the oldest entry

        // ↓ from col0 first moves the cursor to the line end (value unchanged),
        // then subsequent ↓ walk back toward the stashed (empty) draft.
        s.handle_key(key(KeyCode::Down), &cmds);
        assert_eq!(s.value(), "first");
        s.handle_key(key(KeyCode::Down), &cmds);
        assert_eq!(s.value(), "second");
        s.handle_key(key(KeyCode::Down), &cmds);
        assert_eq!(s.value(), ""); // restored draft
    }

    #[test]
    fn enter_submits_trimmed() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        for ch in "hello  ".chars() {
            s.handle_key(key(KeyCode::Char(ch)), &cmds);
        }
        let act = s.handle_key(key(KeyCode::Enter), &cmds);
        assert_eq!(act, InputAction::Submit("hello".to_string()));
        assert!(s.is_empty());
    }

    #[test]
    fn enter_ignores_blank() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char(' ')), &cmds);
        assert_eq!(s.handle_key(key(KeyCode::Enter), &cmds), InputAction::None);
    }

    #[test]
    fn ctrl_j_inserts_newline() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('a')), &cmds);
        s.handle_key(ctrl(KeyCode::Char('j')), &cmds);
        s.handle_key(key(KeyCode::Char('b')), &cmds);
        assert_eq!(s.value(), "a\nb");
    }

    #[test]
    fn bash_mode_detected() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('!')), &cmds);
        s.handle_key(key(KeyCode::Char('l')), &cmds);
        assert!(s.bash);
        assert!(s.slash.is_none());
    }

    #[test]
    fn slash_menu_opens_and_filters() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('/')), &cmds);
        s.handle_key(key(KeyCode::Char('c')), &cmds);
        let menu = s.slash.as_ref().expect("menu open");
        // /clear and /compact match "/c"
        assert!(menu.matches.iter().all(|m| m.name.starts_with("/c")));
        assert!(menu.matches.iter().any(|m| m.name == "/clear"));
        assert!(menu.matches.iter().any(|m| m.name == "/compact"));
    }

    #[test]
    fn slash_accept_completes_buffer_without_running() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        for ch in "/clea".chars() {
            s.handle_key(key(KeyCode::Char(ch)), &cmds);
        }
        // Enter (or Tab) on an open slash menu only completes the buffer; it does
        // NOT submit/run — the command runs on the next Enter.
        let act = s.handle_key(key(KeyCode::Enter), &cmds);
        assert_eq!(act, InputAction::None);
        assert_eq!(s.value(), "/clear ");
        assert!(s.slash.is_none());
        // Second Enter now submits the completed command.
        let act2 = s.handle_key(key(KeyCode::Enter), &cmds);
        assert_eq!(act2, InputAction::Submit("/clear".to_string()));
    }

    #[test]
    fn slash_nav_wraps() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('/')), &cmds);
        let n = s.slash.as_ref().unwrap().matches.len();
        assert!(n > 1);
        s.handle_key(key(KeyCode::Up), &cmds);
        assert_eq!(s.slash.as_ref().unwrap().selected, n - 1);
        s.handle_key(key(KeyCode::Down), &cmds);
        assert_eq!(s.slash.as_ref().unwrap().selected, 0);
    }

    #[test]
    fn cursor_left_right_and_insert_mid() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        for ch in "ac".chars() {
            s.handle_key(key(KeyCode::Char(ch)), &cmds);
        }
        s.handle_key(key(KeyCode::Left), &cmds);
        assert_eq!(s.cursor, 1);
        s.handle_key(key(KeyCode::Char('b')), &cmds);
        assert_eq!(s.value(), "abc");
    }

    #[test]
    fn render_has_rules_and_prompt() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('h')), &cmds);
        let lines = s.render(40);
        // top rule + one text line + bottom rule
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn add_dir_menu_lists_dirs_and_tab_completes() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("dd_adddir_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("alpha")).unwrap();
        fs::create_dir_all(base.join("beta")).unwrap();
        fs::write(base.join("afile.txt"), "x").unwrap(); // a plain file — excluded
        let cmds = builtin_commands();

        // `/add-dir {base}/` lists {base}'s subdirectories (dirs only, sorted).
        let mut s = InputState::new();
        s.set_value(format!("/add-dir {}/", base.display()));
        s.refresh(&cmds);
        let dir = s.dir.as_ref().expect("dir menu open");
        assert_eq!(dir.candidates, vec!["alpha".to_string(), "beta".to_string()]);
        assert!(s.menu_open());

        // Tab completes the highlighted (first) candidate → "…/alpha/".
        s.handle_key(key(KeyCode::Tab), &cmds);
        assert!(s.value().ends_with("/alpha/"), "got {:?}", s.value());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn add_dir_menu_filters_by_prefix() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("dd_adddir_flt_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("alpha")).unwrap();
        fs::create_dir_all(base.join("beta")).unwrap();
        let cmds = builtin_commands();

        // A filter after the last `/` narrows candidates case-insensitively.
        let mut s = InputState::new();
        s.set_value(format!("/add-dir {}/AL", base.display()));
        s.refresh(&cmds);
        let dir = s.dir.as_ref().expect("dir menu open");
        assert_eq!(dir.candidates, vec!["alpha".to_string()]);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn short_paste_inserts_verbatim() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.insert_paste("hello world", &cmds); // short, 0 newlines → no pill
        assert!(s.paste_blocks.is_empty());
        assert_eq!(s.value(), "hello world");
    }

    #[test]
    fn long_paste_folds_into_pill() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.insert_paste("l1\nl2\nl3\nl4", &cmds); // 3 newlines > PASTE_MAX_NEWLINES
        // Raw buffer keeps the content verbatim + a trailing space.
        assert_eq!(s.value(), "l1\nl2\nl3\nl4 ");
        assert_eq!(s.paste_blocks.len(), 1);
        let b = s.paste_blocks[0];
        assert_eq!((b.id, b.lines), (1, 3));
        assert_eq!(&s.value()[b.start..b.end], "l1\nl2\nl3\nl4");
        assert_eq!(s.cursor, s.value().len()); // just after the trailing space
        // Render collapses the 4 raw lines into ONE pill line between the rules.
        let lines = s.render(80);
        assert_eq!(lines.len(), 3); // top rule + 1 pill line + bottom rule
        let joined: String = lines[1].spans.iter().map(|sp| sp.content.as_ref()).collect();
        assert!(joined.contains("[Pasted text #1 +3 lines]"), "got {joined:?}");
    }

    #[test]
    fn left_and_backspace_treat_pill_atomically() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.insert_paste("a\nb\nc\nd", &cmds);
        let b = s.paste_blocks[0];
        // Left: end-of-buffer → after the pill (b.end) → then jumps over the pill.
        s.handle_key(key(KeyCode::Left), &cmds);
        assert_eq!(s.cursor, b.end);
        s.handle_key(key(KeyCode::Left), &cmds);
        assert_eq!(s.cursor, b.start);
        // Right jumps back over the whole pill to its end.
        s.handle_key(key(KeyCode::Right), &cmds);
        assert_eq!(s.cursor, b.end);
        // Backspace here removes the entire pasted block.
        s.handle_key(key(KeyCode::Backspace), &cmds);
        assert!(s.paste_blocks.is_empty());
        assert_eq!(s.value(), " "); // only the trailing space survives
    }

    #[test]
    fn typing_before_pill_shifts_block() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.insert_paste("a\nb\nc\nd", &cmds); // block at [0, 7)
        s.handle_key(key(KeyCode::Home), &cmds); // display Home → before the pill
        assert_eq!(s.cursor, 0);
        s.handle_key(key(KeyCode::Char('X')), &cmds);
        let b = s.paste_blocks[0];
        assert_eq!(b.start, 1); // shifted right by the inserted char
        assert_eq!(&s.value()[b.start..b.end], "a\nb\nc\nd");
        assert!(s.value().starts_with('X'));
    }

    #[test]
    fn build_display_folds_and_maps_offsets() {
        let text = "abXXXcd"; // pretend the "XXX" at [2,5) is a pasted block
        let blocks = vec![PasteBlock { id: 2, start: 2, end: 5, lines: 4 }];
        let (display, segs, mask) = build_display(text, &blocks);
        assert_eq!(display, "ab[Pasted text #2 +4 lines]cd");
        assert!(!mask[1] && mask[2] && !mask[display.len() - 1]);
        let label_end = 2 + "[Pasted text #2 +4 lines]".len();
        // raw block edges ↔ display label edges.
        assert_eq!(raw_to_display(&segs, 2), 2);
        assert_eq!(raw_to_display(&segs, 5), label_end);
        // A display offset inside the label snaps out to the nearest raw edge.
        assert_eq!(display_to_raw(&segs, 3, text.len()), 2);
        assert_eq!(display_to_raw(&segs, label_end - 1, text.len()), 5);
        // Trailing text maps back exactly ('d' is raw offset 6).
        assert_eq!(display_to_raw(&segs, label_end + 1, text.len()), 6);
    }

    #[test]
    fn render_slash_replaces_bottom_rule() {
        let mut s = InputState::new();
        let cmds = builtin_commands();
        s.handle_key(key(KeyCode::Char('/')), &cmds);
        let lines = s.render(60);
        // top rule + 1 prompt line + list rule + N items (no plain bottom rule).
        let n = s.slash.as_ref().unwrap().matches.len();
        assert_eq!(lines.len(), 1 + 1 + 1 + n);
    }
}
