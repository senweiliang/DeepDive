//! deepdive-tui (Rust) — crossterm frontend for the DeepDive engine.
//!
//! Architecture (§2 of PARITY_SPEC): the TUI does NOT enter the alternate screen.
//! Committed transcript blocks are printed into the terminal's native scrollback
//! (mouse-wheel scrollback, the moral equivalent of Ink's `<Static>`); the bottom
//! live region — streaming preview + Running + modal/input + footer — is repainted
//! in place at the exact height of its content by [`region::LiveRegion`], so the
//! input box hugs the last history line with no reserved blank padding. (ratatui's
//! `Viewport::Inline` can't be cheaply resized — `resize`/recreate both issue a
//! DSR query that times out under streaming — so we drive the region ourselves.)
//!
//! An engine task owns the [`Session`] + the [`UiToCore`] receiver and runs one
//! [`run_turn_loop`] per submission; the UI task runs a `tokio::select!` over the
//! crossterm event stream + the [`AgentEvent`] stream, folding events into the
//! tested [`app::AppState`] render model, committing newly-finished rows to
//! scrollback, and repainting the live region each iteration.

mod app;
mod region;
mod render;
mod theme;
mod ui;

use anyhow::Result;
use app::{AppState, Modal, ResumePick, Row, SessionEntry, Status};
use region::LiveRegion;
use render::input::InputAction;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use deepdive_core::engine::{
    add_session_dir, compact_now, drain_background, reload_agent_listing, run_turn_loop, Session,
};
use deepdive_core::{AgentEvent, ApprovalDecision, ApprovalMode, Config, UiToCore};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::io::{BufWriter, Stdout};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Buffered stdout we paint the live region into (one flush per frame).
type Out = BufWriter<Stdout>;

type Reply = Option<oneshot::Sender<ApprovalDecision>>;
type QReply = Option<oneshot::Sender<Option<HashMap<String, String>>>>;

/// The running turn's cancel token, shared engine↔UI. The engine stores whichever
/// token drives the current turn (start_tx turns AND idle-`UserInput` turns); the
/// UI reads it for Ctrl+C / Esc. Held only for the brief store/read (no await).
type SharedCancel = Arc<Mutex<Option<CancellationToken>>>;

/// Startup resume intent, parsed from argv (mirrors `cli.tsx` `ResumeMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResumeMode {
    /// Fresh session.
    Off,
    /// Open the session picker at startup (`-r` with no id).
    Picker,
    /// Resume a specific id (or the `"last"` sentinel for `-c`).
    Id(String),
}

struct Startup {
    resume: ResumeMode,
}

/// Parse `-r/--resume [id]`, `-c/--continue`, `-h/--help` (port of `cli.tsx`
/// `parseArgs`). `-r` followed by a non-flag token resumes that id; bare `-r`
/// opens the picker; `-c` resumes the most recent session.
fn parse_args(argv: &[String]) -> (Startup, bool) {
    let mut resume = ResumeMode::Off;
    let mut help = false;
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "-r" | "--resume" => {
                // A following token is the id only when non-empty and not a flag
                // (TS `next && !next.startsWith("-")`); otherwise open the picker.
                if let Some(next) = argv.get(i + 1).filter(|n| !n.is_empty() && !n.starts_with('-')) {
                    resume = ResumeMode::Id(next.clone());
                    i += 1;
                } else {
                    resume = ResumeMode::Picker;
                }
            }
            "-c" | "--continue" => resume = ResumeMode::Id("last".to_string()),
            "-h" | "--help" => help = true,
            _ => {}
        }
        i += 1;
    }
    (Startup { resume }, help)
}

fn print_help() {
    print!(
        "{}",
        [
            "deepdive — DeepSeek terminal coding agent (TUI)",
            "",
            "Usage:",
            "  deepdive-tui               start a new session",
            "  deepdive-tui -r            pick a previous session to resume",
            "  deepdive-tui -r <id>       resume a specific session by id",
            "  deepdive-tui -c            resume the most recent session",
            "  deepdive-tui -h            show this help",
            "",
        ]
        .join("\n"),
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Ok(cwd) = std::env::current_dir() {
        deepdive_core::workspace::set_original_cwd(cwd);
    }

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (mut startup, help) = parse_args(&argv);
    if help {
        print_help();
        return Ok(());
    }

    let config = Config::load();
    if config.api_key.is_empty() {
        eprintln!("error: DEEPSEEK_API_KEY not set (env or ~/.deepdive/settings.json)");
        std::process::exit(1);
    }

    // Resolve an explicit id resume before entering raw mode, so a "not found"
    // is a clean stderr error + exit (mirrors cli.tsx resumeById).
    if let ResumeMode::Id(id) = &startup.resume {
        // Two distinct failures, like cli.tsx resumeById: nothing to resume
        // (`-c` with no history), vs. an id that resolved but failed to load.
        let real = if id == "last" {
            deepdive_core::session::latest_session_id()
        } else {
            Some(id.clone())
        };
        match real {
            None => {
                eprintln!("No previous session found.");
                std::process::exit(1);
            }
            Some(r) if deepdive_core::session::load_session(&r).is_some() => {
                startup.resume = ResumeMode::Id(r);
            }
            Some(r) => {
                eprintln!("Session {r} not found.");
                std::process::exit(1);
            }
        }
    }

    let http = deepdive_core::client::http_client();

    enable_raw_mode()?;
    install_panic_hook();
    // Buffered, so a whole frame's escape sequences land in one write (no tearing).
    let mut out: Out = BufWriter::with_capacity(64 * 1024, std::io::stdout());
    // Disable autowrap: the region renderer positions every row itself, and
    // width-filling lines (rules, padded user rows) must not wrap to a 2nd row.
    // Bracketed paste: a multi-line paste arrives as ONE Event::Paste, so its
    // embedded newlines don't submit the buffer at the first one.
    let _ = crossterm::queue!(
        out,
        crossterm::terminal::DisableLineWrap,
        crossterm::event::EnableBracketedPaste
    );
    let mut region = LiveRegion::new();
    let res = run(&mut out, &mut region, http, config, startup).await;
    let _ = region.leave(&mut out);
    let _ = crossterm::execute!(
        out,
        crossterm::event::DisableBracketedPaste,
        crossterm::terminal::EnableLineWrap
    );
    let _ = disable_raw_mode();
    res
}

async fn run(
    out: &mut Out,
    region: &mut LiveRegion,
    http: reqwest::Client,
    config: Config,
    startup: Startup,
) -> Result<()> {
    let mut app = AppState::new(config.approval_mode);
    app.model = config.model.clone();
    // Feed the footer ctx gauge (TS `<Footer contextWindow={config.contextWindow}>`).
    app.context_window = Some(config.context_window);
    // Seed the live settings mirror that `/model` & `/settings` read/write.
    app.reasoning_effort = config.reasoning_effort.clone();
    app.tavily_api_key = config.tavily_api_key.clone();
    app.response_language = config.response_language.clone();
    app.turn_summary_strategy = config.turn_summary_strategy;

    // Startup resume: an explicit id loads its transcript into the model for
    // display (the engine builds a resumed Session below); the picker opens the
    // Resume modal so the first frame lets the user choose.
    let initial_resume: Option<String> = match &startup.resume {
        ResumeMode::Id(id) => Some(id.clone()),
        ResumeMode::Off | ResumeMode::Picker => None,
    };
    if let Some(id) = &initial_resume {
        app.load_history(rows_from_session(id));
        if let Some(ls) = deepdive_core::session::load_session(id) {
            app.usage = ls.usage;
        }
    }

    let (events_tx, mut events_rx) = mpsc::channel::<AgentEvent>(256);
    let (commands_tx, commands_rx) = mpsc::channel::<UiToCore>(64);
    let (start_tx, mut start_rx) = mpsc::channel::<(String, CancellationToken)>(8);
    let (resume_tx, resume_rx) = mpsc::channel::<String>(4);
    let cur_cancel: SharedCancel = Arc::new(Mutex::new(None));

    // Engine task: owns the Session + the UiToCore receiver. `config` is owned
    // (mutable) here so `ApplySettings` can update the live model/reasoning/etc.
    let engine = {
        let http = http.clone();
        let mut config = config.clone();
        let initial_resume = initial_resume.clone();
        let cur_cancel = cur_cancel.clone();
        tokio::spawn(async move {
            let mut session = match initial_resume
                .and_then(|id| deepdive_core::session::load_session(&id).map(|ls| (id, ls)))
            {
                Some((id, ls)) => Session::resume(&config, id, ls.messages, ls.usage),
                None => Session::new(&config),
            };
            let mut commands_rx = commands_rx;
            let mut resume_rx = resume_rx;
            let mut notify = session.tasks.completion_notify();
            let bg_cancel = CancellationToken::new();
            loop {
                tokio::select! {
                    biased;
                    maybe = start_rx.recv() => {
                        let Some((input, cancel)) = maybe else { break };
                        run_turn_loop(
                            &http, &config, &mut session, input,
                            &events_tx, &mut commands_rx, &cancel,
                        )
                        .await;
                        drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    _ = notify.notified() => {
                        drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    Some(id) = resume_rx.recv() => {
                        if let Some(ls) = deepdive_core::session::load_session(&id) {
                            // Abort the old session's background tasks before
                            // swapping it out, else they run on detached.
                            session.tasks.abort_all();
                            session = Session::resume(&config, id, ls.messages, ls.usage);
                            notify = session.tasks.completion_notify();
                        }
                    }
                    cmd = commands_rx.recv() => {
                        match cmd {
                            // A submission that reached the engine while it had just
                            // gone idle (the UI still thought it was busy): start a
                            // turn here instead of dropping it (#10 race window).
                            Some(UiToCore::UserInput(input)) => {
                                let cancel = CancellationToken::new();
                                *cur_cancel.lock().unwrap() = Some(cancel.clone());
                                run_turn_loop(
                                    &http, &config, &mut session, input,
                                    &events_tx, &mut commands_rx, &cancel,
                                )
                                .await;
                                drain_background(&http, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                            }
                            Some(UiToCore::ModeChange(m)) => session.mode = m,
                            Some(UiToCore::Compact) => { let _ = compact_now(&http, &config, &mut session).await; }
                            Some(UiToCore::Clear) => {
                                session.tasks.abort_all();
                                session = Session::new(&config);
                                notify = session.tasks.completion_notify();
                            }
                            // While idle these would otherwise be dropped (the
                            // run_turn_loop drain only sees them mid-turn).
                            Some(UiToCore::AddDir(d)) => add_session_dir(&mut session, &d),
                            Some(UiToCore::Rename(t)) => {
                                deepdive_core::session::update_session_title(&session.session_id, &t)
                            }
                            Some(UiToCore::ReloadAgents) => reload_agent_listing(&mut session),
                            // Idle /btw: same detached-fork helper the busy-path
                            // drain uses, off whatever history exists right now.
                            Some(UiToCore::AskSideQuestion { question, prior_exchanges }) => {
                                deepdive_core::engine::spawn_side_question(
                                    &http, &config, &session.history, prior_exchanges, question,
                                    &events_tx,
                                )
                            }
                            // Apply settings live to the engine config (idle-only,
                            // guarded busy in the frontend so it never races a turn).
                            Some(UiToCore::ApplySettings {
                                model,
                                reasoning_effort,
                                tavily_api_key,
                                turn_summary_strategy,
                            }) => {
                                config.context_window =
                                    deepdive_core::config::model_context_window(&model);
                                config.model = model;
                                config.reasoning_effort = reasoning_effort;
                                config.tavily_api_key = tavily_api_key;
                                config.turn_summary_strategy = turn_summary_strategy;
                            }
                            _ => {}
                        }
                    }
                }
            }
            // UI is shutting down (start_tx dropped) — abort any background tasks.
            session.tasks.abort_all();
        })
    };

    // Picker startup (`-r` with no id): open the Resume modal on the first frame.
    if startup.resume == ResumeMode::Picker {
        let sessions = session_entries();
        if !sessions.is_empty() {
            app.show_resume(sessions);
        }
    }

    let mut approval_reply: Reply = None;
    let mut question_reply: QReply = None;

    // One-shot account-balance fetch for the footer (best-effort, off the hot path).
    let (balance_tx, mut balance_rx) = mpsc::channel::<Option<String>>(1);
    {
        let http = http.clone();
        let config = config.clone();
        tokio::spawn(async move {
            let b = deepdive_core::balance::fetch_balance(&http, &config)
                .await
                .map(|b| b.total_balance); // footer shows ¥{number}, no currency (TS balance.totalBalance)
            let _ = balance_tx.send(b).await;
        });
    }
    let mut balance_done = false;

    let mut reader = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(render::running::TICK_MS));
    let mut anim = ui::Anim::default();
    let mut turn_start: Option<Instant> = None;
    // Double-Ctrl-C-to-quit window.
    let mut last_ctrl_c: Option<Instant> = None;
    // Repaint the whole live region next frame (first frame + after a resize).
    let mut force_redraw = true;

    loop {
        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));

        // Newly-committed transcript rows (banner once, then each pending row) get
        // printed above the live region and scroll into native scrollback.
        let mut history: Vec<ratatui::text::Line<'static>> = Vec::new();
        if !app.banner_shown {
            history.extend(render::banner::banner_lines(
                env!("CARGO_PKG_VERSION"),
                &display_cwd(),
            ));
            app.banner_shown = true;
        }
        let pending: Vec<Row> = app.pending_rows().to_vec();
        for row in &pending {
            history.extend(render::transcript::row_lines(row, cols as usize));
        }
        app.mark_committed();

        // Drive the Running animation clock, then build + paint the live region at
        // its exact content height.
        anim.elapsed_ms = turn_start.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
        // Cap the live region to one less than the screen height: the streaming
        // preview + footer is always shown in full (history scrolls up into
        // scrollback behind it, Ink-style), only trimmed if it alone would exceed
        // the screen (a non-<Static> region taller than the terminal makes the
        // renderer thrash the scrollback).
        let max_inline = (rows as usize).saturating_sub(1).max(1);
        let (live, cursor) = ui::build(&app, cols as usize, max_inline, anim);
        region.render(out, &history, live, cursor, force_redraw)?;
        force_redraw = false;
        if app.should_quit {
            break;
        }

        tokio::select! {
            maybe_term = reader.next() => {
                match maybe_term {
                    Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
                        handle_key(
                            key, &mut app, &mut approval_reply, &mut question_reply,
                            &start_tx, &commands_tx, &resume_tx, &cur_cancel,
                            &mut last_ctrl_c, &mut turn_start, &config,
                        ).await;
                    }
                    // A resize reflows the terminal under us. Wipe the screen and
                    // replay the whole transcript (banner + every row) so the next
                    // frame repaints cleanly at the new width.
                    Some(Ok(Event::Resize(_, _))) => {
                        let _ = region.reset_for_resize(out);
                        app.committed = 0;
                        app.banner_shown = false;
                        force_redraw = true;
                    }
                    // Bracketed paste into the Settings panel: a revealed secret
                    // row takes the whole payload as its Tavily key (SettingsPanel
                    // pastes the key wholesale rather than typing it).
                    Some(Ok(Event::Paste(text))) if matches!(app.modal, Modal::Settings { .. }) => {
                        app.settings_secret_paste(&text);
                    }
                    // Bracketed paste: insert the whole payload at once (embedded
                    // newlines become literal newlines, not a premature submit).
                    // Only into the main input — a modal owns the frame otherwise.
                    Some(Ok(Event::Paste(text))) if !app.has_modal() => {
                        let commands = render::input::builtin_commands();
                        app.input.insert_paste(&text, &commands);
                    }
                    _ => {}
                }
            }
            maybe_ev = events_rx.recv() => {
                match maybe_ev {
                    Some(ev) => {
                        if matches!(ev, AgentEvent::TurnStarted { .. }) {
                            turn_start = Some(Instant::now());
                        }
                        let completing = matches!(ev, AgentEvent::TurnComplete { .. } | AgentEvent::Error(_));
                        fold_event(ev, &mut app, &mut approval_reply, &mut question_reply);
                        if completing { turn_start = None; }
                    }
                    None => app.should_quit = true,
                }
            }
            b = balance_rx.recv(), if !balance_done => {
                balance_done = true;
                if let Some(val) = b { app.set_balance(val); }
            }
            _ = tick.tick() => { anim.frame = anim.frame.wrapping_add(1); }
        }
    }

    // Shut the engine down.
    drop(start_tx);
    if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
        c.cancel();
    }
    let _ = engine.await;
    Ok(())
}

/// Rows the resume picker jumps per PgUp/PgDn (SessionPicker.tsx pages by the
/// dynamic visible count; without a height budget at key time we use a constant).
const RESUME_PAGE: usize = 10;

fn display_cwd() -> String {
    let cwd = deepdive_core::workspace::original_cwd();
    let cwd = cwd.to_string_lossy().to_string();
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

/// Fold an engine event into the render model. The reply oneshots for blocking
/// modals are stashed here (the model only renders the modal).
fn fold_event(ev: AgentEvent, app: &mut AppState, approval_reply: &mut Reply, question_reply: &mut QReply) {
    match ev {
        AgentEvent::TurnStarted { .. } => app.turn_started(),
        AgentEvent::ModelRouted { model } => app.active_model = Some(model),
        AgentEvent::ThinkingDelta(s) => app.on_thinking(s),
        AgentEvent::ContentDelta(s) => app.on_content(s),
        AgentEvent::AssistantMessage(m) => app.commit_assistant(&m.content),
        AgentEvent::ToolStarted { call_id, name, summary } => app.tool_started(&call_id, &name, &summary),
        AgentEvent::ToolFinished { call_id, result } => {
            // Show the real result body in the `⎿` block (not just the one-line
            // tag), and drive the tone from is_error so failed tools render red.
            let output = if result.content.trim().is_empty() {
                None
            } else {
                Some(result.content)
            };
            app.tool_finished(&call_id, output, !result.is_error)
        }
        AgentEvent::ApprovalRequest { req, reply } => {
            // Tool-aware summary (bash → command, file tools → path), matching
            // ConfirmBox.tsx's `summarizeArgs(toolName, args)` — not raw JSON.
            let summary = deepdive_core::tools::format::summarize_args(&req.tool_name, &req.args);
            app.show_approval(req.tool_name, summary, req.warning, req.save_patterns);
            *approval_reply = Some(reply);
        }
        AgentEvent::AskQuestion { items, reply } => {
            if items.is_empty() {
                let _ = reply.send(None);
            } else {
                app.show_question(items);
                *question_reply = Some(reply);
            }
        }
        AgentEvent::BashOutput { chunk, .. } => {
            // Show live bash output in the streaming area.
            let mut s = std::mem::take(&mut app.live_content);
            s.push_str(&chunk);
            app.on_content(s);
        }
        AgentEvent::Usage(u) => app.set_usage(u),
        AgentEvent::BackgroundCount(n) => app.set_bg_tasks(n),
        AgentEvent::SubagentStep { name, summary, result, .. } => {
            app.push_subagent_step(&name, &summary, &result)
        }
        AgentEvent::SubagentProgress { agent_type, turn, tool_calls, .. } => {
            app.subagent_progress(&agent_type, turn, tool_calls)
        }
        AgentEvent::Recall(text) => {
            app.input.set_value(text);
            app.turn_complete();
        }
        AgentEvent::MemoryRecalled { count } => {
            let unit = if count == 1 { "memory" } else { "memories" };
            // MARKER = "  ⎿ " (2 spaces + U+23BF + single space).
            app.push_note(format!("  \u{23bf} Recalled {count} {unit}"));
        }
        AgentEvent::TurnComplete { .. } => app.turn_complete(),
        AgentEvent::Error(e) => {
            app.push_error(e);
            app.turn_complete();
        }
        AgentEvent::SideQuestion { question, result } => {
            app.set_side_question_result(&question, result)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_key(
    key: KeyEvent,
    app: &mut AppState,
    approval_reply: &mut Reply,
    question_reply: &mut QReply,
    start_tx: &mpsc::Sender<(String, CancellationToken)>,
    commands_tx: &mpsc::Sender<UiToCore>,
    resume_tx: &mpsc::Sender<String>,
    cur_cancel: &SharedCancel,
    last_ctrl_c: &mut Option<Instant>,
    turn_start: &mut Option<Instant>,
    config: &Config,
) {
    // ── Ctrl+C while a modal is open (§15b) ──────────────────────────────────────
    // A blocking Approval/Question modal means a turn is parked on the user's
    // reply — Ctrl+C interrupts it (reject + cancel the turn). A transient user
    // modal (Model/Settings/Resume/AddDir) is simply dismissed, like Esc.
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('c'))
        && app.has_modal()
    {
        match &app.modal {
            Modal::Approval { .. } | Modal::Question { .. } => {
                reject_pending(approval_reply, question_reply);
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
                app.dismiss_all_modals();
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            }
            _ => app.dismiss_all_modals(),
        }
        return;
    }

    // ── Modal keys take priority (§12 mutual-exclusion). ─────────────────────────
    if let Modal::Approval {
        tool_name,
        save_patterns,
        selected,
        ..
    } = &app.modal
    {
        // The option list order must mirror render::modals::render_approval so the
        // ↑↓ highlight and the resolved decision line up (§11 ConfirmBox).
        let decisions = approval_decisions(tool_name, save_patterns);
        let n = decisions.len();
        // ↑↓ navigates the rendered selection; Enter executes the highlighted one;
        // y/a/n keep the hotkey fast-path; Esc denies (§11/§178).
        let chosen = match key.code {
            KeyCode::Up => {
                app.approval_move(-1, n);
                None
            }
            KeyCode::Down => {
                app.approval_move(1, n);
                None
            }
            KeyCode::Enter => decisions.get(*selected).cloned(),
            KeyCode::Char('y') | KeyCode::Char('Y') => Some(ApprovalDecision::Approve),
            KeyCode::Char('a') | KeyCode::Char('A') => {
                Some(ApprovalDecision::AllowAlways(save_patterns.clone()))
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(ApprovalDecision::Deny),
            _ => None,
        };
        if let Some(d) = chosen {
            if let Some(tx) = approval_reply.take() {
                let _ = tx.send(d);
            }
            app.clear_modal();
        }
        return;
    }
    if matches!(app.modal, Modal::Question { .. }) {
        // Full AskQuestion.tsx interaction: ←→ switch tabs (incl. the Submit tab),
        // ↑↓ move within a question, Space toggles a checkbox (multi-select), the
        // Other row is a live text field, Enter commits/advances/submits.
        match key.code {
            KeyCode::Esc => {
                if let Some(tx) = question_reply.take() {
                    let _ = tx.send(None);
                }
                app.clear_modal();
            }
            KeyCode::Left => app.question_left(),
            KeyCode::Right => app.question_right(),
            KeyCode::Up => app.question_up(),
            KeyCode::Down => app.question_down(),
            KeyCode::Enter => {
                if let Some(ans) = app.question_enter() {
                    if let Some(tx) = question_reply.take() {
                        let _ = tx.send(Some(ans));
                    }
                    app.clear_modal();
                }
            }
            KeyCode::Backspace => app.question_backspace(),
            // Space toggles a checkbox unless the Other field has focus (then it's
            // a literal space); any other char feeds the Other field when focused.
            KeyCode::Char(' ') if !app.question_on_other() => app.question_toggle(),
            KeyCode::Char(c) if app.question_on_other() => app.question_type(c),
            _ => {}
        }
        return;
    }
    if matches!(app.modal, Modal::Resume { .. }) {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => app.resume_move(-1),
            KeyCode::Down | KeyCode::Char('j') => app.resume_move(1),
            // Page by a fixed span (SessionPicker.tsx moves by the dynamic visible
            // count; the key handler has no height budget, so a constant page).
            KeyCode::PageUp => app.resume_move(-(RESUME_PAGE as i32)),
            KeyCode::PageDown => app.resume_move(RESUME_PAGE as i32),
            KeyCode::Char('g') => app.resume_jump(true),
            KeyCode::Char('G') => app.resume_jump(false),
            KeyCode::Enter => match app.resume_pick() {
                // "+ New session" (SessionPicker onSelect(null)): start a fresh
                // conversation, exactly like /clear (clears UI + engine session).
                Some(ResumePick::New) => {
                    app.clear_modal();
                    app.clear_conversation();
                    let _ = commands_tx.send(UiToCore::Clear).await;
                }
                Some(ResumePick::Session(id)) => {
                    // Only mutate the UI once the load is known to succeed, so the
                    // engine's session swap (resume_rx, also load-guarded) can't
                    // desync from the displayed transcript.
                    if let Some(ls) = deepdive_core::session::load_session(&id) {
                        app.clear_modal();
                        app.clear_conversation();
                        app.load_history(rows_from_session(&id));
                        app.usage = ls.usage; // seed the footer ctx gauge
                        let _ = resume_tx.send(id).await; // engine swaps its session
                    } else {
                        app.clear_modal();
                        app.push_error("无法加载该会话");
                    }
                }
                None => {}
            },
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /model picker (ModelPanel) ───────────────────────────────────────────────
    if matches!(app.modal, Modal::Model { .. }) {
        match key.code {
            KeyCode::Up => app.model_move(-1),
            KeyCode::Down => app.model_move(1),
            KeyCode::Char(c) if c.is_ascii_digit() => {
                if let Some(d) = c.to_digit(10) {
                    app.model_jump(d as usize);
                }
            }
            KeyCode::Enter => {
                if let Some(model) = app.model_commit() {
                    deepdive_core::config::save_model(&model);
                    app.push_user("/model");
                    // ApplySettings is idle-only; if a background turn started
                    // while the modal was open, persist only (don't send a command
                    // the busy drain would silently drop).
                    if app.is_busy() {
                        app.rows.push(Row::Assistant(format!(
                            "已保存模型：`{model}`（写入设置文件）。运行中暂不热切换，将于本轮结束后的新请求/下次会话生效。"
                        )));
                    } else {
                        let _ = commands_tx.send(apply_settings_cmd(app)).await;
                        app.rows.push(Row::Assistant(format!(
                            "已保存模型：`{model}`（写入 ~/.deepdive/settings.json，下一轮请求起生效）。"
                        )));
                    }
                }
            }
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /settings panel (SettingsPanel) ──────────────────────────────────────────
    if matches!(app.modal, Modal::Settings { .. }) {
        match key.code {
            KeyCode::Up => app.settings_row_move(-1),
            KeyCode::Down => app.settings_row_move(1),
            KeyCode::Left => app.settings_value_move(-1),
            KeyCode::Right => app.settings_value_move(1),
            KeyCode::Backspace | KeyCode::Delete => app.settings_secret_clear(),
            KeyCode::Enter => {
                if let Some(v) = app.settings_commit() {
                    deepdive_core::config::save_model(&v.model);
                    deepdive_core::config::save_reasoning_effort(&v.reasoning_effort);
                    deepdive_core::config::save_tavily_key(&v.tavily_api_key);
                    deepdive_core::config::save_response_language(&v.response_language);
                    deepdive_core::config::save_turn_summary_strategy(v.turn_summary);
                    app.push_user("/settings");
                    let tavily = if v.tavily_api_key.is_empty() { "未设置" } else { "已设置" };
                    let summary = format!(
                        "已保存：模型 `{}`，推理强度 `{}`，Tavily key `{}`，上一轮摘要 `{}`",
                        v.model,
                        v.reasoning_effort,
                        tavily,
                        turn_summary_label(v.turn_summary),
                    );
                    // ApplySettings is idle-only; persist-only when a background
                    // turn started while the panel was open (don't silently drop).
                    if app.is_busy() {
                        app.rows.push(Row::Assistant(format!(
                            "{summary}（写入设置文件；运行中暂不热切换，将于本轮结束后/下次会话生效）。回复语言 `{}` 已保存，**仅对新会话生效**。",
                            v.response_language,
                        )));
                    } else {
                        let _ = commands_tx.send(apply_settings_cmd(app)).await;
                        app.rows.push(Row::Assistant(format!(
                            "{summary}（写入 ~/.deepdive/settings.json，下一轮起生效）。回复语言 `{}` 已保存，**仅对新会话生效**——当前会话维持原语言。",
                            v.response_language,
                        )));
                    }
                }
            }
            // The Tavily key is paste-only (SettingsPanel.tsx has no char-typing
            // branch): regular keys are ignored while the panel is open.
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /add-dir grant-scope confirm (AddDirConfirm) ─────────────────────────────
    if matches!(app.modal, Modal::AddDir { .. }) {
        match key.code {
            KeyCode::Up => app.adddir_move(-1),
            KeyCode::Down => app.adddir_move(1),
            KeyCode::Enter => {
                if let Some((path, sel)) = app.adddir_selected() {
                    app.clear_modal();
                    app.push_user(format!("/add-dir {path}"));
                    match sel {
                        0 => {
                            let _ = commands_tx.send(UiToCore::AddDir(path.clone())).await;
                            app.rows.push(Row::Assistant(format!(
                                "已添加额外工作区目录：`{path}`\n（仅本会话有效）"
                            )));
                        }
                        1 => {
                            deepdive_core::config::save_additional_directory(&path);
                            let _ = commands_tx.send(UiToCore::AddDir(path.clone())).await;
                            app.rows.push(Row::Assistant(format!(
                                "已添加额外工作区目录：`{path}`\n（已写入 ~/.deepdive/settings.json，下次启动自动加载）"
                            )));
                        }
                        _ => {
                            app.rows.push(Row::Assistant(format!(
                                "未将 `{path}` 添加为工作区目录。"
                            )));
                        }
                    }
                }
            }
            KeyCode::Esc => app.clear_modal(),
            _ => {}
        }
        return;
    }
    // ── /btw side question (BtwPanel) ────────────────────────────────────────────
    // Dismissing only clears this modal — it never touches cur_cancel, so the
    // main turn (if any is running) is completely unaffected (§ /btw contract).
    // While the last exchange is loading there's nothing to edit yet, so only
    // Esc/Ctrl-C/Ctrl-D (dismiss) do anything; once it settles, typing/
    // backspace/Enter drive the follow-up draft (Enter sends if non-empty,
    // else dismisses — mirrors the TS TextInput wiring in BtwPanel.tsx).
    if matches!(app.modal, Modal::Btw { .. }) {
        let btw_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if key.code == KeyCode::Esc || (btw_ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d')))
        {
            app.clear_modal();
            return;
        }
        if app.btw_loading() {
            return;
        }
        match key.code {
            KeyCode::Enter => {
                let q = app.btw_take_draft();
                if q.is_empty() {
                    app.clear_modal();
                } else {
                    let prior_exchanges = app.btw_prior_exchange_messages();
                    app.btw_push_pending(q.clone());
                    let _ = commands_tx
                        .send(UiToCore::AskSideQuestion { question: q, prior_exchanges })
                        .await;
                }
            }
            KeyCode::Backspace => app.btw_draft_backspace(),
            KeyCode::Char(c)
                if !btw_ctrl && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                app.btw_draft_push(c)
            }
            _ => {}
        }
        return;
    }

    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    // ── Global keys handled by main.rs (not the editor). ─────────────────────────
    match key.code {
        KeyCode::Char('c') if ctrl => {
            if app.is_busy() {
                // Interrupt the current turn + reject pending modals.
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
                reject_pending(approval_reply, question_reply);
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            } else if last_ctrl_c.map(|t| t.elapsed() < Duration::from_secs(1)).unwrap_or(false) {
                app.should_quit = true;
            } else if !app.input.is_empty() {
                app.input.take();
                *last_ctrl_c = Some(Instant::now());
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
            } else {
                app.footer_hint = Some("Press Ctrl-C again to exit".to_string());
                *last_ctrl_c = Some(Instant::now());
            }
            return;
        }
        KeyCode::Char('d') if ctrl && app.input.is_empty() => {
            app.should_quit = true;
            return;
        }
        KeyCode::Esc => {
            app.footer_hint = None;
            if app.is_busy() {
                if let Some(c) = cur_cancel.lock().unwrap().as_ref() {
                    c.cancel();
                }
            }
            return;
        }
        KeyCode::BackTab => {
            let next = next_mode(app.mode);
            app.mode = next;
            let _ = commands_tx.send(UiToCore::ModeChange(next)).await;
            return;
        }
        _ => {}
    }

    // ── Everything else goes through the InputState editor (§7). ─────────────────
    app.footer_hint = None;
    let commands = render::input::builtin_commands();
    match app.input.handle_key(key, &commands) {
        InputAction::None => {}
        InputAction::Submit(line) => {
            if line.trim().is_empty() {
                return;
            }
            if line.trim_start().starts_with('/') {
                handle_slash(line.trim(), app, commands_tx, config).await;
                return;
            }
            if let Some(cmd) = line.strip_prefix('!') {
                // Inline bash: record as a bash user row, submit the command.
                let cmd = cmd.to_string();
                app.push_user_bash(cmd.clone());
                submit_turn(app, &cmd, start_tx, commands_tx, cur_cancel, turn_start).await;
                return;
            }
            app.push_user(line.clone());
            submit_turn(app, &line, start_tx, commands_tx, cur_cancel, turn_start).await;
        }
    }
}

/// The approval-modal options, in the SAME order they are rendered by
/// `render::modals::render_approval` (Allow once / [edit] Accept all edits /
/// [non-edit+savePattern] Allow always / Deny). Keeps ↑↓ highlight in sync with
/// the executed decision (§11).
fn approval_decisions(tool_name: &str, save_patterns: &[String]) -> Vec<ApprovalDecision> {
    let is_edit = tool_name == "write_file" || tool_name == "edit_file";
    let mut out = vec![ApprovalDecision::Approve];
    if is_edit {
        out.push(ApprovalDecision::AllowAlways(save_patterns.to_vec()));
    }
    if !is_edit && !save_patterns.is_empty() {
        out.push(ApprovalDecision::AllowAlways(save_patterns.to_vec()));
    }
    out.push(ApprovalDecision::Deny);
    out
}

/// Reject any pending approval/question modal (used on Ctrl+C interrupt).
fn reject_pending(approval_reply: &mut Reply, question_reply: &mut QReply) {
    if let Some(tx) = approval_reply.take() {
        let _ = tx.send(ApprovalDecision::Deny);
    }
    if let Some(tx) = question_reply.take() {
        let _ = tx.send(None);
    }
}

/// Submit a user turn: either start a fresh turn (idle) or queue it (busy). When
/// idle we mint the cancel token and publish it to the shared slot before sending
/// (so Ctrl+C/Esc can interrupt this turn); when busy the input is appended to
/// history by the running turn's command-drain. If the UI merely *thought* it was
/// busy (engine already idle), the engine's idle `UserInput` arm starts the turn
/// and publishes its own token — either way nothing is dropped (#10).
async fn submit_turn(
    app: &mut AppState,
    line: &str,
    start_tx: &mpsc::Sender<(String, CancellationToken)>,
    commands_tx: &mpsc::Sender<UiToCore>,
    cur_cancel: &SharedCancel,
    turn_start: &mut Option<Instant>,
) {
    if app.is_busy() {
        let _ = commands_tx.send(UiToCore::UserInput(line.to_string())).await;
    } else {
        app.status = Status::Busy;
        *turn_start = Some(Instant::now());
        let cancel = CancellationToken::new();
        *cur_cancel.lock().unwrap() = Some(cancel.clone());
        let _ = start_tx.send((line.to_string(), cancel)).await;
    }
}

/// Front-end slash commands for the TUI (mirrors the CLI/GUI set).
async fn handle_slash(
    line: &str,
    app: &mut AppState,
    commands_tx: &mpsc::Sender<UiToCore>,
    config: &Config,
) {
    let mut parts = line[1..].splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_lowercase();
    let arg = parts.next().unwrap_or("").trim();
    // Commands that reset/rebuild/swap the session or mutate the live config are
    // forbidden mid-turn (they'd clobber the streaming transcript or be dropped
    // by the busy command-drain). TS queues all slash input while streaming; we
    // reject these and let the user retry once idle.
    if app.is_busy()
        && matches!(
            name.as_str(),
            "clear" | "compact" | "model" | "settings" | "resume"
        )
    {
        app.push_error("运行中，无法执行该命令（先 Esc 中断）");
        return;
    }
    match name.as_str() {
        "clear" => {
            app.clear_conversation();
            let _ = commands_tx.send(UiToCore::Clear).await;
        }
        "compact" => {
            app.push_note("正在压缩对话…");
            let _ = commands_tx.send(UiToCore::Compact).await;
        }
        "resume" => {
            let sessions = session_entries();
            if sessions.is_empty() {
                app.push_note("没有可恢复的会话");
            } else {
                app.show_resume(sessions);
            }
        }
        "model" => {
            // TS model.ts rejects an argument: the picker is the only entry point.
            if arg.is_empty() {
                app.show_model();
            } else {
                app.push_error("输入 /model 后直接回车以选择 pro 或 flash。");
            }
        }
        "settings" => app.show_settings(),
        "rename" => {
            let title = arg.trim();
            if title.is_empty() {
                app.push_error("用法：/rename <会话标题>");
            } else {
                let _ = commands_tx.send(UiToCore::Rename(title.to_string())).await;
                app.push_user(format!("/rename {title}"));
                app.rows
                    .push(Row::Assistant(format!("已重命名会话为：「{title}」")));
            }
        }
        "add-dir" => match validate_add_dir(arg, config) {
            AddDirResult::Empty => app.push_error("用法：/add-dir <路径>"),
            AddDirResult::NotFound(p) => app.push_error(format!("路径 `{p}` 不存在。")),
            AddDirResult::NotDir(p) => app.push_error(format!("`{p}` 不是目录。")),
            AddDirResult::Already { abs, wd } => {
                app.push_user(format!("/add-dir {arg}"));
                app.rows
                    .push(Row::Assistant(format!("`{abs}` 已经在 `{wd}` 范围内。")));
            }
            AddDirResult::Ok(abs) => app.show_add_dir(abs),
        },
        "agents" => {
            deepdive_core::agents::registry::reload_agents();
            let agents = deepdive_core::agents::registry::get_registered_agents();
            let body = if agents.is_empty() {
                "No agents found.".to_string()
            } else {
                agents
                    .iter()
                    .map(|ra| {
                        let src = match ra.source {
                            deepdive_core::agents::registry::AgentSource::BuiltIn => "built-in",
                            deepdive_core::agents::registry::AgentSource::User => "user",
                            deepdive_core::agents::registry::AgentSource::Project => "project",
                        };
                        let tools = match &ra.def.tools {
                            None => "all tools".to_string(),
                            Some(t) if t.is_empty() => "no tools".to_string(),
                            Some(t) => t.join(", "),
                        };
                        let model = ra
                            .def
                            .model
                            .as_ref()
                            .map(|m| format!(" · model {m}"))
                            .unwrap_or_default();
                        format!(
                            "**{}** _({})_ — {}{}\n  {}",
                            ra.def.agent_type, src, tools, model, ra.def.when_to_use
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            let note = format!(
                "可用 subagent（共 {} 个，自定义 agent 来自 `.deepdive/agents/*.md`，项目目录与 `~` 均扫描）：\n\n{}",
                agents.len(),
                body
            );
            app.push_user("/agents");
            app.rows.push(Row::Assistant(note));
            // Rebuild the in-session listing so a freshly-edited agent becomes
            // dispatchable this session (not just visible in the output above).
            let _ = commands_tx.send(UiToCore::ReloadAgents).await;
        }
        "btw" => {
            if arg.is_empty() {
                app.push_error("用法：/btw <问题>");
            } else {
                // Runs even mid-turn: show the panel immediately and let the
                // engine answer it off a snapshot, independent of any running
                // turn (see UiToCore::AskSideQuestion).
                app.show_btw(arg.to_string());
                let _ = commands_tx
                    .send(UiToCore::AskSideQuestion {
                        question: arg.to_string(),
                        prior_exchanges: Vec::new(),
                    })
                    .await;
            }
        }
        "help" => app.push_note(
            "命令：/add-dir 加目录 · /agents 子代理 · /btw 侧问 · /clear 清空 · /compact 压缩 · /model 模型 · /rename 重命名 · /resume 恢复 · /settings 设置 · /mode <default|acceptEdits|plan|yolo|auto> · /help",
        ),
        "mode" => match parse_mode_name(arg) {
            Some(m) => {
                app.mode = m;
                let _ = commands_tx.send(UiToCore::ModeChange(m)).await;
                app.push_note(format!("审批模式 → {arg}"));
            }
            None => app.push_error("用法：/mode default|acceptEdits|plan|yolo|auto"),
        },
        other => app.push_error(format!("未知命令：/{other}")),
    }
}

/// Build the live-settings command from the app's settings mirror (sent after a
/// `/model` or `/settings` save). `response_language` is intentionally omitted —
/// it is frozen per session, persisted only (parity with App.tsx).
fn apply_settings_cmd(app: &AppState) -> UiToCore {
    UiToCore::ApplySettings {
        model: app.model.clone(),
        reasoning_effort: app.reasoning_effort.clone(),
        tavily_api_key: app.tavily_api_key.clone(),
        turn_summary_strategy: app.turn_summary_strategy,
    }
}

/// Human label for a turn-summary strategy, shown in the `/settings` save note.
fn turn_summary_label(t: deepdive_core::types::TurnSummaryStrategy) -> &'static str {
    use deepdive_core::types::TurnSummaryStrategy::*;
    match t {
        Off => "off",
        WholeTurn => "whole_turn",
        ToolOnly => "tool_only",
    }
}

/// Result of validating a `/add-dir` argument (port of `commands/adddir.ts`).
enum AddDirResult {
    Empty,
    NotFound(String),
    NotDir(String),
    Already { abs: String, wd: String },
    Ok(String),
}

/// Canonicalize for stable comparison; fall back to the raw path on error.
fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Validate a `/add-dir` path: resolve against the frozen cwd, require an
/// existing directory, and report when it is already inside a working dir.
fn validate_add_dir(arg: &str, config: &Config) -> AddDirResult {
    let raw = arg.trim();
    if raw.is_empty() {
        return AddDirResult::Empty;
    }
    let cwd = deepdive_core::workspace::original_cwd();
    let expanded = deepdive_core::workspace::expand_tilde(raw);
    let joined = {
        let p = Path::new(&expanded);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };
    match std::fs::metadata(&joined) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return AddDirResult::NotDir(joined.display().to_string()),
        Err(_) => return AddDirResult::NotFound(joined.display().to_string()),
    }
    let abs = canon(&joined);
    // Working dirs: frozen cwd + persisted additional directories.
    let mut working: Vec<PathBuf> = vec![canon(&cwd)];
    for d in &config.additional_directories {
        working.push(canon(Path::new(&deepdive_core::workspace::expand_tilde(d))));
    }
    for wd in &working {
        if &abs == wd || abs.starts_with(wd) {
            return AddDirResult::Already {
                abs: abs.display().to_string(),
                wd: wd.display().to_string(),
            };
        }
    }
    AddDirResult::Ok(abs.display().to_string())
}

/// Recent sessions for the `/resume` picker (id + a first-message title).
fn session_entries() -> Vec<SessionEntry> {
    deepdive_core::session::list_sessions()
        .into_iter()
        .take(30)
        .map(|s| {
            let title = deepdive_core::session::load_session(&s.id)
                .and_then(|ls| {
                    ls.messages.into_iter().find(|m| {
                        m.role == deepdive_core::Role::User && !m.meta && !m.content.trim().is_empty()
                    })
                })
                .map(|m| m.content.trim().chars().take(48).collect::<String>())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| s.id.chars().take(8).collect());
            SessionEntry {
                id: s.id,
                title,
                when: None,
                msgs: None,
            }
        })
        .collect()
}

/// Fold a loaded session into transcript rows for display after `/resume`.
fn rows_from_session(id: &str) -> Vec<Row> {
    use deepdive_core::session::{is_compact_summary_message, COMPACT_SUMMARY_PREFIX, COMPACT_SUMMARY_SUFFIX};
    let Some(ls) = deepdive_core::session::load_session(id) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for m in &ls.messages {
        if is_compact_summary_message(m) {
            let s = m.content.strip_prefix(COMPACT_SUMMARY_PREFIX).unwrap_or(&m.content);
            let body = s.strip_suffix(COMPACT_SUMMARY_SUFFIX).unwrap_or(s);
            rows.push(Row::Compaction(body.to_string()));
        } else if matches!(m.role, deepdive_core::Role::User | deepdive_core::Role::Assistant)
            && !m.meta
            && !m.content.trim().is_empty()
        {
            if m.role == deepdive_core::Role::User {
                rows.push(Row::User(m.content.clone()));
            } else {
                rows.push(Row::Assistant(m.content.clone()));
            }
        }
    }
    rows
}

fn next_mode(m: ApprovalMode) -> ApprovalMode {
    use ApprovalMode::*;
    // Order mirrors the TS Shift+Tab cycle: default→acceptEdits→plan→yolo→auto.
    match m {
        Default => AcceptEdits,
        AcceptEdits => Plan,
        Plan => Yolo,
        Yolo => Auto,
        Auto => Default,
    }
}

fn parse_mode_name(s: &str) -> Option<ApprovalMode> {
    use ApprovalMode::*;
    match s.trim() {
        "default" => Some(Default),
        "acceptEdits" | "accept-edits" | "acceptedits" => Some(AcceptEdits),
        "plan" => Some(Plan),
        "yolo" => Some(Yolo),
        "auto" => Some(Auto),
        _ => None,
    }
}

// ── terminal lifecycle ───────────────────────────────────────────────────────

/// Restore the terminal even on panic, so a crash doesn't leave a broken TTY.
/// (We never enter the alternate screen — §2 — so there's nothing else to undo.)
fn install_panic_hook() {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stdout(),
            crossterm::event::DisableBracketedPaste,
            crossterm::terminal::EnableLineWrap,
            crossterm::cursor::Show
        );
        hook(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: &[&str]) -> (Startup, bool) {
        parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parse_args_matches_cli_tsx() {
        assert_eq!(parse(&[]).0.resume, ResumeMode::Off);
        assert!(!parse(&[]).1);
        // bare -r / --resume → picker
        assert_eq!(parse(&["-r"]).0.resume, ResumeMode::Picker);
        assert_eq!(parse(&["--resume"]).0.resume, ResumeMode::Picker);
        // -r <id> → resume that id
        assert_eq!(parse(&["-r", "abc123"]).0.resume, ResumeMode::Id("abc123".into()));
        // -r followed by a flag → picker (the flag token is not taken as the id)
        assert_eq!(parse(&["-r", "--unknown"]).0.resume, ResumeMode::Picker);
        // -r "" (empty token) → picker, not an empty id (TS `next && ...`)
        assert_eq!(parse(&["-r", ""]).0.resume, ResumeMode::Picker);
        // -c / --continue → most recent
        assert_eq!(parse(&["-c"]).0.resume, ResumeMode::Id("last".into()));
        assert_eq!(parse(&["--continue"]).0.resume, ResumeMode::Id("last".into()));
        // -h / --help
        assert!(parse(&["-h"]).1);
        assert!(parse(&["--help"]).1);
    }

    #[test]
    fn mode_cycle_matches_ts_order() {
        use ApprovalMode::*;
        // default → acceptEdits → plan → yolo → auto → default
        assert_eq!(next_mode(Default), AcceptEdits);
        assert_eq!(next_mode(AcceptEdits), Plan);
        assert_eq!(next_mode(Plan), Yolo);
        assert_eq!(next_mode(Yolo), Auto);
        assert_eq!(next_mode(Auto), Default);
    }

    #[test]
    fn parse_mode_name_accepts_known_and_rejects_unknown() {
        assert_eq!(parse_mode_name("plan"), Some(ApprovalMode::Plan));
        assert_eq!(parse_mode_name("acceptEdits"), Some(ApprovalMode::AcceptEdits));
        assert_eq!(parse_mode_name("auto"), Some(ApprovalMode::Auto));
        assert!(parse_mode_name("nope").is_none());
        assert!(parse_mode_name("").is_none());
    }

    #[test]
    fn approval_decisions_order_matches_modal_render() {
        // Non-edit, no save patterns: just Allow once + Deny.
        assert_eq!(
            approval_decisions("bash", &[]),
            vec![ApprovalDecision::Approve, ApprovalDecision::Deny]
        );
        // Edit tool: Allow once / Allow all edits / Deny (no separate save-pattern row).
        let pats = vec!["**/*.rs".to_string()];
        assert_eq!(
            approval_decisions("edit_file", &pats),
            vec![
                ApprovalDecision::Approve,
                ApprovalDecision::AllowAlways(pats.clone()),
                ApprovalDecision::Deny,
            ]
        );
        // Non-edit with save patterns: Allow once / Allow always / Deny.
        assert_eq!(
            approval_decisions("bash", &pats),
            vec![
                ApprovalDecision::Approve,
                ApprovalDecision::AllowAlways(pats),
                ApprovalDecision::Deny,
            ]
        );
    }
}
