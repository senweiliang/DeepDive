//! Interactive REPL frontend driving `engine::run_turn_loop`.
//!
//! A thin, ratatui-free terminal frontend that proves the interactive engine
//! contract end to end: it spawns the engine task (which owns the `Session` and
//! the `UiToCore` receiver) and runs a `tokio::select!` loop over stdin lines and
//! the `AgentEvent` stream — streaming content live, prompting for approvals /
//! questions inline, queueing input typed mid-turn, and aborting on Ctrl-C. The
//! richer ratatui TUI (P3) reuses this exact event/command plumbing.

use anyhow::Result;
use deepdive_core::contract::Question;
use deepdive_core::engine::{compact_now, drain_background, run_turn_loop, Session};
use deepdive_core::{AgentEvent, ApprovalDecision, ApprovalMode, Config, UiToCore};
use std::collections::HashMap;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// What the next stdin line answers, when the engine is blocked on the user.
enum Pending {
    None,
    Approval {
        reply: oneshot::Sender<ApprovalDecision>,
        patterns: Vec<String>,
    },
    Question {
        reply: oneshot::Sender<Option<HashMap<String, String>>>,
        items: Vec<Question>,
        idx: usize,
        answers: HashMap<String, String>,
    },
}

/// Tracks live streaming so content/thinking deltas (which carry the FULL
/// accumulated string) print as suffixes, like a real stream.
#[derive(Default)]
struct Stream {
    thinking_len: usize,
    content_len: usize,
    thinking_active: bool,
    content_active: bool,
}

impl Stream {
    fn reset(&mut self) {
        *self = Stream::default();
    }
}

pub async fn run_interactive(client: reqwest::Client, config: Config, session: Session) -> Result<()> {
    let (events_tx, mut events_rx) = mpsc::channel::<AgentEvent>(256);
    let (commands_tx, commands_rx) = mpsc::channel::<UiToCore>(64);
    let (start_tx, mut start_rx) = mpsc::channel::<(String, CancellationToken)>(8);

    // Engine task: owns the Session + the UiToCore receiver, runs one
    // `run_turn_loop` per submission.
    let engine = {
        let client = client.clone();
        let config = config.clone();
        tokio::spawn(async move {
            let mut session = session;
            let mut commands_rx = commands_rx;
            let mut notify = session.tasks.completion_notify();
            let bg_cancel = CancellationToken::new();
            loop {
                tokio::select! {
                    biased;
                    maybe = start_rx.recv() => {
                        let Some((input, cancel)) = maybe else { break };
                        run_turn_loop(
                            &client, &config, &mut session, input,
                            &events_tx, &mut commands_rx, &cancel,
                        )
                        .await;
                        // A background task may have finished during the turn.
                        drain_background(&client, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    // A background task finished while idle → auto-resume.
                    _ = notify.notified() => {
                        drain_background(&client, &config, &mut session, &events_tx, &mut commands_rx, &bg_cancel).await;
                    }
                    // Commands issued while idle (mode change / compact / clear).
                    cmd = commands_rx.recv() => {
                        match cmd {
                            Some(UiToCore::ModeChange(m)) => session.mode = m,
                            Some(UiToCore::Compact) => { let _ = compact_now(&client, &config, &mut session).await; }
                            Some(UiToCore::Clear) => {
                                session = Session::new(&config);
                                notify = session.tasks.completion_notify();
                            }
                            _ => {}
                        }
                    }
                }
            }
            session.tasks.abort_all(); // best-effort cleanup on REPL exit
        })
    };

    banner(&config);
    print_prompt();

    let mut busy = false;
    let mut pending = Pending::None;
    let mut cur_cancel: Option<CancellationToken> = None;
    let mut stream = Stream::default();
    let mut stdin_closed = false;

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    loop {
        tokio::select! {
            // Stop polling stdin once it's closed (avoids a busy-loop on EOF).
            line = lines.next_line(), if !stdin_closed => {
                match line {
                    Ok(Some(l)) => {
                        if handle_line(l, &mut pending, &mut busy, &mut cur_cancel, &start_tx, &commands_tx, &client, &config).await {
                            break; // /exit
                        }
                    }
                    Ok(None) | Err(_) => {
                        // EOF / read error: stop reading. If a turn is in flight,
                        // drain it to completion; if blocked on a prompt, drop the
                        // reply so the engine unblocks (→ deny / declined).
                        stdin_closed = true;
                        pending = Pending::None;
                        if !busy {
                            break;
                        }
                    }
                }
            }
            ev = events_rx.recv() => {
                let Some(ev) = ev else { break };
                handle_event(ev, &mut busy, &mut pending, &mut stream);
                if !busy && matches!(pending, Pending::None) {
                    if stdin_closed {
                        break;
                    }
                    print_prompt();
                }
            }
            _ = tokio::signal::ctrl_c() => {
                if busy {
                    if let Some(c) = &cur_cancel { c.cancel(); }
                    eprintln!("\n\x1b[2m[interrupting…]\x1b[0m");
                } else {
                    break;
                }
            }
        }
    }

    // Shut the engine down cleanly.
    drop(start_tx);
    if let Some(c) = &cur_cancel {
        c.cancel();
    }
    let _ = engine.await;
    println!();
    Ok(())
}

/// Handle one stdin line. Returns true to quit.
#[allow(clippy::too_many_arguments)]
async fn handle_line(
    line: String,
    pending: &mut Pending,
    busy: &mut bool,
    cur_cancel: &mut Option<CancellationToken>,
    start_tx: &mpsc::Sender<(String, CancellationToken)>,
    commands_tx: &mpsc::Sender<UiToCore>,
    client: &reqwest::Client,
    config: &Config,
) -> bool {
    // A pending approval/question consumes the line as its answer.
    match std::mem::replace(pending, Pending::None) {
        Pending::Approval { reply, patterns } => {
            let decision = parse_approval(&line, &patterns);
            let _ = reply.send(decision);
            return false;
        }
        Pending::Question {
            reply,
            items,
            mut idx,
            mut answers,
        } => {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                let _ = reply.send(None); // decline
                return false;
            }
            let q = &items[idx];
            let ans = resolve_answer(q, trimmed);
            answers.insert(q.question.clone(), ans);
            idx += 1;
            if idx >= items.len() {
                let _ = reply.send(Some(answers));
            } else {
                print_question(&items[idx]);
                *pending = Pending::Question { reply, items, idx, answers };
            }
            return false;
        }
        Pending::None => {}
    }

    let trimmed = line.trim();
    if trimmed.is_empty() {
        if !*busy {
            print_prompt();
        }
        return false;
    }
    if trimmed == "/exit" || trimmed == "/quit" {
        return true;
    }
    if trimmed == "/abort" {
        if let Some(c) = cur_cancel.as_ref() {
            c.cancel();
        }
        return false;
    }
    if trimmed == "/help" {
        print_help();
        return false;
    }
    if trimmed == "/balance" {
        match deepdive_core::balance::fetch_balance(client, config).await {
            Some(b) => println!("\x1b[2m余额: {}\x1b[0m", b.display()),
            None => println!("\x1b[2m余额查询失败（检查 base_url / api_key）\x1b[0m"),
        }
        return false;
    }
    if trimmed == "/compact" {
        let _ = commands_tx.send(UiToCore::Compact).await;
        println!("\x1b[2m已请求压缩（空闲时执行，几秒后下一回合的上下文将变短）\x1b[0m");
        return false;
    }
    if trimmed == "/clear" {
        let _ = commands_tx.send(UiToCore::Clear).await;
        println!("\x1b[2m已清空，开始新对话\x1b[0m");
        return false;
    }
    if trimmed == "/mode" || trimmed.starts_with("/mode ") {
        let m = trimmed["/mode".len()..].trim();
        match parse_mode(m) {
            Some(mode) => {
                let _ = commands_tx.send(UiToCore::ModeChange(mode)).await;
                println!("\x1b[2m审批模式 → {m}（下个回合生效）\x1b[0m");
            }
            None => println!("\x1b[2m用法: /mode <plan|default|acceptEdits|auto|yolo>\x1b[0m"),
        }
        return false;
    }

    if *busy {
        // Queue mid-turn input (drained by the loop after the current tool batch).
        let _ = commands_tx.send(UiToCore::UserInput(line)).await;
    } else {
        *busy = true;
        let cancel = CancellationToken::new();
        *cur_cancel = Some(cancel.clone());
        let _ = start_tx.send((line, cancel)).await;
    }
    false
}

fn handle_event(ev: AgentEvent, busy: &mut bool, pending: &mut Pending, stream: &mut Stream) {
    match ev {
        AgentEvent::TurnStarted { .. } => {
            *busy = true;
            stream.reset();
        }
        AgentEvent::ThinkingDelta(full) => {
            if !stream.thinking_active {
                stream.thinking_active = true;
                print!("\x1b[2m"); // dim
            }
            print_suffix(&full, &mut stream.thinking_len);
        }
        AgentEvent::ContentDelta(full) => {
            if stream.thinking_active && !stream.content_active {
                println!("\x1b[0m"); // close dim thinking, newline before content
            }
            stream.content_active = true;
            print_suffix(&full, &mut stream.content_len);
        }
        AgentEvent::AssistantMessage(msg) => {
            // Ensure the streamed line is terminated; if nothing streamed (e.g. a
            // tool-only turn), print the content now.
            if stream.content_active {
                println!();
            } else if !msg.content.is_empty() {
                if stream.thinking_active {
                    print!("\x1b[0m");
                }
                println!("{}", msg.content);
            } else if stream.thinking_active {
                print!("\x1b[0m");
            }
            stream.reset();
            let _ = std::io::stdout().flush();
        }
        AgentEvent::ToolStarted { name, summary, .. } => {
            // Memory-aware: a read/write of a memory path shows Recall/Remember(x.md).
            let (disp, sum) = match deepdive_core::tools::format::memory_display(&name, &summary) {
                Some((d, s)) => (d, s),
                None => (name.clone(), summary.clone()),
            };
            println!("\x1b[36m● {disp}\x1b[0m({sum})");
        }
        AgentEvent::ToolFinished { result, .. } => {
            let tag = result.tag.unwrap_or_default();
            let mark = if result.is_error { "✗" } else { "✓" };
            println!("  \x1b[2m⎿ {mark} {tag}\x1b[0m");
        }
        AgentEvent::ApprovalRequest { req, reply } => {
            print_approval(&req.tool_name, &req.args, req.warning.as_deref());
            *pending = Pending::Approval {
                reply,
                patterns: req.save_patterns,
            };
        }
        AgentEvent::AskQuestion { items, reply } => {
            if items.is_empty() {
                let _ = reply.send(None);
            } else {
                print_question(&items[0]);
                *pending = Pending::Question {
                    reply,
                    items,
                    idx: 0,
                    answers: HashMap::new(),
                };
            }
        }
        AgentEvent::BashOutput { chunk, .. } => {
            print!("{chunk}");
            let _ = std::io::stdout().flush();
        }
        AgentEvent::Usage(u) => {
            eprintln!(
                "\x1b[2m  [tokens in:{} out:{}]\x1b[0m",
                u.input_tokens, u.output_tokens
            );
        }
        AgentEvent::BackgroundCount(_) => {
            // The line REPL has no persistent footer; the "Launched background…"
            // tool result already tells the user. Nothing to render here.
        }
        AgentEvent::SubagentStep { name, summary, .. } => {
            // Surface the subagent's step trail inline (dim), mirroring its tools.
            println!("    \x1b[2m⎿ {name}({summary})\x1b[0m");
        }
        AgentEvent::SubagentProgress { .. } => {
            // Progress counters need a live region; the line REPL skips them.
        }
        AgentEvent::Recall(text) => {
            println!("\x1b[2m[recalled: {text}]\x1b[0m");
            *busy = false;
        }
        AgentEvent::MemoryRecalled { count } => {
            let unit = if count == 1 { "memory" } else { "memories" };
            println!("  \x1b[2m⎿ Recalled {count} {unit}\x1b[0m");
        }
        AgentEvent::TurnComplete { .. } => {
            *busy = false;
        }
        AgentEvent::Error(e) => {
            eprintln!("\x1b[31m{e}\x1b[0m");
            *busy = false;
        }
        // /btw isn't wired into this line REPL's own input parsing (TUI-only
        // for now) — print it if it ever arrives, so behavior is defined.
        AgentEvent::SideQuestion { question, result } => match result {
            Ok(Some(answer)) => println!("\x1b[2m[/btw {question}]\x1b[0m\n{answer}"),
            Ok(None) => eprintln!("\x1b[2m[/btw {question}] No response received\x1b[0m"),
            Err(e) => eprintln!("\x1b[31m[/btw {question}] {e}\x1b[0m"),
        },
    }
}

fn print_suffix(full: &str, printed: &mut usize) {
    if full.len() > *printed {
        print!("{}", &full[*printed..]);
        *printed = full.len();
        let _ = std::io::stdout().flush();
    }
}

fn parse_mode(s: &str) -> Option<ApprovalMode> {
    Some(match s {
        "plan" => ApprovalMode::Plan,
        "default" => ApprovalMode::Default,
        "acceptEdits" | "accept-edits" => ApprovalMode::AcceptEdits,
        "auto" => ApprovalMode::Auto,
        "yolo" => ApprovalMode::Yolo,
        _ => return None,
    })
}

fn print_help() {
    println!("\x1b[2m命令: /help · /mode <模式> · /compact · /clear · /balance · /abort · /exit\x1b[0m");
    println!("\x1b[2m模式: plan default acceptEdits auto yolo\x1b[0m");
    println!("\x1b[2m运行中再输入会排队;Ctrl-C 中断(或退出);Ctrl-D 退出\x1b[0m");
}

fn parse_approval(line: &str, patterns: &[String]) -> ApprovalDecision {
    match line.trim().to_lowercase().as_str() {
        "y" | "yes" => ApprovalDecision::Approve,
        "a" | "always" => ApprovalDecision::AllowAlways(patterns.to_vec()),
        _ => ApprovalDecision::Deny,
    }
}

/// Resolve a question answer: a 1-based option number, or free text matched
/// case-insensitively against an option label (falling back to the raw text).
fn resolve_answer(q: &Question, input: &str) -> String {
    if let Ok(n) = input.parse::<usize>() {
        if n >= 1 && n <= q.options.len() {
            return q.options[n - 1].clone();
        }
    }
    for opt in &q.options {
        if opt.eq_ignore_ascii_case(input) {
            return opt.clone();
        }
    }
    input.to_string()
}

// ── rendering ────────────────────────────────────────────────────────────────

fn banner(config: &Config) {
    println!("\x1b[1mDeepDive\x1b[0m (Rust) — interactive");
    println!(
        "\x1b[2mmodel: {}  ·  cwd: {}  ·  /help 查看命令, Ctrl-C 退出\x1b[0m",
        config.model,
        config.cwd.display()
    );
}

fn print_prompt() {
    print!("\n\x1b[1;32m›\x1b[0m ");
    let _ = std::io::stdout().flush();
}

fn print_approval(name: &str, args: &serde_json::Value, warning: Option<&str>) {
    println!("\n\x1b[33m⚠ approve tool\x1b[0m \x1b[1m{name}\x1b[0m");
    let summary = args.to_string();
    let summary = if summary.len() > 200 {
        format!("{}…", &summary[..200])
    } else {
        summary
    };
    println!("  \x1b[2m{summary}\x1b[0m");
    if let Some(w) = warning {
        println!("  \x1b[33m{w}\x1b[0m");
    }
    print!("  approve? [y = yes / N = no / a = always] ");
    let _ = std::io::stdout().flush();
}

fn print_question(q: &Question) {
    println!("\n\x1b[36m? {}\x1b[0m", q.question);
    for (i, opt) in q.options.iter().enumerate() {
        println!("  {}. {}", i + 1, opt);
    }
    print!("  answer (number / text, empty to skip) ");
    let _ = std::io::stdout().flush();
}
