//! Transcript row rendering (§5). Each [`Row`] becomes a `Vec<Line>` (one entry
//! per terminal row); the block owns its trailing blank line (§0.3 spacing rule).
//!
//! Marker constants are the single source of truth: `MARKER` is "  ⎿ " (two
//! spaces, then U+23BF, then a SINGLE space), `MARKER_CONT` is "    " (4 spaces,
//! no glyph). The marker prefix renders dim; content follows per-row color rules.
//!
//! This mirrors the TS components `Chat.tsx` (MessageItem / buildTranscriptLines),
//! `Thinking.tsx`, `ToolResult.tsx`, and `tools/format.ts`
//! (`toolDisplayName`/`summarizeArgs`/`truncate`).
#![allow(dead_code)]

use crate::app::{DiffKind, DiffLine, Row};
use crate::render::markdown::render_markdown;
use crate::theme;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// "  ⎿ " — 2 spaces + U+23BF + a single space (§5).
pub const MARKER: &str = "  \u{23bf} ";
/// "    " — 4-space continuation, no glyph (§5).
pub const MARKER_CONT: &str = "    ";

/// Default per-row result preview cap before "… +N lines" (§5).
pub const RESULT_PREVIEW_LINES: usize = 3;

/// Fixed per-line width used by the full-screen transcript builder, matching
/// `RESULT_LINE_MAX` in `ToolResult.tsx`. The inline `<ToolResult>` is instead
/// responsive (`cols-5`), so the two views deliberately differ here.
pub const RESULT_LINE_MAX: usize = 120;

/// How much of a row to render. The Ctrl+O overlay shows what the inline
/// scrollback collapses away — this is the only axis on which the two views
/// differ, so both go through the same renderers (TS: `MessageItem` vs
/// `buildTranscriptLines`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// Scrollback: folded thinking, 3-line results, 20-line write diffs, last-3
    /// subagent steps.
    Inline,
    /// Ctrl+O full-screen transcript: nothing folded, nothing capped.
    Full,
}

// ─── width / truncation helpers ─────────────────────────────────────────────

/// Approximate terminal display width of `s` (CJK & wide ranges count as 2).
/// Self-contained so we don't add a `unicode-width` dependency (§0.1).
fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

fn char_width(c: char) -> usize {
    let cp = c as u32;
    // Zero-width: combining marks, ZWJ/ZWNJ, variation selectors.
    if cp == 0
        || (0x0300..=0x036F).contains(&cp)
        || (0x200B..=0x200F).contains(&cp)
        || (0xFE00..=0xFE0F).contains(&cp)
    {
        return 0;
    }
    if is_wide(cp) {
        2
    } else {
        1
    }
}

fn is_wide(cp: u32) -> bool {
    matches!(cp,
        0x1100..=0x115F        // Hangul Jamo
        | 0x2E80..=0x303E      // CJK radicals, Kangxi, punctuation
        | 0x3041..=0x33FF      // Hiragana, Katakana, CJK symbols
        | 0x3400..=0x4DBF      // CJK Ext A
        | 0x4E00..=0x9FFF      // CJK Unified
        | 0xA000..=0xA4CF      // Yi
        | 0xAC00..=0xD7A3      // Hangul syllables
        | 0xF900..=0xFAFF      // CJK compatibility
        | 0xFE30..=0xFE4F      // CJK compatibility forms
        | 0xFF00..=0xFF60      // Fullwidth forms
        | 0xFFE0..=0xFFE6      // Fullwidth signs
        | 0x1F300..=0x1FAFF    // emoji / symbols
        | 0x20000..=0x3FFFD    // CJK Ext B+
    )
}

/// Char-count truncation, matching TS `truncate()` (`tools/format.ts`):
/// `s.length <= max` keeps it; else `s[..max-1] + "…"`.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let kept: String = s.chars().take(max - 1).collect();
    format!("{kept}\u{2026}")
}

/// Clip `s` to at most `max_cols` display columns (no ellipsis), mirroring the
/// `clipped()` helper used by DiffView in `Chat.tsx`.
fn clipped(s: &str, max_cols: usize) -> String {
    if max_cols == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0usize;
    for ch in s.chars() {
        let cw = char_width(ch);
        if w + cw > max_cols {
            break;
        }
        out.push(ch);
        w += cw;
    }
    out
}

/// `ARGS_SUMMARY_MAX` / `argsMax(cols)` from `Chat.tsx`.
fn args_max(cols: usize) -> usize {
    let scaled = (cols as f64 * 0.8).floor() as usize;
    scaled.max(80)
}

/// `Math.max(20, cols - 5)` content cap used by `⎿` result/step lines.
fn result_line_max(cols: usize) -> usize {
    cols.saturating_sub(5).max(20)
}

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

// ─── shared line builders ───────────────────────────────────────────────────

/// A dim `⎿`/continuation-prefixed line (first vs. rest) whose content is also
/// dim — the muted `ToolResult`/subagent style.
fn dim_marker_line(idx: usize, content: String) -> Line<'static> {
    let prefix = if idx == 0 { MARKER } else { MARKER_CONT };
    Line::from(vec![
        Span::styled(prefix, dim()),
        Span::styled(content, dim()),
    ])
}

/// Render a `⎿` result body (§5 "Tool 结果"):
/// - strip leading whitespace-only lines and trailing newlines
/// - dim marker prefix; content dim (muted) or `theme.error` (error tone)
/// - truncate each line to `cols-5`; cap at `max_lines` (None = uncapped) with
///   a trailing dim `    … +N lines`.
fn result_lines(
    content: &str,
    cols: usize,
    error_tone: bool,
    max_lines: Option<usize>,
    detail: Detail,
) -> Vec<Line<'static>> {
    let trimmed = strip_result_edges(content);
    if trimmed.is_empty() {
        return Vec::new();
    }
    let all: Vec<&str> = trimmed.split('\n').collect();
    let max = match detail {
        Detail::Inline => result_line_max(cols),
        Detail::Full => RESULT_LINE_MAX,
    };
    let preview_n = match max_lines {
        Some(n) => n.min(all.len()),
        None => all.len(),
    };
    let more = all.len() - preview_n;

    let mut out: Vec<Line<'static>> = Vec::with_capacity(preview_n + 1);
    for (i, line) in all.iter().take(preview_n).enumerate() {
        let prefix = if i == 0 { MARKER } else { MARKER_CONT };
        let text = truncate(line, max);
        let content_span = if error_tone {
            Span::styled(text, Style::default().fg(theme::ERROR))
        } else {
            Span::styled(text, dim())
        };
        out.push(Line::from(vec![Span::styled(prefix, dim()), content_span]));
    }
    if more > 0 {
        out.push(Line::from(Span::styled(
            format!("{MARKER_CONT}\u{2026} +{more} lines"),
            dim(),
        )));
    }
    out
}

/// Strip leading blank/whitespace-only lines and trailing newlines, mirroring
/// `ToolResult`'s `content.replace(/^(?:[ \t\r]*\n)+/, "").replace(/\n+$/, "")`.
fn strip_result_edges(content: &str) -> String {
    // Trailing newlines.
    let trimmed_end = content.trim_end_matches('\n');
    // Leading whitespace-only lines.
    let mut rest = trimmed_end;
    loop {
        match rest.split_once('\n') {
            Some((first, after)) if first.chars().all(|c| c == ' ' || c == '\t' || c == '\r') => {
                rest = after;
            }
            _ => break,
        }
    }
    rest.to_string()
}

/// One blank spacer line (the block's trailing gap, §0.3).
fn blank() -> Line<'static> {
    Line::from("")
}

// ─── public API ─────────────────────────────────────────────────────────────

/// Render one committed transcript row to terminal-row `Line`s. `cols` is the
/// terminal width (used for fill bars, truncation, and markdown wrap). The row
/// owns its trailing blank line.
pub fn row_lines(row: &Row, cols: usize) -> Vec<Line<'static>> {
    row_lines_detail(row, cols, Detail::Inline)
}

/// [`row_lines`] at an explicit detail level — `Detail::Full` is what the Ctrl+O
/// overlay renders (TS `buildTranscriptLines`).
pub fn row_lines_detail(row: &Row, cols: usize, detail: Detail) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = match row {
        Row::User(s) => user_lines(s, '>', cols),
        Row::UserBash { command, output } => {
            let mut lines = user_lines(command, '!', cols);
            if let Some(out) = output {
                // User-initiated bash output: full (un-truncated) result body.
                let error_tone = out.starts_with("Error:");
                lines.extend(result_lines(out, cols, error_tone, None, detail));
            }
            lines
        }
        Row::Assistant(s) => assistant_lines(s, cols),
        Row::StreamChunk { text, bullet } => stream_chunk_lines(text, *bullet, cols),
        Row::Thinking { content, expanded } => thinking_lines(content, *expanded, detail),
        Row::Tool {
            name,
            summary,
            output,
            ok,
        } => tool_lines(name, summary, output.as_deref(), *ok, cols, detail),
        Row::Diff {
            added,
            removed,
            lines,
        } => diff_lines(*added, *removed, lines, cols),
        Row::SubagentGroup {
            header,
            steps,
            summary,
        } => subagent_lines(header, steps, summary.as_deref(), cols, detail),
        Row::Note(s) => note_lines(s),
        Row::Error(s) => error_lines(s),
        Row::Compaction(s) => return compaction_lines(s, cols),
    };
    // Every block owns exactly one trailing blank line (§0.3). Compaction returns
    // early because it carries its own.
    out.push(blank());
    out
}

/// Map an engine tool name to the display name shown in the call line (§5).
pub fn display_tool_name(name: &str) -> String {
    match name {
        "bash" => "Bash",
        "edit_file" => "Edit",
        "read_file" => "Read",
        "write_file" => "Write",
        "glob" | "grep" => "Search",
        "web_search" => "WebSearch",
        "web_fetch" => "WebFetch",
        "skill" => "Skill",
        "ask_user_question" => "AskUser",
        "agent" => "Agent",
        "task_output" => "TaskOutput",
        "task_stop" => "TaskStop",
        other => other,
    }
    .to_string()
}

// ─── per-row renderers ──────────────────────────────────────────────────────

/// User / UserBash message: each line `{prompt} {text}`, full-width `#3a3a3a`
/// bar (padded with spaces). Prompt+space default foreground (§5 User/UserBash).
fn user_lines(text: &str, prompt: char, cols: usize) -> Vec<Line<'static>> {
    let bg = Style::default().bg(theme::USER_BG);
    text.split('\n')
        .map(|line| {
            let full = format!("{prompt} {line}");
            let w = display_width(&full);
            let pad = super::bar_width(cols).saturating_sub(w);
            let padded = if pad > 0 {
                format!("{full}{}", " ".repeat(pad))
            } else {
                full
            };
            Line::from(Span::styled(padded, bg))
        })
        .collect()
}

/// Assistant message: markdown body, first line `● ` (default fg, NOT green),
/// continuation lines `  ` (§5 Assistant). Mirrors `<Markdown firstPrefix="● ">`.
fn assistant_lines(content: &str, cols: usize) -> Vec<Line<'static>> {
    let body = render_markdown(content, cols.saturating_sub(2));
    let mut out: Vec<Line<'static>> = Vec::with_capacity(body.len().max(1));
    for (i, mut line) in body.into_iter().enumerate() {
        let prefix = if i == 0 { "\u{25cf} " } else { "  " };
        let mut spans = vec![Span::raw(prefix)];
        spans.append(&mut line.spans);
        out.push(Line::from(spans));
    }
    if out.is_empty() {
        out.push(Line::from(Span::raw("\u{25cf} ")));
    }
    out
}

/// A frozen streaming-answer chunk (§5): markdown body, `● ` on the first line
/// only when `bullet` (the answer's first chunk), else `  `; continuations `  `.
/// Same as `assistant_lines` but the bullet is gated on `bullet`.
fn stream_chunk_lines(text: &str, bullet: bool, cols: usize) -> Vec<Line<'static>> {
    let body = render_markdown(text, cols.saturating_sub(2));
    let mut out: Vec<Line<'static>> = Vec::with_capacity(body.len().max(1));
    for (i, mut line) in body.into_iter().enumerate() {
        let prefix = if i == 0 && bullet { "\u{25cf} " } else { "  " };
        let mut spans = vec![Span::raw(prefix)];
        spans.append(&mut line.spans);
        out.push(Line::from(spans));
    }
    if out.is_empty() {
        out.push(Line::from(Span::raw(if bullet { "\u{25cf} " } else { "  " })));
    }
    out
}

/// Thinking row (§5 Thinking). Folded: single line `✓ thinking (ctrl+o to view)
/// (N chars)` in THINKING_FOLDED; expanded: title `✓ thinking (N chars)` in
/// THINKING + body in THINKING_BODY. (active spinner is a live-stream concern,
/// committed rows are never active.)
fn thinking_lines(content: &str, expanded: bool, detail: Detail) -> Vec<Line<'static>> {
    // The full-screen transcript is the *reason* the inline row folds, so it
    // always expands — with a bare `✓ thinking` title (no char count) over a dim
    // body, per buildTranscriptLines rather than the inline expanded styling.
    if detail == Detail::Full {
        let mut out = vec![Line::from(Span::styled(
            "\u{2713} thinking".to_string(),
            Style::default()
                .fg(theme::THINKING)
                .add_modifier(Modifier::BOLD),
        ))];
        for l in content.split('\n') {
            // Ink renders `{l || " "}` — an empty <Text> would collapse the row.
            let text = if l.is_empty() { " " } else { l };
            out.push(Line::from(Span::styled(text.to_string(), dim())));
        }
        return out;
    }

    // UTF-16 code-unit count, matching JS `content.length` (Thinking.tsx) so the
    // char count + the >1000 "x.xK" threshold agree with the TS original.
    let n = content.encode_utf16().count();
    let count = if n > 1000 {
        format!("{:.1}K chars", n as f64 / 1000.0)
    } else {
        format!("{n} chars")
    };
    let title = if expanded {
        format!("\u{2713} thinking ({count})")
    } else {
        format!("\u{2713} thinking (ctrl+o to view) ({count})")
    };
    let title_color = if expanded {
        theme::THINKING
    } else {
        theme::THINKING_FOLDED
    };
    let mut out = vec![Line::from(Span::styled(
        title,
        Style::default().fg(title_color),
    ))];
    if expanded {
        for l in content.split('\n') {
            out.push(Line::from(Span::styled(
                l.to_string(),
                Style::default().fg(theme::THINKING_BODY),
            )));
        }
    }
    out
}

/// Tool call card (§5 Tool 调用行 + 结果). `{dot}{Name bold}({args})` then `⎿`
/// result. `ok` controls dot color (done=SUCCESS, error=ERROR). Running/pending
/// blink is a live-stream concern; committed rows are done/error only.
fn tool_lines(
    name: &str,
    summary: &str,
    output: Option<&str>,
    ok: bool,
    cols: usize,
    detail: Detail,
) -> Vec<Line<'static>> {
    // ask_user_question renders its own dot + header + `· Q → A` body (Chat.tsx
    // AnswerLines): declined uses a default-fg dot + English header, answered the
    // green ok dot. Fully self-contained — it never falls through to the generic
    // tool line / result body below.
    if name == "ask_user_question" {
        return ask_lines(output, ok, cols, detail);
    }

    let dot_color = if ok { theme::SUCCESS } else { theme::ERROR };
    let dot = Span::styled("\u{25cf} ", Style::default().fg(dot_color));
    let mut out: Vec<Line<'static>> = Vec::new();

    // Memory-aware: a read/write/edit of a memory path renders as
    // Recall/Remember with the bare filename (the summary carries the path).
    let mem = deepdive_core::tools::format::memory_display(name, summary);
    let (display, summary_text) = match &mem {
        Some((d, s)) => (d.clone(), s.clone()),
        None => (display_tool_name(name), summary.to_string()),
    };
    let summary_text = truncate(&summary_text, args_max(cols));
    // No display name means no originating call was found (a resumed history
    // whose head was trimmed) — render the result alone, like TS's
    // `if (originatingCall)` guard, rather than an empty `● ()` line.
    if !display.is_empty() {
        out.push(Line::from(vec![
            dot,
            Span::styled(display, Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("("),
            Span::raw(summary_text),
            Span::raw(")"),
        ]));
    }
    // A memory write's body is a diff of the topic file — suppress it so a
    // saved memory shows only the one-line "Remember(x.md)" (light collapse).
    if mem.is_some() && (name == "write_file" || name == "edit_file") {
        return out;
    }

    // edit_file / write_file emit a ```diff block — render it as a colored diff
    // (stats + line-number gutter + add/del backgrounds), capping write_file at
    // WRITE_DIFF_MAX_LINES body lines (Chat.tsx ToolResultLines → DiffView).
    // Everything else is a plain `⎿` result: red ONLY when the body is an
    // "Error:" string (the dot already reflects `ok`); a failed-but-non-"Error:"
    // body (e.g. "Aborted by user.") stays muted, matching Chat.tsx's `tone`.
    if let Some(t) = output {
        if (name == "edit_file" || name == "write_file") && t.contains("```diff") {
            // The 20-line write cap is a space constraint of the inline view; the
            // transcript renders write_file's diff in full, like edit_file.
            let cap = match detail {
                Detail::Inline => (name == "write_file").then_some(WRITE_DIFF_MAX_LINES),
                Detail::Full => None,
            };
            out.extend(render_diff_body(t, cols, cap, detail));
        } else {
            let error_tone = t.starts_with("Error:");
            let cap = match detail {
                Detail::Inline => Some(RESULT_PREVIEW_LINES),
                Detail::Full => None,
            };
            out.extend(result_lines(t, cols, error_tone, cap, detail));
        }
    }
    out
}

/// write_file caps its rendered diff body at 20 lines (Chat.tsx
/// `WRITE_DIFF_MAX_LINES`); edit_file renders the full diff.
const WRITE_DIFF_MAX_LINES: usize = 20;

/// Render an edit/write tool result's ```diff block as a colored diff (§5 Diff /
/// Chat.tsx DiffView): a dim `⎿ Added N lines, removed M lines` stats line, then
/// each body line as `    ` + ` n ` gutter + content, background-filled to
/// `cols-5`. Add rows get SUCCESS numbers on `#1a3a1a`, del rows ERROR on
/// `#3a1a1a`, context is unstyled. The clipped content KEEPS the leading `+`/`-`
/// sign (parity with TS, which clips the raw line). `max_lines` caps the body
/// (write_file) with a trailing dim `    … +N lines`. A non-diff body falls back
/// to the plain 3-line `⎿` preview.
fn render_diff_body(
    content: &str,
    cols: usize,
    max_lines: Option<usize>,
    detail: Detail,
) -> Vec<Line<'static>> {
    let Some((diff_lines_raw, added, removed, num_width)) = parse_diff(content) else {
        // Not the expected ```diff shape — plain preview (DiffView's fallback).
        return result_lines(content, cols, false, Some(RESULT_PREVIEW_LINES), detail);
    };

    let mut out: Vec<Line<'static>> = Vec::new();

    // Stats line.
    let mut parts: Vec<String> = Vec::new();
    if added > 0 {
        parts.push(format!("Added {added} lines"));
    }
    if removed > 0 {
        parts.push(format!("removed {removed} lines"));
    }
    out.push(Line::from(vec![
        Span::styled(MARKER, dim()),
        Span::styled(parts.join(", "), dim()),
    ]));

    let target = cols.saturating_sub(5).max(1);
    let left_pad = "    ";
    let lpw = display_width(left_pad);

    let mut old_line: i64 = 0;
    let mut new_line: i64 = 0;
    let mut body: Vec<Line<'static>> = Vec::new();

    for line in &diff_lines_raw {
        if line.starts_with("@@") {
            if let Some((o, n)) = parse_hunk(line) {
                old_line = o;
                new_line = n;
            }
            continue;
        }
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        let (num, kind) = if line.starts_with('+') {
            (new_line, DiffKind::Add)
        } else if line.starts_with('-') {
            (old_line, DiffKind::Del)
        } else {
            (new_line, DiffKind::Context)
        };
        let num_str = format!("{num:>num_width$}");
        let prefix = format!(" {num_str} ");
        let max_content = target.saturating_sub(lpw + display_width(&prefix));
        let visible = clipped(line, max_content); // clip the RAW line (keeps +/-)
        let bg_width = lpw + display_width(&prefix) + display_width(&visible);
        let pad = if bg_width < target {
            " ".repeat(target - bg_width)
        } else {
            String::new()
        };
        match kind {
            DiffKind::Add => {
                let bg = Style::default().bg(theme::DIFF_ADD_BG);
                body.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::styled(prefix, Style::default().fg(theme::SUCCESS).bg(theme::DIFF_ADD_BG)),
                    Span::styled(visible, bg),
                    Span::styled(pad, bg),
                ]));
                new_line += 1;
            }
            DiffKind::Del => {
                let bg = Style::default().bg(theme::DIFF_DEL_BG);
                body.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::styled(prefix, Style::default().fg(theme::ERROR).bg(theme::DIFF_DEL_BG)),
                    Span::styled(visible, bg),
                    Span::styled(pad, bg),
                ]));
                old_line += 1;
            }
            DiffKind::Context => {
                body.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::raw(prefix),
                    Span::raw(visible),
                    Span::raw(pad),
                ]));
                old_line += 1;
                new_line += 1;
            }
        }
    }

    // Cap the body (write_file) — the stats line never counts toward the cap.
    let (shown, more) = match max_lines {
        Some(m) if body.len() > m => (&body[..m], body.len() - m),
        _ => (&body[..], 0),
    };
    out.extend(shown.iter().cloned());
    if more > 0 {
        out.push(Line::from(Span::styled(
            format!("{left_pad}\u{2026} +{more} lines"),
            dim(),
        )));
    }
    out
}

/// Parse a ```diff fenced block into `(raw lines, added, removed, num_width)`,
/// tracking old/new line numbers across `@@` hunks. Port of Chat.tsx `parseDiff`.
/// `None` when there is no ```diff fence.
fn parse_diff(content: &str) -> Option<(Vec<String>, u32, u32, usize)> {
    let fence = content.find("```diff")?;
    let diff_start = content[fence..].find('\n').map(|i| fence + i + 1)?;
    let diff_end = content.rfind("\n```");
    let diff_text = match diff_end {
        Some(e) if e >= diff_start => &content[diff_start..e],
        _ => &content[diff_start..],
    };
    let lines: Vec<String> = diff_text.split('\n').map(String::from).collect();

    let mut added = 0u32;
    let mut removed = 0u32;
    let mut max_num: i64 = 0;
    let mut old_line: i64 = 0;
    let mut new_line: i64 = 0;
    for line in &lines {
        if line.starts_with("@@") {
            if let Some((o, n)) = parse_hunk(line) {
                old_line = o;
                new_line = n;
            }
        } else if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
            max_num = max_num.max(new_line);
            new_line += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
            max_num = max_num.max(old_line);
            old_line += 1;
        } else if !line.starts_with("---") && !line.starts_with("+++") {
            max_num = max_num.max(new_line);
            old_line += 1;
            new_line += 1;
        }
    }
    let num_width = max_num.to_string().len().max(1);
    Some((lines, added, removed, num_width))
}

/// Extract `(old_start, new_start)` from a `@@ -A,B +C,D @@` hunk header — the
/// first integer after `-` and after `+`. `None` if either is missing.
fn parse_hunk(line: &str) -> Option<(i64, i64)> {
    let minus = line.find('-')?;
    let old = parse_leading_int(&line[minus + 1..])?;
    let plus_rel = line[minus..].find('+')?;
    let new = parse_leading_int(&line[minus + plus_rel + 1..])?;
    Some((old, new))
}

/// Parse the run of leading ASCII digits as an integer (JS `parseInt`-ish).
fn parse_leading_int(s: &str) -> Option<i64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Render an `ask_user_question` tool result (§5, Chat.tsx AnswerLines). The
/// engine emits `{"answers":{Q:A}}` (user answered) or `{"declined":[Q,…]}`
/// (user refused / the modal was dropped). Answered → green dot + `用户已回答：`
/// header + dim `· Q → A` list; declined → default-fg dot (declined isn't a
/// success) + English header + dim `· Q` list. Anything else → plain text.
fn ask_lines(output: Option<&str>, ok: bool, cols: usize, detail: Detail) -> Vec<Line<'static>> {
    let declined = output.and_then(parse_declined);
    let is_declined = declined.is_some();
    let dot = if is_declined {
        // Default foreground — a declined question is not the green "done" dot.
        Span::raw("\u{25cf} ")
    } else {
        Span::styled(
            "\u{25cf} ",
            Style::default().fg(if ok { theme::SUCCESS } else { theme::ERROR }),
        )
    };
    let header = if is_declined {
        "User declined to answer questions"
    } else {
        "用户已回答："
    };
    let mut out = vec![Line::from(vec![
        dot,
        Span::styled(header.to_string(), Style::default().add_modifier(Modifier::BOLD)),
    ])];

    let max = result_line_max(cols);
    if let Some(qs) = declined {
        for (i, q) in qs.iter().enumerate() {
            out.push(dim_marker_line(i, truncate(&format!("\u{b7} {q}"), max)));
        }
    } else if let Some(pairs) = output.and_then(parse_answers) {
        for (i, (q, a)) in pairs.iter().enumerate() {
            out.push(dim_marker_line(i, truncate(&format!("\u{b7} {q} \u{2192} {a}"), max)));
        }
    } else if let Some(t) = output {
        // Unexpected shape — show the raw body as an uncapped `⎿` block.
        out.extend(result_lines(t, cols, false, None, detail));
    }
    out
}

/// Parse a declined `ask_user_question` result (`{"declined":[Q,…]}`) into the
/// list of unanswered questions. `None` when the shape doesn't match.
fn parse_declined(content: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let arr = v.get("declined")?.as_array()?;
    Some(arr.iter().map(json_scalar_to_string).collect())
}

/// Parse an answered `ask_user_question` result (`{"answers":{Q:A}}`) into
/// `[(Q, A)]` pairs. `None` for the declined/malformed/empty case so the caller
/// falls back (mirrors Chat.tsx `parseAnswers` returning `[]`).
fn parse_answers(content: &str) -> Option<Vec<(String, String)>> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let obj = v.get("answers")?.as_object()?;
    let entries: Vec<(String, String)> = obj
        .iter()
        .map(|(k, val)| (k.clone(), json_scalar_to_string(val)))
        .collect();
    (!entries.is_empty()).then_some(entries)
}

/// JS `String(v)`: a JSON string yields its contents (no quotes); anything else
/// its compact JSON form (numbers/bools stringify naturally).
fn json_scalar_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// edit_file / write_file diff (§5 Diff). Stats line `⎿ Added N lines, removed
/// M lines` (dim); each line `    ` + ` n ` gutter + content, bg-filled to
/// `cols-5`; add rows SUCCESS num + `#1a3a1a` bg, del rows ERROR num + `#3a1a1a`
/// bg, context default. write_file caps at 20 body lines (the caller decides how
/// many `lines` to include; here we render what's given).
fn diff_lines(added: u32, removed: u32, lines: &[DiffLine], cols: usize) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();

    // Stats line.
    let mut parts: Vec<String> = Vec::new();
    if added > 0 {
        parts.push(format!("Added {added} lines"));
    }
    if removed > 0 {
        parts.push(format!("removed {removed} lines"));
    }
    out.push(Line::from(vec![
        Span::styled(MARKER, dim()),
        Span::styled(parts.join(", "), dim()),
    ]));

    let target = cols.saturating_sub(5).max(1);
    let left_pad = "    "; // 4
    let lpw = display_width(left_pad);
    let num_width = lines
        .iter()
        .filter_map(|l| l.num)
        .map(|n| n.to_string().len())
        .max()
        .unwrap_or(1)
        .max(1);

    for dl in lines {
        let num_str = dl.num.map(|n| n.to_string()).unwrap_or_default();
        let num = format!("{num_str:>num_width$}");
        let prefix = format!(" {num} ");
        let max_content = target.saturating_sub(lpw + display_width(&prefix));
        let visible = clipped(&dl.text, max_content);
        let bg_width = lpw + display_width(&prefix) + display_width(&visible);
        let pad = if bg_width < target {
            " ".repeat(target - bg_width)
        } else {
            String::new()
        };

        match dl.kind {
            DiffKind::Add => {
                let bg = Style::default().bg(theme::DIFF_ADD_BG);
                out.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::styled(prefix, Style::default().fg(theme::SUCCESS).bg(theme::DIFF_ADD_BG)),
                    Span::styled(visible, bg),
                    Span::styled(pad, bg),
                ]));
            }
            DiffKind::Del => {
                let bg = Style::default().bg(theme::DIFF_DEL_BG);
                out.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::styled(prefix, Style::default().fg(theme::ERROR).bg(theme::DIFF_DEL_BG)),
                    Span::styled(visible, bg),
                    Span::styled(pad, bg),
                ]));
            }
            DiffKind::Context => {
                out.push(Line::from(vec![
                    Span::raw(left_pad),
                    Span::raw(prefix),
                    Span::raw(visible),
                    Span::raw(pad),
                ]));
            }
        }
    }
    out
}

/// Subagent run (§5 SubagentGroup). `header` is a plain tool line `● Agent(...)`;
/// its steps + summary are all dim, first step `⎿` then continuation, and each
/// summary line carries its own `⎿`. Inline shows only the last 3 steps.
fn subagent_lines(
    header: &str,
    steps: &[String],
    summary: Option<&str>,
    cols: usize,
    detail: Detail,
) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();

    // Header tool line: `● {ToolName bold}({args})`. Like the parent's own tool
    // lines (Chat.tsx ToolCallLine), ONLY the tool name is bold — the `(args)`
    // part is plain. `header` is shaped `Agent(type: desc)` upstream, so split at
    // the first `(`. Dot is SUCCESS (a committed subagent group is `done`).
    let dot = Span::styled("\u{25cf} ", Style::default().fg(theme::SUCCESS));
    let bold = Style::default().add_modifier(Modifier::BOLD);
    match header.find('(') {
        Some(open) => out.push(Line::from(vec![
            dot,
            Span::styled(header[..open].to_string(), bold),
            Span::raw(header[open..].to_string()),
        ])),
        None => out.push(Line::from(vec![dot, Span::styled(header.to_string(), bold)])),
    }

    let max = result_line_max(cols);

    // Show only the last SUBAGENT_STEP_PREVIEW (3) steps inline; the transcript
    // shows the whole trail.
    const STEP_PREVIEW: usize = 3;
    let start = match detail {
        Detail::Inline => steps.len().saturating_sub(STEP_PREVIEW),
        Detail::Full => 0,
    };
    let shown = &steps[start..];
    for (i, label) in shown.iter().enumerate() {
        out.push(dim_marker_line(i, truncate(label, max)));
    }

    // Summary line(s) — each keeps its own `⎿`.
    if let Some(s) = summary {
        for line in s.split('\n') {
            out.push(dim_marker_line(0, truncate(line, max)));
        }
    }
    out
}

/// Dim note (§5 Note). Each line rendered dim. (No `⎿` unless the source text
/// already carries it.)
fn note_lines(s: &str) -> Vec<Line<'static>> {
    s.split('\n')
        .map(|l| Line::from(Span::styled(l.to_string(), dim())))
        .collect()
}

/// Client error (§5 Error). First line `● ` ERROR + continuation `  ` ERROR;
/// body text default foreground. Mirrors `buildTranscriptLines`' `msg.error`.
fn error_lines(s: &str) -> Vec<Line<'static>> {
    let split: Vec<&str> = s.split('\n').collect();
    let lines = if split.is_empty() { vec![""] } else { split };
    lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            let prefix = if i == 0 { "\u{25cf} " } else { "  " };
            let body = if line.is_empty() { " " } else { line };
            Line::from(vec![
                Span::styled(prefix, Style::default().fg(theme::ERROR)),
                Span::raw(body.to_string()),
            ])
        })
        .collect()
}

/// Compaction summary (§5 Compaction). `  ` + `─`×(cols-6) dim; `  ⎯ Context
/// compacted · summary below ⎯` dim+bold; another bar; body indented 5 spaces,
/// all dim. Strips any `<previous-conversation-summary>` wrapper. Owns its own
/// trailing blank (returned directly by `row_lines`).
fn compaction_lines(content: &str, cols: usize) -> Vec<Line<'static>> {
    let summary = strip_summary_wrapper(content);
    let bar = "\u{2500}".repeat(cols.saturating_sub(6));
    let dim_bold = Style::default().add_modifier(Modifier::DIM | Modifier::BOLD);

    let mut out: Vec<Line<'static>> = Vec::new();
    out.push(Line::from(Span::styled(format!("  {bar}"), dim())));
    out.push(Line::from(Span::styled(
        "  \u{23af} Context compacted · summary below \u{23af}".to_string(),
        dim_bold,
    )));
    out.push(Line::from(Span::styled(format!("  {bar}"), dim())));
    for l in summary.split('\n') {
        out.push(Line::from(Span::styled(format!("     {l}"), dim())));
    }
    out.push(blank());
    out
}

/// Strip the `<previous-conversation-summary>` wrapper and trim, mirroring the
/// TS regex replaces in `MessageItem`/`buildTranscriptLines`.
fn strip_summary_wrapper(content: &str) -> String {
    let mut s = content;
    if let Some(rest) = s.strip_prefix("<previous-conversation-summary>") {
        s = rest.strip_prefix('\n').unwrap_or(rest);
    }
    let mut s = s.to_string();
    if let Some(idx) = s.rfind("</previous-conversation-summary>") {
        s.truncate(idx);
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_char_count() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 3), "he\u{2026}");
        assert_eq!(truncate("héllo", 3), "h\u{e9}\u{2026}");
    }

    #[test]
    fn args_max_floor() {
        assert_eq!(args_max(50), 80); // floor(40) < 80 → 80
        assert_eq!(args_max(200), 160); // floor(160) > 80
    }

    #[test]
    fn strip_result_edges_blank_leading() {
        assert_eq!(strip_result_edges("\n  \nout\n\n"), "out");
        assert_eq!(strip_result_edges("a\n\nb\n"), "a\n\nb");
    }

    #[test]
    fn result_lines_caps_and_more() {
        let out = result_lines("l1\nl2\nl3\nl4\nl5", 80, false, Some(3), Detail::Inline);
        // 3 preview + 1 "… +2 lines"
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn full_detail_lifts_the_inline_caps() {
        // Results: 3-line preview inline, every line in the transcript.
        let body = "l1\nl2\nl3\nl4\nl5";
        let inline = result_lines(body, 80, false, Some(3), Detail::Inline);
        let full = result_lines(body, 80, false, None, Detail::Full);
        assert_eq!(inline.len(), 4); // 3 + "… +2 lines"
        assert_eq!(full.len(), 5);

        // Thinking: folded one-liner inline, title + body in the transcript.
        let folded = thinking_lines("a\nb", false, Detail::Inline);
        assert_eq!(folded.len(), 1);
        assert!(folded[0].spans[0].content.contains("ctrl+o to view"));
        let expanded = thinking_lines("a\nb", false, Detail::Full);
        assert_eq!(expanded.len(), 3);
        assert_eq!(expanded[0].spans[0].content.as_ref(), "\u{2713} thinking");
        assert!(!expanded[0].spans[0].content.contains("chars"));

        // Subagent steps: last 3 inline, all of them in the transcript.
        let steps: Vec<String> = (1..=5).map(|i| format!("step{i}")).collect();
        let inline = subagent_lines("Agent(x: y)", &steps, None, 80, Detail::Inline);
        let full = subagent_lines("Agent(x: y)", &steps, None, 80, Detail::Full);
        assert_eq!(inline.len(), 1 + 3);
        assert_eq!(full.len(), 1 + 5);
    }

    #[test]
    fn summary_wrapper_stripped() {
        let s = "<previous-conversation-summary>\nbody here\n</previous-conversation-summary>";
        assert_eq!(strip_summary_wrapper(s), "body here");
    }

    #[test]
    fn user_line_padded_to_bar_width() {
        let lines = user_lines("hi", '>', 10);
        assert_eq!(lines.len(), 1);
        // "> hi" = 4 chars, padded to bar_width(10) — the last column stays empty.
        let w: usize = lines[0].spans.iter().map(|s| display_width(&s.content)).sum();
        assert_eq!(w, 9);
    }

    #[test]
    fn wide_char_width() {
        assert_eq!(display_width("中文"), 4);
        assert_eq!(display_width("ab"), 2);
    }
}
