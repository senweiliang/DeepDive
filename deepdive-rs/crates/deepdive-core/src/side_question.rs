//! Port of `src/side-question.ts` — "/btw": a side question thread answered
//! by an independent fork that never touches the main session state. A few
//! quick follow-ups are allowed in the same thread (upstream Claude Code caps
//! this at one turn; `prior_exchanges` is what lets this go further).

use crate::client::ChatOverrides;
use crate::config::Config;
use crate::turn::stream_turn;
use crate::types::Message;
use tokio_util::sync::CancellationToken;

const SIDE_QUESTION_REMINDER: &str = "<system-reminder>This is a side question from the user, started with /btw. Answer directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question.
- The main agent is NOT interrupted — it keeps working independently in the background.
- You share the conversation context but are a completely separate instance.
- Do NOT reference being interrupted or what you were \"previously doing\" — that framing is incorrect.

CONSTRAINTS:
- You have NO tools available. Even if the tool list below appears in the schema, they are blocked.
  If asked whether you can read files, search, or execute commands, the answer is \"no\" for this
  side question — answer only from what you already know from the conversation context.
- This is a one-off response — there will be no follow-up turns.
- Never say things like \"Let me check...\", \"I'll look into...\", or promise to take any action.
- If you don't know the answer, say so directly — do not offer to investigate.</system-reminder>";

/// `main_history` should be the current session history (bootstrapped — same
/// shape the main loop would send next). `build_body` is a pure function of
/// (config, messages), so an unmodified prefix reproduces the exact bytes of
/// whatever the main loop last sent (or is currently sending), riding the same
/// DeepSeek prefix cache for free — no explicit "last request params" snapshot
/// needed, unlike Claude Code's original /btw.
///
/// `prior_exchanges` are this side thread's own already-answered turns (plain
/// user/assistant message pairs, no reminder) — appended after `main_history`
/// so later follow-ups share the cache built by earlier ones. The reminder is
/// only prepended to the FIRST question in the thread (`prior_exchanges`
/// empty); by the time a follow-up arrives the model has already seen the
/// ground rules.
///
/// Tools are left at their default (not stripped) for the same cache-safety
/// reason; the reminder tells the model not to call them, and any tool_calls
/// it makes anyway are reported, never executed.
pub async fn run_side_question(
    client: &reqwest::Client,
    config: &Config,
    main_history: &[Message],
    prior_exchanges: &[Message],
    question: &str,
    cancel: &CancellationToken,
) -> anyhow::Result<Option<String>> {
    let content = if prior_exchanges.is_empty() {
        format!("{SIDE_QUESTION_REMINDER}\n\n{question}")
    } else {
        question.to_string()
    };
    let wrapped = Message::user(content);

    let mut combined = main_history.to_vec();
    combined.extend_from_slice(prior_exchanges);
    combined.push(wrapped);

    let result = stream_turn(
        client,
        config,
        &combined,
        cancel,
        ChatOverrides::default(),
        |_| {},
        |_| {},
    )
    .await?;

    if result.interrupted {
        return Ok(None);
    }

    let text = result.assistant.content.trim();
    if !text.is_empty() {
        return Ok(Some(text.to_string()));
    }

    if let Some(tc) = result.assistant.tool_calls.first() {
        return Ok(Some(format!(
            "(The model tried to call `{}` instead of answering directly. Try rephrasing, or ask in the main conversation.)",
            tc.function.name
        )));
    }

    Ok(None)
}
