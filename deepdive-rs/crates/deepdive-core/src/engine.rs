//! Headless agent loop (`deepdive exec`). The non-interactive sibling of the
//! P2 interactive loop: full system prompt + all tools, runs to completion,
//! auto-acting (yolo-style) while still honouring explicit permission `deny`
//! rules. Structurally the same loop as `agents::run::run_subagent`, but with
//! the main persona, the `agent`/`skill` tools, and no scoping.
//!
//! The interactive `run_turn_loop` (AgentEvent/UiToCore + human approval, for
//! the TUI) lands next; this proves the end-to-end pipeline first.

use crate::agents::run::{lexical_resolve, run_subagent, RunSubagentParams};
use crate::client::{date_change_message, summarize, ChatOverrides, COMPACT_INSTRUCTION};
use crate::config::{save_additional_directory, save_permission, Config, PermissionKind};
use crate::contract::{
    AgentEvent, ApprovalDecision, ApprovalMode, ApprovalReq, Question, ToolResultView, UiToCore,
};
use crate::session::{
    append_compact, append_message, append_session_meta, make_summary_message, new_session_id,
    update_session_title, SessionMeta,
};
use crate::skills::{
    is_skill_listing_message, make_skill_listing_message, resolve_skill, ResolveSkill,
};
use crate::tasks::notification::make_bg_task_notification;
use crate::tasks::store::{
    is_terminal_bg_status, AbortFn, BgTaskKind, BgTaskResult, BgTaskStatus, RegisterBgTaskInit,
    TaskStore, MAX_BACKGROUND_TASKS,
};
use crate::tools::approval::{is_read_only_tool, tool_allowed, tool_needs_approval};
use crate::tools::bash::{execute_bash, BashOptions};
use crate::tools::classifier::{classify, ClassifyResult};
use crate::tools::dispatch::execute_tool;
use crate::tools::format::{summarize_args, truncate};
use crate::tools::permissions::{
    check_permission, suggest_permission_pattern, PermissionConfig, PermissionDecision,
};
use crate::turn::{stream_turn, StreamTurnResult};
use crate::turn_summary::{
    build_turn_summary_request, make_turn_summary_message, previous_turn_messages,
    previous_turn_summary_blocks, TURN_SUMMARY_INSTRUCTION,
};
use crate::types::{Message, Role, ToolCall, Usage};
use crate::workspace::original_cwd;
use crate::agents::listing::{is_agent_listing_message, make_agent_listing_message};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const DEFAULT_EXEC_MAX_TURNS: u64 = 50;

/// Events emitted during an exec run, for the CLI to render.
#[derive(Debug, Clone)]
pub enum ExecEvent {
    TurnStarted(u32),
    Thinking(String),
    Assistant(String),
    ToolStarted { name: String, summary: String },
    ToolFinished { name: String, ok: bool },
}

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub text: String,
    pub is_error: bool,
    pub turns: u32,
}

/// Run a prompt to completion headlessly, driving the full tool loop.
pub async fn run_exec(
    client: &reqwest::Client,
    config: &Config,
    prompt: &str,
    cancel: &CancellationToken,
    mut on_event: impl FnMut(ExecEvent),
) -> ExecResult {
    let workspace = config.cwd.clone();
    let cap = config.max_turns.unwrap_or(DEFAULT_EXEC_MAX_TURNS);
    let mut history = vec![Message::user(prompt)];
    let mut turn: u32 = 0;
    let mut last_text = String::new();

    while (turn as u64) < cap {
        if cancel.is_cancelled() {
            break;
        }
        turn += 1;
        on_event(ExecEvent::TurnStarted(turn));

        let res = match stream_turn(
            client,
            config,
            &history,
            cancel,
            ChatOverrides::default(),
            |_| {},
            |_| {},
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                return ExecResult {
                    text: format!("Error: {e}"),
                    is_error: true,
                    turns: turn,
                }
            }
        };

        if let Some(rc) = &res.assistant.reasoning_content {
            if !rc.is_empty() {
                on_event(ExecEvent::Thinking(rc.clone()));
            }
        }
        if !res.assistant.content.is_empty() {
            last_text = res.assistant.content.clone();
            on_event(ExecEvent::Assistant(res.assistant.content.clone()));
        }

        let calls = res.assistant.tool_calls.clone();
        let interrupted = res.interrupted;
        let finish = res.finish_reason.clone();
        history.push(res.assistant);

        if interrupted {
            return ExecResult {
                text: last_text,
                is_error: true,
                turns: turn,
            };
        }
        if calls.is_empty() || finish.as_deref() != Some("tool_calls") {
            return ExecResult {
                text: last_text,
                is_error: false,
                turns: turn,
            };
        }

        let mut results = Vec::new();
        for tc in &calls {
            if cancel.is_cancelled() {
                results.push(Message::tool(&tc.id, "Aborted by user."));
                continue;
            }
            let name = &tc.function.name;
            let args: Value = serde_json::from_str(&tc.function.arguments).unwrap_or(Value::Null);
            on_event(ExecEvent::ToolStarted {
                name: name.clone(),
                summary: summarize_args(name, &args),
            });
            let content = exec_one_tool(client, config, name, &args, &workspace, cancel).await;
            on_event(ExecEvent::ToolFinished {
                name: name.clone(),
                ok: !content.starts_with("Error:"),
            });
            results.push(Message::tool(&tc.id, &content));
        }
        history.extend(results);
    }

    ExecResult {
        text: last_text,
        is_error: false,
        turns: turn,
    }
}

async fn exec_one_tool(
    client: &reqwest::Client,
    config: &Config,
    name: &str,
    args: &Value,
    workspace: &Path,
    cancel: &CancellationToken,
) -> String {
    // Headless exec is yolo-style but still honours explicit deny rules.
    if matches!(
        check_permission(Some(&config.permissions), name, args),
        PermissionDecision::Deny
    ) {
        return format!("Error: tool \"{name}\" denied by a permission rule.");
    }

    match name {
        "agent" => {
            let r = run_subagent(
                client,
                RunSubagentParams {
                    agent_type: args
                        .get("subagent_type")
                        .and_then(Value::as_str)
                        .map(String::from),
                    description: args
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    prompt: args
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    config: config.clone(),
                    mode: ApprovalMode::Yolo,
                    permissions: config.permissions.clone(),
                    workspace: workspace.to_path_buf(),
                    max_turns: None,
                },
                cancel,
                |_| {},
                |_| {},
            )
            .await;
            r.text
        }
        "skill" => match resolve_skill(
            args.get("name").and_then(Value::as_str).unwrap_or(""),
            args.get("args").and_then(Value::as_str).unwrap_or(""),
        ) {
            ResolveSkill::Ok { message, .. } => message.content,
            ResolveSkill::Err(e) => e,
        },
        "ask_user_question" => {
            "Error: ask_user_question is not available in headless exec mode.".to_string()
        }
        "task_output" | "task_stop" => {
            "Error: background tasks are not available in headless exec mode.".to_string()
        }
        _ => {
            execute_tool(client, config, name, args, workspace, cancel)
                .await
                .content
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Interactive loop (`engine::run_turn_loop`) — the AgentEvent/UiToCore sibling
// of `run_exec`, for the ratatui TUI (P3) and Tauri GUI (P4). Faithful port of
// the App.tsx `handleSend` agent loop, restructured around the frozen contract.
// ════════════════════════════════════════════════════════════════════════════

const MAX_TASK_POLLS_PER_TURN: u32 = 2;

/// Owned, mutable per-session state that outlives a single `run_turn_loop` call.
/// One `Session` per chat tab; the frontend holds it and calls `run_turn_loop`
/// per user submission. These are the TS `*Ref` values that persist across
/// `handleSend` calls.
pub struct Session {
    /// Full in-memory transcript (NEVER truncated; compaction APPENDS — slicing
    /// happens at request-build time, in `build_body`). Mirrors App.tsx `messages`.
    pub history: Vec<Message>,
    /// Persisted JSONL session id.
    pub session_id: String,
    /// Live approval mode, mutable via `UiToCore::ModeChange` (port of `modeRef`).
    pub mode: ApprovalMode,
    /// In-memory permission rules; `AllowAlways` mutates this for same-session
    /// effect AND persists to disk (port of `permissionsRef`).
    pub permissions: PermissionConfig,
    /// Session-granted out-of-workspace dirs (port of `sessionDirsRef`).
    pub session_dirs: Vec<PathBuf>,
    /// Background-task registry.
    pub tasks: Arc<TaskStore>,
    /// How many transcript messages are already on disk (port of `persistedCountRef`).
    pub persisted_count: usize,
    /// Last turn's usage — the auto-compact pressure proxy (port of `usage`).
    pub last_usage: Option<Usage>,
    /// One-shot compaction circuit breaker (port of `compactDisabledRef`).
    pub compact_disabled: bool,
    /// Token count at the previous compaction (port of `tokensBeforeCompactRef`).
    pub tokens_before_compact: Option<u64>,
    /// Per-task poll counts THIS turn (port of `taskPollCountRef`); cleared at turn start.
    pub task_poll_counts: HashMap<String, u32>,
    /// Cumulative cache hit/miss across the session (port of `cacheTotalsRef`).
    cache_hit_total: u64,
    cache_miss_total: u64,
    /// First-submission bootstrap guard (listings + session meta header).
    bootstrapped: bool,
    /// Topic files already injected via recall this session — so we don't
    /// re-inject the same memory every turn (port of `recalledMemoryPathsRef`).
    recalled_memory_paths: std::collections::HashSet<PathBuf>,
    /// History index at the last turn-end extraction; new-message cursor so
    /// extraction only re-reads messages since (port of `lastExtractIndexRef`).
    last_extract_index: usize,
}

/// Seed the session-scoped grant list from persisted `additionalDirectories`
/// (tilde-expanded). Without this the persisted dirs are written but never
/// enforced by the out-of-workspace gate.
fn seed_session_dirs(config: &Config) -> Vec<PathBuf> {
    config
        .additional_directories
        .iter()
        .map(|d| PathBuf::from(crate::workspace::expand_tilde(d)))
        .collect()
}

impl Session {
    /// A fresh session seeded from config (mode/permissions). A new session id is
    /// minted; the JSONL file is created lazily on first persist.
    pub fn new(config: &Config) -> Self {
        Session {
            history: Vec::new(),
            session_id: new_session_id(),
            mode: config.approval_mode,
            permissions: config.permissions.clone(),
            session_dirs: seed_session_dirs(config),
            tasks: Arc::new(TaskStore::new()),
            persisted_count: 0,
            last_usage: None,
            compact_disabled: false,
            tokens_before_compact: None,
            task_poll_counts: HashMap::new(),
            cache_hit_total: 0,
            cache_miss_total: 0,
            bootstrapped: false,
            recalled_memory_paths: std::collections::HashSet::new(),
            last_extract_index: 0,
        }
    }

    /// Resume from a loaded transcript: history is already on disk, so the
    /// persist cursor starts at its end (nothing to re-write).
    pub fn resume(config: &Config, session_id: String, history: Vec<Message>, last_usage: Option<Usage>) -> Self {
        let persisted_count = history.len();
        Session {
            history,
            session_id,
            mode: config.approval_mode,
            permissions: config.permissions.clone(),
            session_dirs: seed_session_dirs(config),
            tasks: Arc::new(TaskStore::new()),
            persisted_count,
            last_usage,
            compact_disabled: false,
            tokens_before_compact: None,
            task_poll_counts: HashMap::new(),
            cache_hit_total: 0,
            cache_miss_total: 0,
            bootstrapped: true, // resumed transcripts already carry listings/meta
            recalled_memory_paths: std::collections::HashSet::new(),
            last_extract_index: persisted_count,
        }
    }
}

/// Result of one user submission's full multi-turn loop.
#[derive(Debug, Clone, Default)]
pub struct TurnLoopOutcome {
    /// Recalled input to hand back to the input box (first-turn pre-output abort).
    pub recalled: Option<String>,
    /// Number of model turns executed this submission.
    pub turns: u32,
}

/// Outcome of gating one tool call interactively.
#[derive(Debug, Clone, PartialEq, Eq)]
enum GateOutcome {
    /// Run the tool.
    Proceed,
    /// Skip with this stub tool-result content (denied / disallowed).
    Stub(String),
}

/// Drive the interactive agent loop for ONE user submission (which may run many
/// model turns until a final reply). Interactive sibling of [`run_exec`].
///
/// `events` carries engine→UI [`AgentEvent`]s; `commands` carries UI→engine
/// [`UiToCore`] (queued input drained between turns, live mode change, abort).
/// `cancel` is the per-submission token (the frontend cancels it on `Abort`).
pub async fn run_turn_loop(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    user_input: String,
    events: &mpsc::Sender<AgentEvent>,
    commands: &mut mpsc::Receiver<UiToCore>,
    cancel: &CancellationToken,
) -> TurnLoopOutcome {
    // 0. BOOTSTRAP (first submission): inject skill+agent listings + meta header.
    ensure_session_bootstrap(session, config);
    persist_pending(session);

    // 1. APPEND USER INPUT.
    session.history.push(Message::user(user_input.clone()));
    persist_pending(session);

    // 1b. MEMORY RECALL — pick topic files relevant to this user query and inject
    // their contents as a system-reminder (best-effort; never blocks the turn).
    // The reminder is a meta message and IS persisted so a resumed session keeps
    // the same context the model saw.
    if crate::memory::paths::is_auto_memory_enabled() {
        let surfaced = session.recalled_memory_paths.clone();
        let relevant = crate::memory::recall::find_relevant_memories(
            client, config, &user_input, &[], &surfaced,
        )
        .await;
        if let Some(msg) = crate::memory::recall::make_recall_message(&relevant) {
            for r in &relevant {
                session.recalled_memory_paths.insert(r.path.clone());
            }
            session.history.push(msg);
            persist_pending(session);
            let _ = events
                .send(AgentEvent::MemoryRecalled { count: relevant.len() })
                .await;
        }
    }

    run_loop_body(client, config, session, Some(user_input), events, commands, cancel).await
}

/// Resume the conversation after background tasks finished while the session was
/// idle: seed history with their completion notifications (meta messages) and
/// run turns so the model acts on the results. No user input ⇒ no recall. This
/// is what fulfils the "you'll be AUTOMATICALLY resumed when it's done" promise
/// in the background-task ack messages.
pub async fn resume_background(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    notifications: Vec<Message>,
    events: &mpsc::Sender<AgentEvent>,
    commands: &mut mpsc::Receiver<UiToCore>,
    cancel: &CancellationToken,
) -> TurnLoopOutcome {
    if notifications.is_empty() {
        return TurnLoopOutcome::default();
    }
    ensure_session_bootstrap(session, config);
    session.history.extend(notifications);
    persist_pending(session);
    run_loop_body(client, config, session, None, events, commands, cancel).await
}

/// The shared turn loop behind both [`run_turn_loop`] (user submission) and
/// [`resume_background`] (background-task continuation). `recall_input` is
/// `Some` only for a user submission, enabling the first-turn recall path.
#[allow(clippy::too_many_arguments)]
async fn run_loop_body(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    recall_input: Option<String>,
    events: &mpsc::Sender<AgentEvent>,
    commands: &mut mpsc::Receiver<UiToCore>,
    cancel: &CancellationToken,
) -> TurnLoopOutcome {
    // 2. PREFLIGHT — previous-turn summary.
    if let Err(e) = maybe_summarize_previous_turn(client, config, session, cancel).await {
        if !cancel.is_cancelled() {
            let _ = events.send(AgentEvent::Error(format!("previous-turn summary failed: {e}"))).await;
        }
    }
    persist_pending(session);

    // 3. PREFLIGHT — auto-compact.
    if let Err(e) = maybe_auto_compact(client, config, session, cancel).await {
        if !cancel.is_cancelled() {
            let _ = events.send(AgentEvent::Error(e.to_string())).await;
        }
    }
    persist_pending(session);

    // 4. LOOP SETUP.
    let cap = config.max_turns;
    let mut turn: u32 = 0;
    let mut last_finish: Option<String> = None;
    session.task_poll_counts.clear();

    // 4b. AUTO-MODEL ROUTE. When the session model is "auto" AND this is a user
    // submission (not a background continuation), a flash classifier picks
    // pro/flash for the whole turn loop, and the pick is announced so the footer
    // shows `Auto(pro)` / `Auto(flash)`. Non-auto models and continuations send
    // `None`, letting `build_body` resolve the model (continuations keep the
    // prior turn's resolved model; "auto" → Pro). The classifier is best-effort
    // and never throws — any failure falls back to Pro. Port of App.tsx's
    // `requestModel` + `setActiveModel(requestModel)`.
    let request_model: Option<String> = match recall_input.as_deref() {
        Some(input) if config.model == "auto" => {
            let model = crate::model_router::route_model(client, config, input)
                .await
                .model_id()
                .to_string();
            let _ = events
                .send(AgentEvent::ModelRouted { model: model.clone() })
                .await;
            Some(model)
        }
        _ => None,
    };

    // 5. MAIN LOOP.
    loop {
        // 5a. Drain pending commands before the model call.
        drain_commands(client, config, session, commands, events, cancel);
        // 5b. Top-of-loop abort.
        if cancel.is_cancelled() {
            break;
        }
        // 5c. maxTurns guard (a normal assistant notice, NOT an error).
        if let Some(c) = cap {
            if turn as u64 >= c {
                let notice = Message::assistant(max_turns_notice(c));
                let _ = events.send(AgentEvent::AssistantMessage(notice.clone())).await;
                session.history.push(notice);
                persist_pending(session);
                break;
            }
        }
        turn += 1;
        let _ = events.send(AgentEvent::TurnStarted { turn }).await;

        // 5d. Midnight date-change reminder.
        if let Some(m) = date_change_message() {
            session.history.push(m);
            persist_pending(session);
        }

        // 5e. STREAM ONE TURN.
        let res = {
            let ev_think = events.clone();
            let ev_content = events.clone();
            stream_turn(
                client,
                config,
                &session.history,
                cancel,
                ChatOverrides {
                    model: request_model.clone(),
                    ..Default::default()
                },
                move |full| {
                    let _ = ev_think.try_send(AgentEvent::ThinkingDelta(full.to_string()));
                },
                move |full| {
                    let _ = ev_content.try_send(AgentEvent::ContentDelta(full.to_string()));
                },
            )
            .await
        };
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                // turn.rs returns Err only on a non-cancel transport error.
                let _ = events.send(AgentEvent::Error(e.to_string())).await;
                break;
            }
        };

        // 5f. Usage merge.
        if let Some(u) = res.usage.as_ref() {
            let merged = merge_session_usage(session, u);
            session.last_usage = Some(merged.clone());
            let _ = events.send(AgentEvent::Usage(merged)).await;
        }

        // 5g. RECALL — first turn aborted before ANY output (user submissions only).
        if let Some(input) = recall_input.as_ref() {
            if is_first_turn_recall(turn, &res) {
                session.history.pop(); // drop the held user message
                let _ = events.send(AgentEvent::Recall(input.clone())).await;
                return TurnLoopOutcome {
                    recalled: Some(input.clone()),
                    turns: turn,
                };
            }
        }

        // 5h. COMMIT ASSISTANT.
        let calls = res.assistant.tool_calls.clone();
        let finish = res.finish_reason.clone();
        last_finish = finish.clone();
        let interrupted = res.interrupted;
        let mut assistant_msg = res.assistant;
        if res.usage.is_some() {
            assistant_msg.usage = session.last_usage.clone();
        }
        let _ = events.send(AgentEvent::AssistantMessage(assistant_msg.clone())).await;
        session.history.push(assistant_msg);
        persist_pending(session);

        // 5i. Interrupted mid-stream → terminate cleanly.
        if interrupted {
            break;
        }

        // 5j. Continuation decision (conjunction).
        if !should_continue(&calls, finish.as_deref()) {
            break;
        }

        // 5k. TOOL LOOP (sequential, in array order).
        let (results, denied) = run_tool_batch(client, config, session, &calls, events, cancel).await;

        // 5l. Append results.
        session.history.extend(results);
        persist_pending(session);

        // 5m. Mid-loop queue drain (new user input is seen by the next turn).
        let before = session.history.len();
        drain_commands(client, config, session, commands, events, cancel);
        if session.history.len() != before {
            persist_pending(session);
        }

        // 5n. A denial batch breaks the whole loop.
        if denied {
            break;
        }
    }

    // 5o. TURN-END MEMORY EXTRACTION (fire-and-forget). A detached forked agent
    // re-reads the messages added this loop and saves durable memories the main
    // agent didn't write itself. Best-effort: never blocks the turn or surfaces
    // errors. Skipped on abort. The forked agent works on a CLONE of history, so
    // it never races the main session's transcript.
    if !cancel.is_cancelled() && crate::memory::paths::is_auto_memory_enabled() {
        let cursor = session.last_extract_index.min(session.history.len());
        let new_count = session.history[cursor..]
            .iter()
            .filter(|m| matches!(m.role, crate::types::Role::User | crate::types::Role::Assistant))
            .count();
        session.last_extract_index = session.history.len();
        if new_count > 0 {
            let client2 = client.clone();
            let config2 = config.clone();
            let convo = session.history.clone();
            let cancel2 = cancel.clone();
            tokio::spawn(async move {
                let _ = crate::memory::extract::run_memory_extraction(
                    &client2, &config2, &convo, new_count, &cancel2,
                )
                .await;
            });
        }
    }

    // 5p. FINALIZE.
    let _ = events.send(AgentEvent::TurnComplete { finish_reason: last_finish }).await;
    TurnLoopOutcome { recalled: None, turns: turn }
}

/// Drain all currently-queued UI commands (non-blocking). New user input is
/// appended to history (seen by the next turn); a mode change updates the live
/// mode; an abort cancels the token.
#[allow(clippy::too_many_arguments)]
fn drain_commands(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    commands: &mut mpsc::Receiver<UiToCore>,
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) {
    while let Ok(cmd) = commands.try_recv() {
        match cmd {
            UiToCore::UserInput(s) => session.history.push(Message::user(s)),
            UiToCore::ModeChange(m) => session.mode = m,
            UiToCore::Abort => cancel.cancel(),
            UiToCore::AddDir(d) => add_session_dir(session, &d),
            // Rename only writes the session meta header — safe mid-submission.
            UiToCore::Rename(t) => update_session_title(&session.session_id, &t),
            // Re-scan agents + rebuild the listing so the next turn sees it.
            UiToCore::ReloadAgents => reload_agent_listing(session),
            // /btw: unlike everything else here, this must not wait for the
            // engine to go idle — spawn it off a snapshot the instant it's seen.
            UiToCore::AskSideQuestion { question, prior_exchanges } => spawn_side_question(
                client, config, &session.history, prior_exchanges, question, events,
            ),
            // Compact/Clear/ApplySettings are idle-only intents (handled by the
            // engine task's idle command arm); ignore them mid-submission.
            UiToCore::Compact | UiToCore::Clear | UiToCore::ApplySettings { .. } => {}
        }
    }
}

/// Spawn a detached `/btw` side question (or follow-up) off a snapshot of
/// `history` taken at this instant, reporting the result back via `events`.
/// It never touches `session` again once spawned, so it runs safely alongside
/// (or after) whatever the main turn loop is doing — see side_question.rs for
/// why an unmodified history snapshot still rides the main loop's prefix
/// cache, and for what `prior_exchanges` is.
pub fn spawn_side_question(
    client: &reqwest::Client,
    config: &Config,
    history: &[Message],
    prior_exchanges: Vec<Message>,
    question: String,
    events: &mpsc::Sender<AgentEvent>,
) {
    let client = client.clone();
    let config = config.clone();
    let history = history.to_vec();
    let events = events.clone();
    tokio::spawn(async move {
        let cancel = CancellationToken::new();
        let result = crate::side_question::run_side_question(
            &client, &config, &history, &prior_exchanges, &question, &cancel,
        )
        .await
        .map_err(|e| e.to_string());
        let _ = events
            .send(AgentEvent::SideQuestion { question, result })
            .await;
    });
}

/// Re-scan custom agents and rebuild the in-session agent listing (manual
/// `/agents`). The bootstrap-time injection is gated by `bootstrapped`, so a
/// mid-session agent edit needs this explicit drop+re-inject to reach the model
/// (port of agents.ts filtering the stale listing so it gets rebuilt next turn).
pub fn reload_agent_listing(session: &mut Session) {
    crate::agents::registry::reload_agents();
    session.history.retain(|m| !is_agent_listing_message(m));
    if let Some(m) = make_agent_listing_message() {
        session.history.push(m);
    }
}

/// Add a tilde-expanded directory to the session-scoped grant list (idempotent).
/// On a newly-granted dir, also inject a meta user message so the model learns
/// the directory is in scope (port of `adddir.ts`'s `meta:true` message — the
/// env section only lists persisted `additionalDirectories`, not session grants).
pub fn add_session_dir(session: &mut Session, dir: &str) {
    let p = PathBuf::from(crate::workspace::expand_tilde(dir));
    if !session.session_dirs.contains(&p) {
        session.session_dirs.push(p);
        let mut m = Message::user(format!("Additional working directory added: {dir}"));
        m.meta = true;
        session.history.push(m);
    }
}

/// Compact the conversation unconditionally (manual `/compact`): summarize the
/// whole history and APPEND the summary. Slicing at request-build keeps cost low.
/// Unlike [`maybe_auto_compact`] there is no token threshold or breaker.
pub async fn compact_now(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
) -> anyhow::Result<()> {
    if session.history.is_empty() {
        return Ok(());
    }
    let mut req = session.history.clone();
    req.push(Message::user(COMPACT_INSTRUCTION));
    let summary = summarize(client, config, &req, &CancellationToken::new()).await?;
    append_compact(&session.session_id, &summary);
    session.history.push(make_summary_message(&summary));
    session.persisted_count = session.history.len();
    Ok(())
}

/// Execute one assistant message's tool calls, strictly sequentially in array
/// order. Returns (tool results + injected skill messages, denied). Guarantees
/// exactly one `role:tool` result per `tool_call_id` (every stub path included).
async fn run_tool_batch(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    calls: &[ToolCall],
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> (Vec<Message>, bool) {
    let recent_user = most_recent_non_meta_user(&session.history);
    let mut results: Vec<Message> = Vec::new();
    let mut injected: Vec<Message> = Vec::new();
    let mut denied = false;

    for tc in calls {
        if cancel.is_cancelled() {
            results.push(Message::tool(&tc.id, "Aborted by user."));
            continue;
        }
        if denied {
            results.push(Message::tool(&tc.id, "Error: User denied the tool execution."));
            continue;
        }
        let name = tc.function.name.clone();
        let args: Value = serde_json::from_str(&tc.function.arguments).unwrap_or(Value::Null);
        let _ = events
            .send(AgentEvent::ToolStarted {
                call_id: tc.id.clone(),
                name: name.clone(),
                summary: summarize_args(&name, &args),
            })
            .await;

        // Mode gate (the skill tool is always available).
        if name != "skill" && !tool_allowed(&name, session.mode) {
            let stub = format!(
                "Error: tool \"{name}\" is not available in {} mode.",
                mode_str(session.mode)
            );
            let _ = events
                .send(AgentEvent::ToolFinished {
                    call_id: tc.id.clone(),
                    result: to_result_view(&name, &stub, true),
                })
                .await;
            results.push(Message::tool(&tc.id, &stub));
            continue;
        }

        // Interactive gate (rules → mode → out-of-workspace → classifier → prompt).
        if name != "skill" {
            match gate_tool_interactive(client, config, session, &name, &args, &recent_user, events, cancel).await {
                GateOutcome::Proceed => {}
                GateOutcome::Stub(s) => {
                    if s.contains("User denied") {
                        denied = true;
                    }
                    let _ = events
                        .send(AgentEvent::ToolFinished {
                            call_id: tc.id.clone(),
                            result: to_result_view(&name, &s, true),
                        })
                        .await;
                    results.push(Message::tool(&tc.id, &s));
                    continue;
                }
            }
        }

        // Dispatch.
        let (content, is_error) =
            dispatch_interactive(client, config, session, &tc.id, &name, &args, &mut injected, events, cancel).await;
        let _ = events
            .send(AgentEvent::ToolFinished {
                call_id: tc.id.clone(),
                result: to_result_view(&name, &content, is_error),
            })
            .await;
        // Surface the live background-task count (a launch/stop just changed it).
        let _ = events
            .send(AgentEvent::BackgroundCount(session.tasks.running_count()))
            .await;
        results.push(Message::tool(&tc.id, &content));
    }

    // Injected skill messages ride AFTER all tool results (App.tsx:1747).
    results.extend(injected);
    (results, denied)
}

/// The interactive approval gate. Mirrors App.tsx:1168-1318: the gate only
/// engages for tools that need approval or escape the workspace; then the rule
/// pipeline runs, then mode/out-of-workspace, then the auto+bash classifier,
/// then it emits `ApprovalRequest` and awaits the oneshot.
#[allow(clippy::too_many_arguments)]
async fn gate_tool_interactive(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    name: &str,
    args: &Value,
    recent_user: &str,
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> GateOutcome {
    let (outside, grant_dir) = resolve_out_of_workspace(config, &session.session_dirs, name, args);

    // The whole gate only engages for tools needing approval or escaping cwd.
    if !(tool_needs_approval(name, session.mode) || outside) {
        return GateOutcome::Proceed;
    }

    match check_permission(Some(&session.permissions), name, args) {
        PermissionDecision::Deny => GateOutcome::Stub("Error: User denied the tool execution.".into()),
        PermissionDecision::Allow => GateOutcome::Proceed,
        // Explicit ask rule: always prompt, no classifier shortcut, no warning.
        PermissionDecision::Ask => prompt_approval(session, name, args, None, grant_dir, events, cancel).await,
        PermissionDecision::Passthrough => {
            if outside {
                // auto + read-only outside the workspace is safe — no prompt.
                if session.mode == ApprovalMode::Auto && is_read_only_tool(name) {
                    return GateOutcome::Proceed;
                }
                let warning = out_of_workspace_warning(&grant_dir);
                prompt_approval(session, name, args, warning, grant_dir, events, cancel).await
            } else if session.mode == ApprovalMode::Auto && name == "bash" {
                let cmd = args.get("command").and_then(Value::as_str).unwrap_or("");
                match classify(client, config, cmd, recent_user).await {
                    ClassifyResult::Allow => GateOutcome::Proceed,
                    ClassifyResult::Block => {
                        prompt_approval(
                            session,
                            name,
                            args,
                            Some("(classifier flagged this as dangerous)".into()),
                            None,
                            events,
                            cancel,
                        )
                        .await
                    }
                    ClassifyResult::Ask => prompt_approval(session, name, args, None, None, events, cancel).await,
                }
            } else {
                prompt_approval(session, name, args, None, None, events, cancel).await
            }
        }
    }
}

/// Emit an `ApprovalRequest` and await the human decision on the oneshot.
/// Abort (or a dropped UI) resolves to `Deny` so the loop never hangs.
/// `AllowAlways` persists patterns to disk AND in-memory, and grants an
/// out-of-workspace dir for the rest of the session.
#[allow(clippy::too_many_arguments)]
async fn prompt_approval(
    session: &mut Session,
    name: &str,
    args: &Value,
    warning: Option<String>,
    grant_dir: Option<PathBuf>,
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> GateOutcome {
    let (tx, rx) = oneshot::channel();
    let save_patterns = suggest_permission_pattern(name, args).unwrap_or_default();
    let req = ApprovalReq {
        tool_name: name.to_string(),
        args: args.clone(),
        warning,
        save_patterns,
    };
    if events.send(AgentEvent::ApprovalRequest { req, reply: tx }).await.is_err() {
        return GateOutcome::Stub("Error: User denied the tool execution.".into());
    }
    let decision = tokio::select! {
        biased;
        _ = cancel.cancelled() => ApprovalDecision::Deny,
        d = rx => d.unwrap_or(ApprovalDecision::Deny),
    };
    match decision {
        ApprovalDecision::Approve => GateOutcome::Proceed,
        ApprovalDecision::Deny => GateOutcome::Stub("Error: User denied the tool execution.".into()),
        ApprovalDecision::AllowAlways(patterns) => {
            for p in &patterns {
                save_permission(p, PermissionKind::Allow);
                if !session.permissions.allow.contains(p) {
                    session.permissions.allow.push(p.clone());
                }
            }
            if let Some(d) = grant_dir {
                let ds = d.to_string_lossy().into_owned();
                save_additional_directory(&ds);
                if !session.session_dirs.contains(&d) {
                    session.session_dirs.push(d);
                }
            }
            GateOutcome::Proceed
        }
    }
}

/// Interactive tool dispatch. Branches the loop owns (skill/bash/agent/ask/task)
/// plus a fallthrough to the shared `execute_tool`. Returns (content, is_error).
#[allow(clippy::too_many_arguments)]
async fn dispatch_interactive(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    call_id: &str,
    name: &str,
    args: &Value,
    injected: &mut Vec<Message>,
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> (String, bool) {
    let run_in_background = args
        .get("run_in_background")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match name {
        "skill" => {
            let sname = args.get("name").and_then(Value::as_str).unwrap_or("");
            let sargs = args.get("args").and_then(Value::as_str).unwrap_or("");
            match resolve_skill(sname, sargs) {
                ResolveSkill::Ok { skill, message } => {
                    injected.push(message);
                    (format!("Loaded skill: {}", skill.name), false)
                }
                ResolveSkill::Err(e) => (e, true),
            }
        }
        "bash" if run_in_background => launch_bg_bash(session, args),
        "bash" => {
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            let opts = BashOptions {
                background: false,
                timeout_ms: args.get("timeout").and_then(Value::as_u64),
            };
            let ev = events.clone();
            let r = execute_bash(command, &config.cwd, opts, cancel, move |chunk| {
                let _ = ev.try_send(AgentEvent::BashOutput {
                    task_id: 0,
                    chunk: chunk.to_string(),
                });
            })
            .await;
            (r.content, r.is_error)
        }
        "agent" if run_in_background => launch_bg_agent(client, config, session, args),
        "agent" => {
            // Stream the subagent's progress + step trail to the UI, tagged with
            // this tool call's id so the frontend attaches them to its card.
            // The callbacks are sync (FnMut), so use non-blocking try_send.
            let ev_p = events.clone();
            let cid_p = call_id.to_string();
            let ev_s = events.clone();
            let cid_s = call_id.to_string();
            let r = run_subagent(
                client,
                RunSubagentParams {
                    agent_type: args.get("subagent_type").and_then(Value::as_str).map(String::from),
                    description: args.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                    prompt: args.get("prompt").and_then(Value::as_str).unwrap_or("").to_string(),
                    config: config.clone(),
                    mode: session.mode,
                    permissions: session.permissions.clone(),
                    workspace: config.cwd.clone(),
                    max_turns: None,
                },
                cancel,
                move |p| {
                    let _ = ev_p.try_send(AgentEvent::SubagentProgress {
                        call_id: cid_p.clone(),
                        agent_type: p.agent_type,
                        turn: p.turn,
                        tool_calls: p.tool_calls,
                        activity: p.activity,
                    });
                },
                move |s| {
                    let _ = ev_s.try_send(AgentEvent::SubagentStep {
                        call_id: cid_s.clone(),
                        name: s.name,
                        summary: s.summary,
                        result: s.result,
                    });
                },
            )
            .await;
            (r.text, r.is_error)
        }
        "ask_user_question" => ask_user_question(args, events, cancel).await,
        "task_output" => task_output(session, args),
        "task_stop" => task_stop(session, args),
        _ => {
            let r = execute_tool(client, config, name, args, &config.cwd, cancel).await;
            (r.content, r.is_error)
        }
    }
}

/// `ask_user_question`: emit `AskQuestion` and block on the oneshot. Abort or a
/// dropped UI resolves to "declined".
async fn ask_user_question(
    args: &Value,
    events: &mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> (String, bool) {
    let items = normalize_questions(args);
    if items.is_empty() {
        return (
            "Error: no valid questions provided. Each question needs non-empty text and at least 2 options.".to_string(),
            true,
        );
    }
    let declined: Vec<String> = items.iter().map(|q| q.question.clone()).collect();
    let (tx, rx) = oneshot::channel();
    if events.send(AgentEvent::AskQuestion { items, reply: tx }).await.is_err() {
        return (serde_json::json!({ "declined": declined }).to_string(), false);
    }
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        a = rx => a.unwrap_or(None),
    };
    match answer {
        Some(map) => (serde_json::json!({ "answers": map }).to_string(), false),
        None => (serde_json::json!({ "declined": declined }).to_string(), false),
    }
}

/// `task_output`: a non-blocking snapshot of a background task, with per-turn
/// poll backpressure (App.tsx:1640-1692).
fn task_output(session: &mut Session, args: &Value) -> (String, bool) {
    let task_id = args.get("task_id").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(task) = session.tasks.get(&task_id) else {
        return (format!("Error: no background task with id \"{task_id}\"."), true);
    };
    if is_terminal_bg_status(task.status) {
        session.tasks.mark_notified(&task_id);
        session.task_poll_counts.remove(&task_id);
        let body = task.result.clone().unwrap_or_else(|| task.output.clone());
        return (
            format!("Task {} ({}) — status: {}\n\n{}", task.id, task.kind.as_str(), task.status.as_str(), body),
            false,
        );
    }
    let polls = session.task_poll_counts.get(&task_id).copied().unwrap_or(0) + 1;
    session.task_poll_counts.insert(task_id.clone(), polls);
    if polls > MAX_TASK_POLLS_PER_TURN {
        return (
            format!(
                "Task {task_id} is still running and you've already checked it this turn. \
                 STOP calling task_output — end your turn now. DeepDive will automatically \
                 resume you with the result when it finishes; polling again only wastes turns. \
                 (Keep checking only if the user explicitly asked you to wait for it.)"
            ),
            false,
        );
    }
    let delta = session.tasks.read_output_delta(&task_id);
    let body = if delta.is_empty() {
        "(no new output since your last check)".to_string()
    } else {
        delta
    };
    (
        format!("Task {} ({}) — status: running\n\n{}", task.id, task.kind.as_str(), body),
        false,
    )
}

/// `task_stop`: abort a running background task and mark it killed.
fn task_stop(session: &mut Session, args: &Value) -> (String, bool) {
    let task_id = args.get("task_id").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(task) = session.tasks.get(&task_id) else {
        return (format!("Error: no background task with id \"{task_id}\"."), true);
    };
    if is_terminal_bg_status(task.status) {
        session.tasks.mark_notified(&task_id);
        return (format!("Task {task_id} already {}.", task.status.as_str()), false);
    }
    session.tasks.abort(&task_id);
    session.tasks.finish(
        &task_id,
        BgTaskResult {
            status: BgTaskStatus::Killed,
            result: if task.output.is_empty() { "(killed)".to_string() } else { task.output.clone() },
            is_error: true,
            turns: None,
            tool_calls: None,
        },
    );
    session.tasks.mark_notified(&task_id);
    (format!("Stopped background task {task_id}."), false)
}

/// Launch a detached background bash command. Streams output into the TaskStore;
/// the frontend reads it via `task_output` / a completion notification.
fn launch_bg_bash(session: &mut Session, args: &Value) -> (String, bool) {
    if !session.tasks.can_launch() {
        return (bg_limit_error(), true);
    }
    let command = args.get("command").and_then(Value::as_str).unwrap_or("").to_string();
    let task_id = session.tasks.generate_id(BgTaskKind::Bash);
    let child = CancellationToken::new();
    let abort: AbortFn = {
        let c = child.clone();
        Arc::new(move || c.cancel())
    };
    session.tasks.register(RegisterBgTaskInit {
        id: task_id.clone(),
        kind: BgTaskKind::Bash,
        description: truncate(&command, 80),
        agent_type: None,
        command: Some(command.clone()),
        abort,
    });
    let tasks = session.tasks.clone();
    let tid = task_id.clone();
    let cmd = command.clone();
    tokio::spawn(async move {
        let opts = BashOptions { background: true, timeout_ms: None };
        let r = execute_bash(&cmd, &original_cwd(), opts, &child, |chunk| tasks.append_output(&tid, chunk)).await;
        tasks.finish(
            &tid,
            BgTaskResult {
                status: if r.is_error { BgTaskStatus::Failed } else { BgTaskStatus::Completed },
                result: r.content,
                is_error: r.is_error,
                turns: None,
                tool_calls: None,
            },
        );
    });
    (bg_bash_ack(&task_id, &command), false)
}

/// Launch a detached background subagent. Streams its step trail into the store.
fn launch_bg_agent(client: &reqwest::Client, config: &Config, session: &mut Session, args: &Value) -> (String, bool) {
    if !session.tasks.can_launch() {
        return (bg_limit_error(), true);
    }
    let subtype = args.get("subagent_type").and_then(Value::as_str).map(String::from);
    let desc = args.get("description").and_then(Value::as_str).unwrap_or("").to_string();
    let prompt = args.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let agent_type = subtype.clone().unwrap_or_else(|| "general-purpose".to_string());
    let task_id = session.tasks.generate_id(BgTaskKind::Agent);
    let child = CancellationToken::new();
    let abort: AbortFn = {
        let c = child.clone();
        Arc::new(move || c.cancel())
    };
    session.tasks.register(RegisterBgTaskInit {
        id: task_id.clone(),
        kind: BgTaskKind::Agent,
        description: desc.clone(),
        agent_type: Some(agent_type.clone()),
        command: None,
        abort,
    });
    let ack = bg_agent_ack(&task_id, &agent_type, &desc);
    let tasks = session.tasks.clone();
    let tid = task_id.clone();
    let client2 = client.clone();
    let config2 = config.clone();
    let mode = session.mode;
    let perms = session.permissions.clone();
    tokio::spawn(async move {
        let tasks_step = tasks.clone();
        let tid_step = tid.clone();
        let r = run_subagent(
            &client2,
            RunSubagentParams {
                agent_type: subtype,
                description: desc,
                prompt,
                config: config2,
                mode,
                permissions: perms,
                workspace: original_cwd(),
                max_turns: None,
            },
            &child,
            |_| {},
            move |s| {
                let line = if s.result.is_empty() {
                    format!("{}({})\n", s.name, s.summary)
                } else {
                    format!("{}({}) → {}\n", s.name, s.summary, s.result)
                };
                tasks_step.append_output(&tid_step, &line);
            },
        )
        .await;
        tasks.finish(
            &tid,
            BgTaskResult {
                status: if r.is_error { BgTaskStatus::Failed } else { BgTaskStatus::Completed },
                result: r.text,
                is_error: r.is_error,
                turns: Some(r.turns),
                tool_calls: Some(r.tool_calls),
            },
        );
    });
    (ack, false)
}

// ── preflight: summaries + compaction ────────────────────────────────────────

async fn maybe_summarize_previous_turn(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    let blocks = previous_turn_summary_blocks(&session.history, config.turn_summary_strategy);
    if blocks.is_empty() {
        return Ok(());
    }
    let turn_user = previous_turn_messages(&session.history)
        .into_iter()
        .find(|m| m.role == Role::User && !m.meta);
    let mut summary_msgs = Vec::new();
    for block in &blocks {
        let input: Vec<Message> = match (&block.strategy, &turn_user) {
            (crate::types::TurnSummaryStrategy::ToolOnly, Some(u)) => {
                let mut v = vec![u.clone()];
                v.extend(block.messages.clone());
                v
            }
            _ => block.messages.clone(),
        };
        let req = build_turn_summary_request(&input, TURN_SUMMARY_INSTRUCTION);
        let summary = summarize(client, config, &req, cancel).await?;
        summary_msgs.push(make_turn_summary_message(&summary, block.strategy));
    }
    session.history.extend(summary_msgs);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompactDecision {
    Skip,
    Compact,
    Disable,
}

/// Auto-compact decision (App.tsx:999-1027). Pure; no I/O. Truncating the `*0.8`
/// thresholds to integers matches the TS strict `>` against the float product.
fn compact_decision(
    last_usage: Option<&Usage>,
    context_window: u64,
    compact_disabled: bool,
    tokens_before_compact: Option<u64>,
) -> CompactDecision {
    if compact_disabled {
        return CompactDecision::Skip;
    }
    let Some(u) = last_usage else {
        return CompactDecision::Skip;
    };
    if context_window == 0 {
        return CompactDecision::Skip;
    }
    let threshold = (context_window as f64 * 0.8) as u64;
    if u.input_tokens <= threshold {
        return CompactDecision::Skip;
    }
    if let Some(prev) = tokens_before_compact {
        if u.input_tokens > (prev as f64 * 0.8) as u64 {
            return CompactDecision::Disable;
        }
    }
    CompactDecision::Compact
}

async fn maybe_auto_compact(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    match compact_decision(
        session.last_usage.as_ref(),
        config.context_window,
        session.compact_disabled,
        session.tokens_before_compact,
    ) {
        CompactDecision::Skip => Ok(()),
        CompactDecision::Disable => {
            session.compact_disabled = true;
            Err(anyhow::anyhow!(
                "Auto-compact disabled: previous compaction did not reduce input tokens enough \
                 (likely DEEPSEEK_CONTEXT_WINDOW is too small for the base prompt). Raise it in settings."
            ))
        }
        CompactDecision::Compact => {
            let input_tokens = session.last_usage.as_ref().map(|u| u.input_tokens).unwrap_or(0);
            session.tokens_before_compact = Some(input_tokens);
            // compactHistory: summarize the whole conversation (summarize slices
            // from the last summary internally), then APPEND the summary.
            let mut req = session.history.clone();
            req.push(Message::user(COMPACT_INSTRUCTION));
            let summary = summarize(client, config, &req, cancel).await?;
            append_compact(&session.session_id, &summary);
            session.history.push(make_summary_message(&summary));
            // The summary is persisted as a {type:"compact"} line above — advance
            // the cursor past it so persist_pending never re-writes it as a msg.
            session.persisted_count = session.history.len();
            Ok(())
        }
    }
}

// ── small helpers ────────────────────────────────────────────────────────────

/// Collect finished-but-unnotified background tasks into their notification
/// messages (marking each notified so it surfaces once). Empty when nothing new
/// has finished.
pub fn collect_bg_notifications(session: &Session) -> Vec<Message> {
    let mut out = Vec::new();
    for task in session.tasks.snapshot() {
        if is_terminal_bg_status(task.status) && !task.notified {
            out.push(make_bg_task_notification(&task));
            session.tasks.mark_notified(&task.id);
        }
    }
    out
}

/// Run continuation turns for every background task that has finished, looping
/// until none remain (a continuation may itself launch more). The frontend's
/// engine task calls this after each submission AND whenever the TaskStore's
/// `completion_notify` fires, so a finished background agent/bash auto-resumes
/// the conversation with its result.
pub async fn drain_background(
    client: &reqwest::Client,
    config: &Config,
    session: &mut Session,
    events: &mpsc::Sender<AgentEvent>,
    commands: &mut mpsc::Receiver<UiToCore>,
    cancel: &CancellationToken,
) {
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let notes = collect_bg_notifications(session);
        if notes.is_empty() {
            break;
        }
        resume_background(client, config, session, notes, events, commands, cancel).await;
    }
    // A finished task just lowered the running count — refresh the footer.
    let _ = events
        .send(AgentEvent::BackgroundCount(session.tasks.running_count()))
        .await;
}

/// Persist every transcript message not yet on disk (idempotent via the cursor).
fn persist_pending(session: &mut Session) {
    while session.persisted_count < session.history.len() {
        append_message(&session.session_id, &session.history[session.persisted_count]);
        session.persisted_count += 1;
    }
}

/// First-submission bootstrap: write the session meta header and inject the
/// skill + agent listing meta messages (so `build_body` can hoist them into the
/// stable cache region).
fn ensure_session_bootstrap(session: &mut Session, config: &Config) {
    if session.bootstrapped {
        return;
    }
    session.bootstrapped = true;
    let meta = SessionMeta {
        id: session.session_id.clone(),
        started_at: String::new(),
        cwd: config.cwd.to_string_lossy().into_owned(),
        model: config.model.clone(),
        title: None,
    };
    append_session_meta(&session.session_id, &meta);
    if !session.history.iter().any(is_skill_listing_message) {
        if let Some(m) = make_skill_listing_message() {
            session.history.push(m);
        }
    }
    if !session.history.iter().any(is_agent_listing_message) {
        if let Some(m) = make_agent_listing_message() {
            session.history.push(m);
        }
    }
}

/// Merge a fresh usage chunk into the running session usage (App.tsx:641-664):
/// input/output reflect the latest turn; cache hit/miss accumulate session-wide.
fn merge_session_usage(session: &mut Session, fresh: &Usage) -> Usage {
    session.cache_hit_total += fresh.prompt_cache_hit_tokens.unwrap_or(0);
    session.cache_miss_total += fresh.prompt_cache_miss_tokens.unwrap_or(0);
    let total = session.cache_hit_total + session.cache_miss_total;
    Usage {
        input_tokens: fresh.input_tokens,
        output_tokens: fresh.output_tokens,
        prompt_cache_hit_tokens: (total > 0).then_some(session.cache_hit_total),
        prompt_cache_miss_tokens: (total > 0).then_some(session.cache_miss_total),
        reasoning_tokens: fresh.reasoning_tokens,
    }
}

/// Loop continues iff the model emitted tool_calls AND finish_reason is exactly
/// "tool_calls" (a conjunction — App.tsx:1126).
fn should_continue(calls: &[ToolCall], finish_reason: Option<&str>) -> bool {
    !calls.is_empty() && finish_reason == Some("tool_calls")
}

/// First-turn pre-output abort → recall (App.tsx:1092-1108).
fn is_first_turn_recall(turn: u32, res: &StreamTurnResult) -> bool {
    turn == 1
        && res.interrupted
        && res.assistant.content.is_empty()
        && res.assistant.reasoning_content.is_none()
        && res.assistant.tool_calls.is_empty()
}

fn most_recent_non_meta_user(history: &[Message]) -> String {
    history
        .iter()
        .rev()
        .find(|m| m.role == Role::User && !m.meta)
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

/// Resolve a file/grep path argument and decide whether it escapes the workspace
/// + granted dirs. Returns (outside, grant_dir_to_offer). Port of App.tsx:1181-1211.
fn resolve_out_of_workspace(
    config: &Config,
    session_dirs: &[PathBuf],
    name: &str,
    args: &Value,
) -> (bool, Option<PathBuf>) {
    let file_path = match name {
        "read_file" | "write_file" | "edit_file" => args.get("file_path").and_then(Value::as_str).unwrap_or(""),
        "grep" => args.get("path").and_then(Value::as_str).unwrap_or(""),
        _ => "",
    };
    if file_path.is_empty() {
        return (false, None);
    }
    let cwd = lexical_resolve(&config.cwd, ".");
    let resolved = lexical_resolve(&cwd, file_path);
    // PathBuf::starts_with is component-aware, so no "/work" vs "/worktree" false positive.
    let within = resolved == cwd || resolved.starts_with(&cwd);
    let in_granted = session_dirs
        .iter()
        .any(|d| resolved == *d || resolved.starts_with(d));
    let outside = !within && !in_granted;
    // For an out-of-workspace write/edit, offer a session grant of its parent
    // dir (skip filesystem root — too broad).
    let is_edit = name == "write_file" || name == "edit_file";
    let grant_dir = if outside && is_edit {
        resolved.parent().map(PathBuf::from).filter(|p| {
            let s = p.to_string_lossy();
            !s.is_empty() && s != "/"
        })
    } else {
        None
    };
    (outside, grant_dir)
}

fn out_of_workspace_warning(grant_dir: &Option<PathBuf>) -> Option<String> {
    Some(match grant_dir {
        Some(d) => format!("This path is outside the working directory ({}).", d.display()),
        None => "This path is outside the working directory.".to_string(),
    })
}

/// Convert a tool result into the UI `ToolResultView` with a one-line tag.
fn to_result_view(name: &str, content: &str, is_error: bool) -> ToolResultView {
    ToolResultView {
        content: content.to_string(),
        is_error,
        tag: Some(result_tag(name, content, is_error)),
    }
}

fn result_tag(name: &str, content: &str, is_error: bool) -> String {
    if is_error {
        return "error".to_string();
    }
    let lines = if content.trim().is_empty() {
        0
    } else {
        content.trim().split('\n').count()
    };
    if name == "grep" || name == "glob" {
        format!("{lines} matches")
    } else {
        format!("{lines} lines")
    }
}

fn normalize_questions(args: &Value) -> Vec<Question> {
    let Some(raw) = args.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for q in raw.iter().take(4) {
        let question = q.get("question").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if question.is_empty() {
            continue;
        }
        let mut options = Vec::new();
        if let Some(opts) = q.get("options").and_then(Value::as_array) {
            for o in opts.iter().take(4) {
                let label = o.get("label").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if !label.is_empty() {
                    let description =
                        o.get("description").and_then(Value::as_str).unwrap_or("").to_string();
                    options.push(crate::contract::AskOption { label, description });
                }
            }
        }
        if options.len() < 2 {
            continue;
        }
        let header: String = q.get("header").and_then(Value::as_str).unwrap_or("").chars().take(12).collect();
        let multi_select = q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false);
        out.push(Question { header, question, options, multi_select });
    }
    out
}

fn mode_str(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Plan => "plan",
        ApprovalMode::Default => "default",
        ApprovalMode::AcceptEdits => "acceptEdits",
        ApprovalMode::Yolo => "yolo",
        ApprovalMode::Auto => "auto",
    }
}

fn max_turns_notice(cap: u64) -> String {
    format!(
        "⚠ 已达到工具调用轮数上限（{cap} 轮），任务可能尚未完成。\n\
         输入“继续”可接着执行；或在 ~/.deepdive/settings.json 的 \
         env.DEEPSEEK_MAX_TURNS 调高/删除该项以放宽或取消上限。"
    )
}

fn bg_limit_error() -> String {
    format!(
        "Error: too many background tasks already running (max {MAX_BACKGROUND_TASKS}). \
         Wait for some to finish or stop one with task_stop."
    )
}

fn bg_bash_ack(task_id: &str, command: &str) -> String {
    format!(
        "Launched background command — task_id: {task_id}\n\
         Command: {command}\n\
         It runs in the background and you'll be AUTOMATICALLY resumed when it exits. \
         Do NOT poll task_output to wait. Continue with other work, or if you have \
         nothing else to do, END YOUR TURN — you'll be brought back when it's done. \
         (task_stop(\"{task_id}\") kills it.)"
    )
}

fn bg_agent_ack(task_id: &str, agent_type: &str, desc: &str) -> String {
    format!(
        "Launched background agent — task_id: {task_id} ({agent_type})\n\
         Task: {desc}\n\
         It runs in the background and you'll be AUTOMATICALLY resumed with its result \
         when it finishes. Do NOT poll task_output to wait. Continue with other work now, \
         or if you have nothing else to do, END YOUR TURN — you'll be brought back when \
         it's done. (task_stop(\"{task_id}\") cancels it.)"
    )
}

#[cfg(test)]
mod interactive_tests {
    use super::*;
    use crate::types::FunctionCall;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    fn cfg(cwd: &str) -> Config {
        Config {
            cwd: PathBuf::from(cwd),
            ..Default::default()
        }
    }
    fn call(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.to_string(),
            },
        }
    }
    fn turn_res(content: &str, reasoning: Option<&str>, interrupted: bool, calls: Vec<ToolCall>) -> StreamTurnResult {
        let mut m = Message::assistant(content);
        m.reasoning_content = reasoning.map(String::from);
        m.tool_calls = calls;
        m.interrupted = interrupted;
        StreamTurnResult {
            assistant: m,
            finish_reason: None,
            usage: None,
            interrupted,
        }
    }

    // ── pure predicates ──────────────────────────────────────────────────────

    #[test]
    fn add_session_dir_grants_and_injects_meta_once() {
        let mut session = Session::new(&cfg("/work"));
        let before = session.history.len();
        add_session_dir(&mut session, "/work/extra");
        assert_eq!(session.session_dirs.len(), 1);
        assert_eq!(session.history.len(), before + 1);
        let m = session.history.last().unwrap();
        assert!(m.meta);
        assert!(m.content.contains("Additional working directory added"));
        assert!(m.content.contains("/work/extra"));
        // Idempotent: re-adding grants nothing and injects no second message.
        add_session_dir(&mut session, "/work/extra");
        assert_eq!(session.session_dirs.len(), 1);
        assert_eq!(session.history.len(), before + 1);
    }

    #[test]
    fn reload_agent_listing_leaves_exactly_one_listing() {
        let mut session = Session::new(&cfg("/work"));
        reload_agent_listing(&mut session);
        let n = session
            .history
            .iter()
            .filter(|m| is_agent_listing_message(m))
            .count();
        assert_eq!(n, 1);
        // Re-running drops the stale one and re-injects — still exactly one.
        reload_agent_listing(&mut session);
        let n2 = session
            .history
            .iter()
            .filter(|m| is_agent_listing_message(m))
            .count();
        assert_eq!(n2, 1);
    }

    #[test]
    fn should_continue_is_a_conjunction() {
        let calls = vec![call("c1", "bash", json!({}))];
        assert!(should_continue(&calls, Some("tool_calls")));
        assert!(!should_continue(&calls, Some("stop"))); // tool_calls but wrong finish
        assert!(!should_continue(&[], Some("tool_calls"))); // finish but no calls
        assert!(!should_continue(&calls, None));
    }

    #[test]
    fn recall_predicate_requires_every_conjunct() {
        // all-empty first-turn abort → recall
        assert!(is_first_turn_recall(1, &turn_res("", None, true, vec![])));
        // not turn 1
        assert!(!is_first_turn_recall(2, &turn_res("", None, true, vec![])));
        // not interrupted
        assert!(!is_first_turn_recall(1, &turn_res("", None, false, vec![])));
        // has content
        assert!(!is_first_turn_recall(1, &turn_res("hi", None, true, vec![])));
        // has reasoning
        assert!(!is_first_turn_recall(1, &turn_res("", Some("because"), true, vec![])));
        // has tool calls
        assert!(!is_first_turn_recall(1, &turn_res("", None, true, vec![call("c1", "bash", json!({}))])));
    }

    #[test]
    fn compact_decision_threshold_and_breaker() {
        let u = |t: u64| Usage { input_tokens: t, ..Default::default() };
        // cw=100 → threshold 80 (strict >)
        assert_eq!(compact_decision(Some(&u(80)), 100, false, None), CompactDecision::Skip);
        assert_eq!(compact_decision(Some(&u(81)), 100, false, None), CompactDecision::Compact);
        // disabled / cw=0 / no usage → skip
        assert_eq!(compact_decision(Some(&u(999)), 100, true, None), CompactDecision::Skip);
        assert_eq!(compact_decision(Some(&u(999)), 0, false, None), CompactDecision::Skip);
        assert_eq!(compact_decision(None, 100, false, None), CompactDecision::Skip);
        // breaker: prev=100 → prev*0.8=80; 81 > 80 → disable
        assert_eq!(compact_decision(Some(&u(81)), 100, false, Some(100)), CompactDecision::Disable);
        // breaker satisfied: prev=200 → 160; 81 <= 160 → compact
        assert_eq!(compact_decision(Some(&u(81)), 100, false, Some(200)), CompactDecision::Compact);
    }

    #[test]
    fn merge_usage_keeps_turn_io_and_accumulates_cache() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        let f1 = Usage {
            input_tokens: 10,
            output_tokens: 5,
            prompt_cache_hit_tokens: Some(3),
            prompt_cache_miss_tokens: Some(7),
            ..Default::default()
        };
        let m1 = merge_session_usage(&mut s, &f1);
        assert_eq!(m1.input_tokens, 10);
        assert_eq!(m1.prompt_cache_hit_tokens, Some(3));
        let f2 = Usage {
            input_tokens: 20,
            output_tokens: 8,
            prompt_cache_hit_tokens: Some(4),
            prompt_cache_miss_tokens: Some(6),
            ..Default::default()
        };
        let m2 = merge_session_usage(&mut s, &f2);
        assert_eq!(m2.input_tokens, 20); // latest turn's I/O
        assert_eq!(m2.prompt_cache_hit_tokens, Some(7)); // 3+4 cumulative
        assert_eq!(m2.prompt_cache_miss_tokens, Some(13)); // 7+6
    }

    #[test]
    fn result_view_tags_lines_matches_errors() {
        assert_eq!(to_result_view("grep", "a.rs:1\nb.rs:2", false).tag.as_deref(), Some("2 matches"));
        assert_eq!(to_result_view("read_file", "l1\nl2\nl3", false).tag.as_deref(), Some("3 lines"));
        let v = to_result_view("bash", "Error: boom", true);
        assert!(v.is_error);
        assert_eq!(v.tag.as_deref(), Some("error"));
    }

    #[test]
    fn out_of_workspace_boundary_is_component_aware() {
        let c = cfg("/work");
        assert!(!resolve_out_of_workspace(&c, &[], "read_file", &json!({"file_path":"src/a.rs"})).0);
        assert!(resolve_out_of_workspace(&c, &[], "read_file", &json!({"file_path":"/etc/passwd"})).0);
        // sibling sharing a string prefix is NOT inside
        assert!(resolve_out_of_workspace(&c, &[], "read_file", &json!({"file_path":"/worktree/x"})).0);
        // granted dir is inside
        assert!(!resolve_out_of_workspace(&c, &[PathBuf::from("/data")], "read_file", &json!({"file_path":"/data/x"})).0);
        // out-of-workspace edit offers its parent dir
        let (out, gd) = resolve_out_of_workspace(&c, &[], "write_file", &json!({"file_path":"/tmp/sub/a.txt"}));
        assert!(out);
        assert_eq!(gd, Some(PathBuf::from("/tmp/sub")));
        // non-file tool never triggers the path check
        assert!(!resolve_out_of_workspace(&c, &[], "bash", &json!({"command":"ls"})).0);
    }

    #[test]
    fn normalize_questions_filters_invalid() {
        let args = json!({"questions":[
            {"question":"Pick one","header":"choice","options":[{"label":"A","description":"first"},{"label":"B"}],"multiSelect":true},
            {"question":"","options":[{"label":"X"},{"label":"Y"}]},
            {"question":"too few","options":[{"label":"Z"}]},
        ]});
        let qs = normalize_questions(&args);
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].question, "Pick one");
        let labels: Vec<&str> = qs[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec!["A", "B"]);
        assert_eq!(qs[0].options[0].description, "first");
        assert_eq!(qs[0].options[1].description, "");
        assert!(qs[0].multi_select);
        assert!(normalize_questions(&json!({})).is_empty());
    }

    #[test]
    fn session_seeds_and_adds_grant_dirs() {
        // Persisted additionalDirectories must seed the session grant list…
        let mut c = cfg("/work");
        c.additional_directories = vec!["/extra".into()];
        let mut s = Session::new(&c);
        assert!(s.session_dirs.contains(&PathBuf::from("/extra")));
        // …and an out-of-workspace path under a granted dir is NOT flagged.
        let (outside, _) = resolve_out_of_workspace(
            &c, &s.session_dirs, "read_file", &json!({"file_path": "/extra/a.txt"}),
        );
        assert!(!outside);
        // /add-dir adds another (idempotently).
        add_session_dir(&mut s, "/more");
        add_session_dir(&mut s, "/more");
        assert_eq!(s.session_dirs.iter().filter(|d| *d == &PathBuf::from("/more")).count(), 1);
        let (outside2, _) = resolve_out_of_workspace(
            &c, &s.session_dirs, "write_file", &json!({"file_path": "/more/b.txt"}),
        );
        assert!(!outside2);
    }

    // ── gate ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn gate_deny_rule_stubs_without_prompt() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Default;
        s.permissions.deny = vec!["Bash(rm:*)".into()];
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let out = gate_tool_interactive(&client, &c, &mut s, "bash", &json!({"command":"rm -rf x"}), "", &tx, &cancel).await;
        assert_eq!(out, GateOutcome::Stub("Error: User denied the tool execution.".into()));
        assert!(rx.try_recv().is_err()); // no ApprovalRequest emitted
    }

    #[tokio::test]
    async fn gate_allow_rule_proceeds_silently() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Default;
        s.permissions.allow = vec!["Bash(npm test:*)".into()];
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let out = gate_tool_interactive(&client, &c, &mut s, "bash", &json!({"command":"npm test"}), "", &tx, &cancel).await;
        assert_eq!(out, GateOutcome::Proceed);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn gate_prompt_approve_proceeds() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Default;
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let ui = tokio::spawn(async move {
            if let Some(AgentEvent::ApprovalRequest { reply, .. }) = rx.recv().await {
                let _ = reply.send(ApprovalDecision::Approve);
            }
        });
        let out = gate_tool_interactive(&client, &c, &mut s, "write_file", &json!({"file_path":"a.txt","content":"x"}), "", &tx, &cancel).await;
        assert_eq!(out, GateOutcome::Proceed);
        ui.await.unwrap();
    }

    #[tokio::test]
    async fn gate_abort_resolves_deny_without_hang() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Default;
        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        cancel.cancel(); // pre-cancelled
        let client = crate::client::http_client();
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            gate_tool_interactive(&client, &c, &mut s, "write_file", &json!({"file_path":"a.txt"}), "", &tx, &cancel),
        )
        .await
        .expect("gate must not hang on abort");
        assert!(matches!(out, GateOutcome::Stub(_)));
    }

    #[tokio::test]
    async fn gate_auto_readonly_outside_autoapproves() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Auto;
        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let out = gate_tool_interactive(&client, &c, &mut s, "read_file", &json!({"file_path":"/etc/hosts"}), "", &tx, &cancel).await;
        assert_eq!(out, GateOutcome::Proceed);
        assert!(rx.try_recv().is_err());
    }

    // ── tool batch ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn tool_batch_denial_cascades_and_maps_one_to_one() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Default;
        s.permissions.deny = vec!["Bash(rm:*)".into()];
        let (tx, mut rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let calls = vec![
            call("c1", "bash", json!({"command":"rm -rf x"})),
            call("c2", "read_file", json!({"file_path":"a.txt"})),
        ];
        let (results, denied) = run_tool_batch(&client, &c, &mut s, &calls, &tx, &cancel).await;
        assert!(denied);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(results[1].tool_call_id.as_deref(), Some("c2"));
        assert!(results[1].content.contains("User denied"));
        let mut saw_approval = false;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, AgentEvent::ApprovalRequest { .. }) {
                saw_approval = true;
            }
        }
        assert!(!saw_approval); // deny rule short-circuits the prompt
    }

    #[tokio::test]
    async fn tool_batch_executes_fs_tool_in_yolo() {
        let dir = std::env::temp_dir().join(format!("deepdive-batch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hello.txt"), "line1\nline2\n").unwrap();
        let c = cfg(dir.to_str().unwrap());
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Yolo;
        let (tx, _rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let calls = vec![call("c1", "read_file", json!({"file_path":"hello.txt"}))];
        let (results, denied) = run_tool_batch(&client, &c, &mut s, &calls, &tx, &cancel).await;
        assert!(!denied);
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("line1"));
    }

    #[tokio::test]
    async fn tool_batch_parse_failure_still_yields_one_result() {
        let c = cfg("/tmp");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Yolo;
        let (tx, _rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let mut bad = call("c1", "read_file", json!({}));
        bad.function.arguments = "{not json".into();
        let (results, _denied) = run_tool_batch(&client, &c, &mut s, &[bad], &tx, &cancel).await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_call_id.as_deref(), Some("c1"));
    }

    #[tokio::test]
    async fn skill_bypasses_gates_in_plan_mode() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        s.mode = ApprovalMode::Plan;
        let (tx, _rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let client = crate::client::http_client();
        let calls = vec![call("c1", "skill", json!({"name":"__nope__","args":""}))];
        let (results, denied) = run_tool_batch(&client, &c, &mut s, &calls, &tx, &cancel).await;
        assert!(!denied);
        assert_eq!(results.len(), 1);
        // reached skill resolution (bypassed the plan-mode tool gate)
        assert!(!results[0].content.contains("not available in plan mode"));
    }

    // ── background tasks ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn task_output_poll_budget_resets_per_turn() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        let id = s.tasks.generate_id(BgTaskKind::Bash);
        s.tasks.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Bash,
            description: "x".into(),
            agent_type: None,
            command: Some("sleep 9".into()),
            abort: Arc::new(|| {}),
        });
        let _ = task_output(&mut s, &json!({"task_id": id}));
        let _ = task_output(&mut s, &json!({"task_id": id}));
        let (b3, _) = task_output(&mut s, &json!({"task_id": id}));
        assert!(b3.contains("STOP calling task_output"));
        s.task_poll_counts.clear(); // new turn
        let (b4, _) = task_output(&mut s, &json!({"task_id": id}));
        assert!(!b4.contains("STOP"));
    }

    #[tokio::test]
    async fn task_stop_aborts_and_marks_killed() {
        let c = cfg("/work");
        let mut s = Session::new(&c);
        let id = s.tasks.generate_id(BgTaskKind::Bash);
        let killed = Arc::new(AtomicBool::new(false));
        let k2 = killed.clone();
        s.tasks.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Bash,
            description: "x".into(),
            agent_type: None,
            command: Some("sleep 9".into()),
            abort: Arc::new(move || k2.store(true, Ordering::SeqCst)),
        });
        let (msg, err) = task_stop(&mut s, &json!({"task_id": id}));
        assert!(!err);
        assert!(msg.contains("Stopped"));
        assert!(killed.load(Ordering::SeqCst));
        assert!(is_terminal_bg_status(s.tasks.get(&id).unwrap().status));
    }

    #[tokio::test]
    async fn collect_bg_notifications_once_per_finished_task() {
        let c = cfg("/work");
        let s = Session::new(&c);
        let id = s.tasks.generate_id(BgTaskKind::Agent);
        s.tasks.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Agent,
            description: "research".into(),
            agent_type: Some("general-purpose".into()),
            command: None,
            abort: Arc::new(|| {}),
        });
        // Still running → nothing to surface.
        assert!(collect_bg_notifications(&s).is_empty());
        s.tasks.finish(
            &id,
            BgTaskResult {
                status: BgTaskStatus::Completed,
                result: "found it".into(),
                is_error: false,
                turns: Some(2),
                tool_calls: Some(3),
            },
        );
        // Finished + unnotified → exactly one notification message…
        let notes = collect_bg_notifications(&s);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].meta);
        // …and it is marked notified, so a second drain is empty (no re-resume).
        assert!(collect_bg_notifications(&s).is_empty());
    }

    #[tokio::test]
    async fn ask_question_declines_on_abort_and_rejects_empty() {
        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (out, err) = ask_user_question(
            &json!({"questions":[{"question":"Q","options":[{"label":"A"},{"label":"B"}]}]}),
            &tx,
            &cancel,
        )
        .await;
        assert!(!err);
        assert!(out.contains("declined"));

        let (tx2, _rx2) = mpsc::channel(8);
        let cancel2 = CancellationToken::new();
        let (out2, err2) = ask_user_question(&json!({"questions":[]}), &tx2, &cancel2).await;
        assert!(err2);
        assert!(out2.contains("no valid questions"));
    }
}
