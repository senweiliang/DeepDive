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
//! TODO (later stages, §7): paste-pill collapse (`[Pasted text #N +K lines]`),
//! history recall (↑ from first line into `history`), and `/add-dir` directory
//! candidate completion. The `history` field is reserved but not yet consumed.
#![allow(dead_code)]

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::{ACCENT, BASH, CURSOR_BG, CURSOR_FG};

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
    /// Submitted-line history for ↑ recall (later stage; field reserved now).
    pub history: Vec<String>,
}

/// Slash-completion menu state (§7).
#[derive(Debug, Clone, Default)]
pub struct SlashMenu {
    /// Filtered + alphabetically-sorted candidate commands.
    pub matches: Vec<SlashCommand>,
    /// Currently-highlighted index into `matches`.
    pub selected: usize,
}

impl InputState {
    pub fn new() -> Self {
        InputState::default()
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

    /// Take (clear + return) the current buffer, resetting cursor + flags.
    pub fn take(&mut self) -> String {
        self.cursor = 0;
        self.bash = false;
        self.slash = None;
        std::mem::take(&mut self.text)
    }

    /// Replace the whole buffer (e.g. on `Recall`), placing the cursor at the end.
    pub fn set_value(&mut self, value: impl Into<String>) {
        self.text = value.into();
        self.cursor = self.text.len();
        self.bash = self.text.starts_with('!');
        self.slash = None;
    }

    // ── editing primitives ───────────────────────────────────────────────────

    /// Recompute derived state (`bash`, `slash`) after any edit. Mirrors the TS
    /// `bashMode = value.startsWith("!")` plus the `showSlash` derivation that
    /// rebuilds the suggestion list from the trimmed buffer on each render.
    fn refresh(&mut self, commands: &[SlashCommand]) {
        self.bash = self.text.starts_with('!');
        self.slash = self.compute_slash(commands);
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

    /// Insert a string at the cursor and advance past it.
    fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
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
        InputAction::None
    }

    /// Handle one key press given the available slash commands (for filtering).
    /// Returns what main.rs should do.
    pub fn handle_key(&mut self, key: KeyEvent, commands: &[SlashCommand]) -> InputAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        match key.code {
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

            // ── Cursor movement ──────────────────────────────────────────────
            KeyCode::Left => {
                self.cursor = self.prev_boundary();
                InputAction::None
            }
            KeyCode::Right => {
                self.cursor = self.next_boundary();
                InputAction::None
            }
            KeyCode::Up => {
                self.move_vertical(-1);
                InputAction::None
            }
            KeyCode::Down => {
                self.move_vertical(1);
                InputAction::None
            }
            KeyCode::Home => {
                self.cursor = self.line_start();
                InputAction::None
            }
            KeyCode::End => {
                self.cursor = self.line_end();
                InputAction::None
            }

            // ── Newline (Ctrl+J / Ctrl+M) ────────────────────────────────────
            KeyCode::Char('j') | KeyCode::Char('m') if ctrl => {
                self.insert_str("\n");
                self.refresh(commands);
                InputAction::None
            }

            // ── Tab: accept slash completion if open ─────────────────────────
            KeyCode::Tab => {
                if self.slash.is_some() {
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
                    self.text.clear();
                    self.cursor = 0;
                    self.bash = false;
                    self.slash = None;
                    InputAction::Submit(submitted)
                }
            }

            // ── Backspace ────────────────────────────────────────────────────
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    let start = self.prev_boundary();
                    self.text.replace_range(start..self.cursor, "");
                    self.cursor = start;
                    self.refresh(commands);
                }
                InputAction::None
            }

            // ── Delete (forward) ─────────────────────────────────────────────
            KeyCode::Delete => {
                if self.cursor < self.text.len() {
                    let end = self.next_boundary();
                    self.text.replace_range(self.cursor..end, "");
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

    /// Move the cursor up/down one logical line, keeping the target column (in
    /// display columns) as close as possible — the TS up/down within the buffer.
    fn move_vertical(&mut self, dir: i32) {
        let cur_line_start = self.line_start();
        let target_col = display_width(&self.text[cur_line_start..self.cursor]);

        if dir < 0 {
            if cur_line_start == 0 {
                return; // already on the first logical line
            }
            // Previous line: [prev_start, cur_line_start - 1).
            let prev_start = self.text[..cur_line_start - 1]
                .rfind('\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            let prev_end = cur_line_start - 1;
            self.cursor = offset_at_col(&self.text, prev_start, prev_end, target_col);
        } else {
            let cur_line_end = self.line_end();
            if cur_line_end >= self.text.len() {
                return; // already on the last logical line
            }
            let next_start = cur_line_end + 1;
            let next_end = self.text[next_start..]
                .find('\n')
                .map(|i| next_start + i)
                .unwrap_or(self.text.len());
            self.cursor = offset_at_col(&self.text, next_start, next_end, target_col);
        }
    }

    /// Render the input box: top rule + prompt/text lines (with soft cursor &
    /// command-token coloring), then either the slash list (in place of the
    /// bottom rule) or the bottom rule. `cols` is the terminal width.
    pub fn render(&self, cols: usize) -> Vec<Line<'static>> {
        let cols = cols.max(1);
        let mut out: Vec<Line<'static>> = Vec::new();

        // ── top rule ──────────────────────────────────────────────────────────
        out.push(rule_line(cols, self.bash));

        // In bash mode the leading `!` is consumed by the `! ` prompt; render the
        // command portion only.
        let bash = self.bash;
        let display: &str = if bash {
            self.text.strip_prefix('!').unwrap_or(&self.text)
        } else {
            &self.text
        };
        // Cursor offset within the displayed string.
        let disp_cursor = if bash {
            self.cursor.saturating_sub(1)
        } else {
            self.cursor
        };

        // Command-token range (byte offsets in `display`) to color ACCENT: a
        // fully-typed known command followed by whitespace, e.g. "/clear " (§7).
        let cmd_range = self.command_token_range(display);

        // ── wrap logical lines into visual chunks, tracking byte offsets ───────
        let visual = wrap_visual(display, cols, bash);

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
            ));
            out.push(Line::from(spans));
        }

        // ── slash list (replaces bottom rule) or bottom rule ──────────────────
        if let Some(menu) = &self.slash {
            out.extend(self.render_slash_menu(menu, cols));
        } else {
            out.push(rule_line(cols, bash));
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
        let bash = self.bash;
        let display: &str = if bash {
            self.text.strip_prefix('!').unwrap_or(&self.text)
        } else {
            &self.text
        };
        let disp_cursor = if bash {
            self.cursor.saturating_sub(1)
        } else {
            self.cursor
        };
        let visual = wrap_visual(display, cols, bash);
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
        // Require a following whitespace char.
        let after = &rest[end..];
        if !after.starts_with(char::is_whitespace) {
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
            "─".repeat(cols),
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
    let bar = "─".repeat(cols);
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

/// Build the styled spans for one visual line, embedding the soft cursor (white
/// on black) at `cur` when this is the cursor line, and coloring the command
/// token range ACCENT (§7). `g_start` is the byte offset of `text` in `display`.
fn build_runs(
    text: &str,
    g_start: usize,
    is_cursor_line: bool,
    cur: usize,
    cmd_range: Option<(usize, usize)>,
) -> Vec<Span<'static>> {
    let cursor_style = Style::default().bg(CURSOR_BG).fg(CURSOR_FG);
    let cmd_style = Style::default().fg(ACCENT);

    let in_cmd = |g: usize| -> bool {
        matches!(cmd_range, Some((s, e)) if g >= s && g < e)
    };

    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut buf = String::new();
    let mut buf_cmd = false;

    let flush = |spans: &mut Vec<Span<'static>>, buf: &mut String, is_cmd: bool| {
        if !buf.is_empty() {
            let style = if is_cmd {
                cmd_style
            } else {
                Style::default()
            };
            spans.push(Span::styled(std::mem::take(buf), style));
        }
    };

    for (i, c) in text.char_indices() {
        if is_cursor_line && i == cur {
            flush(&mut spans, &mut buf, buf_cmd);
            spans.push(Span::styled(c.to_string(), cursor_style));
            continue;
        }
        let k = in_cmd(g_start + i);
        if !buf.is_empty() && k != buf_cmd {
            flush(&mut spans, &mut buf, buf_cmd);
        }
        if buf.is_empty() {
            buf_cmd = k;
        }
        buf.push(c);
    }
    flush(&mut spans, &mut buf, buf_cmd);

    // End-of-line cursor: a trailing white-on-black space.
    if is_cursor_line && cur >= text.len() {
        spans.push(Span::styled(" ".to_string(), cursor_style));
    }
    spans
}

/// The built-in slash command list (§7), alphabetical. The first five are wired
/// in this Rust front-end; the rest are listed but flagged unimplemented.
pub fn builtin_commands() -> Vec<SlashCommand> {
    let c = |name: &str, desc: &str, implemented: bool| SlashCommand {
        name: name.to_string(),
        desc: desc.to_string(),
        implemented,
    };
    vec![
        c("/add-dir", "添加工作区目录", true),
        c("/agents", "管理子代理", true),
        c("/clear", "清空对话", true),
        c("/compact", "压缩对话", true),
        c("/help", "命令帮助", true),
        c("/mode", "切换审批模式", true),
        c("/model", "切换模型", true),
        c("/rename", "重命名会话", true),
        c("/resume", "恢复会话", true),
        c("/settings", "设置", true),
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
