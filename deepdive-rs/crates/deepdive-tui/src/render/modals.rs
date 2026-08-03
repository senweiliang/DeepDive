//! Modal rendering (§11). Modals render INTO the bottom dynamic frame, full
//! width, bottom-aligned, with NO box: a full-width dim `─` rule on top, then
//! `paddingX:1`, 1-blank-line between sections; selected list rows are prefixed
//! `> ` (unselected `  `).
//!
//! Covers Approval (ConfirmBox), Question (AskQuestion), Resume (SessionPicker),
//! and placeholder Model / Settings / AddDir.
//!
//! Ported 1:1 from `ConfirmBox.tsx` / `AskQuestion.tsx` / `SessionPicker.tsx`
//! (Model/Settings/AddDir are placeholder renders this stage — see §11/§13).
#![allow(dead_code)]

use crate::app::{BtwExchange, Modal};
use crate::render::setup::mask_secret;
use crate::render::{markdown, running};
use crate::theme::{self, dim_style};
use deepdive_core::contract::Question;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

const TICK: &str = "\u{2714}"; // ✔
const BOX_OFF: &str = "\u{2610}"; // ☐
const BOX_ON: &str = "\u{25a0}"; // ■
const OTHER_PLACEHOLDER: &str = "输入文字";

/// 1-indented paddingX:1 prefix (every modal body uses `paddingX={1}` in TS).
const PAD: &str = " ";

/// Truncate by char count (matches the TS `.length`/`.slice` semantics), adding
/// a trailing `…` when clipped.
fn truncate(s: &str, max: usize) -> String {
    let len = s.chars().count();
    if len <= max {
        return s.to_string();
    }
    let take = max.saturating_sub(1);
    let mut out: String = s.chars().take(take).collect();
    out.push('\u{2026}'); // …
    out
}

/// Char count (TS `.length`), used for column alignment in the panels.
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// The frozen session cwd with `$HOME` collapsed to `~` (SessionPicker.tsx
/// `shortenCwd`). Reads the same frozen original cwd the banner uses.
fn shorten_cwd() -> String {
    let cwd = deepdive_core::workspace::original_cwd().to_string_lossy().to_string();
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().to_string();
        if cwd == home {
            return "~".to_string();
        }
        if let Some(rest) = cwd.strip_prefix(&format!("{home}/")) {
            return format!("~/{rest}");
        }
    }
    cwd
}

fn top_rule(cols: usize) -> Line<'static> {
    Line::from(Span::styled(
        "\u{2500}".repeat(super::bar_width(cols).max(1)),
        dim_style(),
    ))
}

/// Render the given modal into terminal-row `Line`s for the bottom frame.
/// `cols` is the terminal width (for the top rule + fills); `frame` drives the
/// `/btw` Running waveform while its answer is in flight (unused by every
/// other modal, which are static selection UIs). Returns an empty Vec for
/// [`Modal::None`].
pub fn render_modal(modal: &Modal, cols: usize, frame: u64, max_rows: usize) -> Vec<Line<'static>> {
    match modal {
        Modal::None => Vec::new(),
        Modal::Approval {
            tool_name,
            args_summary,
            warning,
            save_patterns,
            selected,
        } => render_approval(tool_name, args_summary, warning, save_patterns, *selected, cols),
        Modal::Question {
            items,
            idx,
            selected,
            answers,
            checked,
            other_text,
        } => render_question(items, *idx, *selected, answers, checked, other_text, cols),
        Modal::Resume { sessions, selected } => render_resume(sessions, *selected, cols, max_rows),
        Modal::Model { entries, selected } => render_model(entries, *selected, cols),
        Modal::Settings {
            rows,
            row,
            tavily_key,
        } => render_settings(rows, *row, tavily_key, cols),
        Modal::AddDir { path, selected } => render_adddir(path, *selected, cols),
        Modal::Btw { exchanges, draft } => render_btw(exchanges, draft, frame, cols),
    }
}

// ── Approval (ConfirmBox.tsx) ─────────────────────────────────────────────────

fn render_approval(
    tool_name: &str,
    args_summary: &str,
    warning: &Option<String>,
    save_patterns: &[String],
    selected: usize,
    cols: usize,
) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    let is_edit = tool_name == "write_file" || tool_name == "edit_file";

    // Section: title (+ optional warning). gap=1 → blank line between sections.
    out.push(Line::from(Span::styled(
        format!("{PAD}Approve tool execution?"),
        Style::default()
            .fg(theme::APPROVAL)
            .add_modifier(Modifier::BOLD),
    )));
    if let Some(w) = warning {
        out.push(Line::from(Span::styled(
            format!("{PAD}\u{26a0} {w}"),
            Style::default()
                .fg(theme::ERROR)
                .add_modifier(Modifier::BOLD),
        )));
    }
    out.push(Line::from(""));

    // Section: tool summary — bold display name + ` ` + summary.
    let display = crate::render::transcript::display_tool_name(tool_name);
    out.push(Line::from(vec![
        Span::raw(PAD),
        Span::styled(display, Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(format!(" {args_summary}")),
    ]));
    out.push(Line::from(""));

    // Section: options. Order mirrors ConfirmBox: Allow once / (edit) Accept all
    // / (non-edit + savePattern) Allow always / Deny.
    let mut labels: Vec<String> = vec!["Allow once".to_string()];
    if is_edit {
        labels.push("Allow all edits this session (shift+tab)".to_string());
    }
    if !is_edit && !save_patterns.is_empty() {
        labels.push(format!("Allow always ({})", save_patterns.join(", ")));
    }
    labels.push("Deny".to_string());

    for (i, label) in labels.iter().enumerate() {
        let active = i == selected;
        let caret = if active { "> " } else { "  " };
        let mut style = Style::default();
        if active {
            style = style.fg(theme::ACTION);
        }
        out.push(Line::from(Span::styled(
            format!("{PAD}{caret}{}. {label}", i + 1),
            style,
        )));
    }
    out
}

// ── Question (AskQuestion.tsx) ────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn render_question(
    items: &[Question],
    q_index: usize,
    selected: usize,
    answers: &std::collections::HashMap<String, String>,
    checked: &std::collections::HashSet<usize>,
    other_text: &str,
    cols: usize,
) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    if items.is_empty() {
        return out;
    }
    let multi = items.len() > 1;
    let submit_index = items.len();
    let on_submit_tab = q_index >= submit_index;

    // NavBar (multi only): ← + per-question tabs + Submit tab + →.
    if multi {
        out.push(nav_bar(items, q_index, answers, submit_index));
        out.push(Line::from(""));
    }

    if on_submit_tab {
        // Submit review view.
        let max = cols.saturating_sub(6).max(20);
        let missing = items
            .iter()
            .filter(|q| !answers.contains_key(&q.question))
            .count();
        if missing > 0 {
            out.push(Line::from(Span::styled(
                format!("{PAD}还没回答所有问题"),
                Style::default().fg(theme::APPROVAL),
            )));
        } else {
            out.push(Line::from(Span::styled(
                format!("{PAD}所有问题已回答，按 Enter 提交："),
                Style::default().add_modifier(Modifier::BOLD),
            )));
        }
        for q in items {
            let line = truncate(&format!("\u{b7} {}", q.question), max);
            out.push(Line::from(Span::styled(
                format!("{PAD}{line}"),
                dim_style(),
            )));
            let a = answers
                .get(&q.question)
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("（未回答）");
            let a = truncate(a, max.saturating_sub(6).max(10));
            out.push(Line::from(Span::styled(
                format!("{PAD}    \u{2192} {a}"),
                dim_style(),
            )));
        }
    } else {
        let q = &items[q_index];
        let other_row = q.options.len();
        let on_other = selected == other_row;

        // Question text (bold).
        out.push(Line::from(Span::styled(
            format!("{PAD}{}", q.question),
            Style::default().add_modifier(Modifier::BOLD),
        )));
        out.push(Line::from(""));

        // Single-select: the recorded answer marks the ticked option. Multi-select
        // uses the live `checked` set (AskQuestion.tsx).
        let recorded = answers.get(&q.question).map(String::as_str);

        for (i, opt) in q.options.iter().enumerate() {
            let active = i == selected;
            let head = format!("{}{}. ", if active { "> " } else { "  " }, i + 1);
            let ticked = if q.multi_select {
                checked.contains(&i)
            } else {
                recorded == Some(opt.label.as_str())
            };
            let label_style = if ticked {
                Style::default().fg(theme::SUCCESS)
            } else if active {
                Style::default().fg(theme::ACCENT)
            } else {
                Style::default()
            };
            let mut spans = vec![
                Span::styled(format!("{PAD}{head}"), dim_style()),
                Span::styled(opt.label.clone(), label_style),
            ];
            if ticked {
                spans.push(Span::styled(
                    format!(" {TICK}"),
                    Style::default().fg(theme::SUCCESS),
                ));
            }
            out.push(Line::from(spans));

            // Dim description sub-line, indented to the label column and
            // truncated to the remaining width (AskQuestion.tsx `opt.description`).
            if !opt.description.is_empty() {
                let indent = " ".repeat(char_len(&head));
                let avail = cols.saturating_sub(char_len(&head)).saturating_sub(2).max(10);
                out.push(Line::from(Span::styled(
                    format!("{PAD}{indent}{}", truncate(&opt.description, avail)),
                    dim_style(),
                )));
            }
        }

        // Auto-appended "Other" free-form row — an inline text field fed by the
        // live `other_text` buffer (AskQuestion.tsx); soft cursor when focused.
        let head = format!("{}{}. ", if on_other { "> " } else { "  " }, other_row + 1);
        let mut spans = vec![Span::styled(format!("{PAD}{head}"), dim_style())];
        let ticked = !on_other && !other_text.trim().is_empty();
        if !other_text.is_empty() {
            let style = if ticked {
                Style::default().fg(theme::SUCCESS)
            } else {
                Style::default()
            };
            spans.push(Span::styled(other_text.to_string(), style));
            if on_other {
                spans.push(cursor_span(" "));
            }
            if ticked {
                spans.push(Span::styled(
                    format!(" {TICK}"),
                    Style::default().fg(theme::SUCCESS),
                ));
            }
        } else if on_other {
            let mut ch = OTHER_PLACEHOLDER.chars();
            let first: String = ch.by_ref().take(1).collect();
            let rest: String = ch.collect();
            spans.push(cursor_span(&first));
            spans.push(Span::styled(rest, dim_style()));
        } else {
            spans.push(Span::styled(OTHER_PLACEHOLDER.to_string(), dim_style()));
        }
        out.push(Line::from(spans));
    }

    // Bottom dim hint (mirrors the AskQuestion hint matrix).
    out.push(Line::from(""));
    let nav = if multi { " · ←→ 切换问题" } else { "" };
    let on_other = !on_submit_tab && selected == items[q_index].options.len();
    let hint = if on_submit_tab {
        format!("Enter 提交{nav} · Esc 中断")
    } else if on_other {
        format!("输入文字 · Enter 确认{nav} · Esc 中断")
    } else if items[q_index].multi_select {
        format!("↑↓ 移动 · Space 勾选 · Enter 确认{nav} · Esc 中断")
    } else {
        format!("↑↓ 选择 · Enter 确认{nav} · Esc 中断")
    };
    out.push(Line::from(Span::styled(
        format!("{PAD}{hint}"),
        dim_style(),
    )));
    out
}

fn nav_bar(
    items: &[Question],
    q_index: usize,
    answers: &std::collections::HashMap<String, String>,
    submit_index: usize,
) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    // `← ` (dim on the first tab — nowhere left to go).
    spans.push(maybe_dim("\u{2190} ".to_string(), q_index == 0));

    for (i, qq) in items.iter().enumerate() {
        let selected = i == q_index;
        let answered = answers.contains_key(&qq.question);
        let bx = if answered { BOX_ON } else { BOX_OFF };
        let label = if qq.header.is_empty() {
            format!("Q{}", i + 1)
        } else {
            qq.header.clone()
        };
        let text = format!(" {bx} {label} ");
        if selected {
            spans.push(Span::styled(
                text,
                Style::default()
                    .bg(theme::ACCENT)
                    .fg(Color::Black),
            ));
        } else {
            spans.push(Span::raw(text));
        }
    }

    // Submit tab.
    let submit = format!(" {TICK} Submit ");
    if q_index == submit_index {
        spans.push(Span::styled(
            submit,
            Style::default()
                .bg(theme::ACCENT)
                .fg(Color::Black),
        ));
    } else {
        spans.push(Span::raw(submit));
    }
    // ` →` (dim when on the Submit tab).
    spans.push(maybe_dim(" \u{2192}".to_string(), q_index == submit_index));

    // Add the paddingX:1 lead.
    let mut padded = vec![Span::raw(PAD)];
    padded.extend(spans);
    Line::from(padded)
}

fn maybe_dim(text: String, dim: bool) -> Span<'static> {
    if dim {
        Span::styled(text, dim_style())
    } else {
        Span::raw(text)
    }
}

/// A soft cursor cell (white bg, black fg) over a single character.
fn cursor_span(s: &str) -> Span<'static> {
    Span::styled(
        s.to_string(),
        Style::default()
            .bg(theme::CURSOR_BG)
            .fg(theme::CURSOR_FG),
    )
}

// ── Resume (SessionPicker.tsx) ────────────────────────────────────────────────

fn render_resume(
    sessions: &[crate::app::SessionEntry],
    selected: usize,
    cols: usize,
    max_rows: usize,
) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];

    // Title row: `Resume session` (accent bold) + the frozen cwd (dim,
    // home-collapsed) two columns to its right (SessionPicker.tsx `<Box gap={2}>`).
    out.push(Line::from(vec![
        Span::styled(
            format!("{PAD}Resume session"),
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {}", shorten_cwd()), dim_style()),
    ]));

    // Hint row (dim). Index reported relative to the session list (Submit-style).
    let position = if selected == 0 {
        "new".to_string()
    } else {
        format!("{}/{}", selected, sessions.len())
    };
    let scroll_hint = if sessions.is_empty() {
        String::new()
    } else {
        format!("  [{position}]")
    };
    out.push(Line::from(Span::styled(
        format!(
            "{PAD}\u{2191}\u{2193} to navigate · PgUp/PgDn to page · g/G to jump top/bottom · Enter to open · Esc to quit{scroll_hint}"
        ),
        dim_style(),
    )));
    out.push(Line::from(""));

    // Scroll window: entries are `0..=sessions.len()` (row 0 = `+ New session`).
    // The visible count is derived from the height budget, then the offset is
    // derived statelessly so `selected` always stays in view (SessionPicker.tsx
    // CHROME_ROWS/ROWS_PER_ENTRY/MIN..MAX_VISIBLE; our extra top rule → CHROME 5).
    const CHROME: usize = 5;
    const ROWS_PER_ENTRY: usize = 3;
    const MIN_VISIBLE: usize = 3;
    const MAX_VISIBLE: usize = 12;
    let total = sessions.len() + 1;
    let visible = (max_rows.saturating_sub(CHROME) / ROWS_PER_ENTRY)
        .clamp(MIN_VISIBLE, MAX_VISIBLE);
    let max_offset = total.saturating_sub(visible);
    let offset = if selected >= visible { selected - visible + 1 } else { 0 }.min(max_offset);
    let end = (offset + visible).min(total);

    // Per-session: two lines (truncated title + dim `  when · N msgs`); the
    // New-session row is a single bold line. Each entry owns a trailing blank.
    let avail = cols.saturating_sub(4).max(10); // paddingX:1 + marker(2)
    for idx in offset..end {
        let active = idx == selected;
        let marker = if active { "> " } else { "  " };
        if idx == 0 {
            // Row 0: `+ New session` (bold; accent when selected).
            let mut style = Style::default().add_modifier(Modifier::BOLD);
            if active {
                style = style.fg(theme::ACCENT);
            }
            out.push(Line::from(Span::styled(
                format!("{PAD}{marker}+ New session"),
                style,
            )));
            out.push(Line::from("")); // marginBottom={1} after the New-session card.
            continue;
        }
        let s = &sessions[idx - 1];
        let title_style = if active {
            Style::default().fg(theme::ACCENT)
        } else {
            Style::default()
        };
        out.push(Line::from(Span::styled(
            format!("{PAD}{marker}{}", truncate(&s.title, avail)),
            title_style,
        )));
        let when = s.when.clone().unwrap_or_default();
        let msgs = s.msgs.unwrap_or(0);
        out.push(Line::from(Span::styled(
            format!("{PAD}  {when} · {msgs} msgs"),
            dim_style(),
        )));
        out.push(Line::from("")); // marginBottom={1} separating session cards.
    }
    if sessions.is_empty() {
        out.push(Line::from(Span::styled(
            format!("{PAD}  (no previous sessions)"),
            dim_style(),
        )));
    }
    out
}

// ── Model / Settings / AddDir (§11/§13) ───────────────────────────────────────

/// `/model` picker (ModelPanel.tsx): `{n}. {label}{✓ if current}` + dim
/// description, aligned to a fixed label column. Highlighted row in accent.
fn render_model(entries: &[crate::app::ModelEntry], selected: usize, cols: usize) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    out.push(Line::from(Span::styled(
        format!("{PAD}Model"),
        Style::default()
            .fg(theme::ACCENT)
            .add_modifier(Modifier::BOLD),
    )));
    out.push(Line::from(""));

    // labelWidth = max over rows of `{i+1}. {label} ✓`.length (TS char count).
    let label_width = entries
        .iter()
        .enumerate()
        .map(|(i, e)| char_len(&format!("{}. {} \u{2713}", i + 1, e.label)))
        .max()
        .unwrap_or(0);

    for (i, e) in entries.iter().enumerate() {
        let active = i == selected;
        let label = format!("{}. {}{}", i + 1, e.label, if e.selected { " \u{2713}" } else { "" });
        let pad = " ".repeat(label_width.saturating_sub(char_len(&label)) + 3);
        let head_style = if active {
            Style::default().fg(theme::ACCENT)
        } else {
            dim_style()
        };
        let label_style = if active {
            Style::default().fg(theme::ACCENT)
        } else {
            Style::default()
        };
        out.push(Line::from(vec![
            Span::styled(format!("{PAD}{}", if active { "> " } else { "  " }), head_style),
            Span::styled(label, label_style),
            Span::styled(format!("{pad}{}", e.desc), dim_style()),
        ]));
    }
    out.push(Line::from(""));
    out.push(Line::from(Span::styled(
        format!("{PAD}\u{2191}/\u{2193} 或数字选择 · Enter 保存 · Esc 取消"),
        dim_style(),
    )));
    out
}

const SETTINGS_LABEL_COL: usize = 44; // SettingsPanel LABEL_COL
const TAVILY_SECRET_LABEL: &str = "Tavily API key";
const TAVILY_HELP_URL: &str = "https://app.tavily.com/home";

/// `/settings` panel (SettingsPanel.tsx): one enum row per line with a fixed
/// label/value column, dim description, and the Tavily-key secret sub-line under
/// the search row when `tavily` is selected.
fn render_settings(
    rows: &[crate::app::SettingsRow],
    cur_row: usize,
    tavily_key: &str,
    cols: usize,
) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    out.push(Line::from(Span::styled(
        format!("{PAD}Settings"),
        Style::default()
            .fg(theme::ACCENT)
            .add_modifier(Modifier::BOLD),
    )));
    out.push(Line::from(""));

    // Fixed value column so descriptions align across rows.
    let value_col = rows
        .iter()
        .flat_map(|r| r.options.iter().map(|o| char_len(&o.label)))
        .max()
        .unwrap_or(0);

    let mut secret_active = false;
    for (i, r) in rows.iter().enumerate() {
        let active = i == cur_row;
        let opt = r.options.get(r.sel);
        let opt_label = opt.map(|o| o.label.clone()).unwrap_or_default();
        let opt_desc = opt.map(|o| o.desc.clone()).unwrap_or_default();
        let opt_value = opt.map(|o| o.value.clone()).unwrap_or_default();

        let marker = if active { "> " } else { "  " };
        let label_pad = " ".repeat(SETTINGS_LABEL_COL.saturating_sub(char_len(&r.label)).max(2));
        let label_style = if active {
            Style::default().fg(theme::ACCENT)
        } else {
            Style::default()
        };
        let value_pad = " ".repeat(value_col.saturating_sub(char_len(&opt_label)));
        out.push(Line::from(vec![
            Span::styled(format!("{PAD}{marker}{}", r.label), label_style),
            Span::raw(label_pad),
            Span::styled(opt_label, label_style),
            Span::styled(format!("{value_pad}   {opt_desc}"), dim_style()),
        ]));

        // Tavily-key secret sub-line under its row (only when revealed).
        if r.secret_when.as_deref() == Some(opt_value.as_str()) {
            if active {
                secret_active = true;
            }
            let mut spans = vec![Span::styled(
                format!("{PAD}    {TAVILY_SECRET_LABEL}  "),
                dim_style(),
            )];
            if tavily_key.trim().is_empty() {
                spans.push(Span::styled(
                    format!("未设置 · 输入 key · 获取 {TAVILY_HELP_URL}"),
                    dim_style(),
                ));
            } else {
                spans.push(Span::raw(mask_secret(tavily_key)));
            }
            out.push(Line::from(spans));
        }
    }

    out.push(Line::from(""));
    let hint = if secret_active {
        "\u{2191}/\u{2193} 选项 · \u{2190}/\u{2192} 改值 · Ctrl+V 粘贴 key · \u{232b} 清除 · Enter 保存 · Esc 取消"
    } else {
        "\u{2191}/\u{2193} 选项 · \u{2190}/\u{2192} 改值 · Enter 保存 · Esc 取消"
    };
    out.push(Line::from(Span::styled(format!("{PAD}{hint}"), dim_style())));
    out
}

// ── /btw side question thread (BtwPanel.tsx) ─────────────────────────────────

fn render_btw(exchanges: &[BtwExchange], draft: &str, frame: u64, cols: usize) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    let loading = exchanges
        .last()
        .map(|e| e.response.is_none() && e.error.is_none())
        .unwrap_or(false);

    for (i, ex) in exchanges.iter().enumerate() {
        if i == 0 {
            out.push(Line::from(vec![
                Span::styled(
                    "/btw ",
                    Style::default().fg(theme::APPROVAL).add_modifier(Modifier::BOLD),
                ),
                Span::styled(ex.question.clone(), dim_style()),
            ]));
        } else {
            out.push(Line::from(vec![
                Span::styled("> ", dim_style()),
                Span::styled(ex.question.clone(), dim_style()),
            ]));
        }
        out.push(Line::from(""));
        // Answer block, indented 2 columns (BtwPanel.tsx `marginLeft={2}`).
        const ANSWER_INDENT: &str = "  ";
        if let Some(err) = &ex.error {
            out.push(Line::from(Span::styled(
                format!("{ANSWER_INDENT}{err}"),
                Style::default().fg(theme::ERROR),
            )));
        } else if let Some(resp) = &ex.response {
            for line in markdown::render_markdown(resp, cols.saturating_sub(2)) {
                let mut spans = vec![Span::raw(ANSWER_INDENT.to_string())];
                spans.extend(line.spans);
                out.push(Line::from(spans));
            }
        } else {
            // Blinking `● ` + approval-colored "Answering..." (BtwPanel.tsx),
            // sharing the tool-dot blink cadence (DOT_BLINK_MS) — NOT the running
            // waveform, so a /btw aside reads differently from a main-turn run.
            let blink_ticks = (running::DOT_BLINK_MS / running::TICK_MS).max(1);
            let dot = if (frame / blink_ticks) % 2 == 0 {
                "\u{25cf} "
            } else {
                "  "
            };
            out.push(Line::from(vec![
                Span::raw(format!("{ANSWER_INDENT}{dot}")),
                Span::styled("Answering...", Style::default().fg(theme::APPROVAL)),
            ]));
        }
        out.push(Line::from(""));
    }

    if !loading {
        let mut spans = vec![Span::styled("> ", dim_style())];
        if draft.is_empty() {
            let placeholder = "追问，或 Esc 关闭";
            let mut chars = placeholder.chars();
            if let Some(first) = chars.next() {
                spans.push(Span::styled(
                    first.to_string(),
                    Style::default().add_modifier(Modifier::REVERSED),
                ));
                spans.push(Span::styled(
                    chars.as_str().to_string(),
                    Style::default().add_modifier(Modifier::DIM),
                ));
            }
        } else {
            spans.push(Span::raw(draft.to_string()));
            spans.push(Span::styled(
                " ",
                Style::default().add_modifier(Modifier::REVERSED),
            ));
        }
        out.push(Line::from(spans));
        out.push(Line::from(Span::styled("Enter 发送 · Esc 关闭", dim_style())));
    }
    out
}

fn render_adddir(path: &str, selected: usize, cols: usize) -> Vec<Line<'static>> {
    let mut out = vec![top_rule(cols)];
    out.push(Line::from(Span::styled(
        format!("{PAD}Add workspace directory?"),
        Style::default().fg(theme::APPROVAL),
    )));
    out.push(Line::from(Span::raw(format!("{PAD}{path}"))));
    out.push(Line::from(""));
    for (i, label) in ["当前会话", "当前工作区所有会话", "拒绝"].iter().enumerate() {
        let active = i == selected;
        let caret = if active { "> " } else { "  " };
        let mut style = Style::default();
        if active {
            style = style.fg(theme::ACTION);
        }
        out.push(Line::from(Span::styled(
            format!("{PAD}{caret}{}. {label}", i + 1),
            style,
        )));
    }
    out
}
