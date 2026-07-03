//! One streamed model round-trip, with no UI coupling. Faithful port of
//! `src/turn.ts` `streamTurn`, restructured to consume any
//! `Stream<Item = Result<StreamChunk>>` so it is unit-testable with canned
//! chunks (no network) — the basis of the replay-cassette parity strategy.
//!
//! Accumulates text/thinking, assembles tool-call deltas by `index`
//! (`BTreeMap` preserves order), breaks on `finish_reason`, and on cancellation
//! preserves whatever streamed so far as an `interrupted` assistant message
//! (dropping any half-assembled tool_calls to keep the message API-valid).

use crate::types::{FunctionCall, Message, Role, StreamChunk, ToolCall, Usage};
use futures_util::{Stream, StreamExt};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct StreamTurnResult {
    /// The assembled assistant message. `usage` is intentionally not stamped —
    /// the caller owns usage accounting (matches turn.ts).
    pub assistant: Message,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
    pub interrupted: bool,
}

/// Partial tool call accumulated across deltas: (id, name, arguments).
#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

pub async fn assemble_turn<S>(
    stream: S,
    cancel: &CancellationToken,
    mut on_thinking: impl FnMut(&str),
    mut on_content: impl FnMut(&str),
) -> anyhow::Result<StreamTurnResult>
where
    S: Stream<Item = anyhow::Result<StreamChunk>>,
{
    futures_util::pin_mut!(stream);

    let mut full_content = String::new();
    let mut full_thinking = String::new();
    let mut last_usage: Option<Usage> = None;
    let mut finish_reason: Option<String> = None;
    let mut by_index: BTreeMap<usize, PartialCall> = BTreeMap::new();
    let mut interrupted = false;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                interrupted = true;
                break;
            }
            item = stream.next() => {
                let Some(item) = item else { break };
                let chunk = match item {
                    Ok(c) => c,
                    Err(e) => {
                        // A user abort can surface as a transport error; treat
                        // it as an interruption (turn.ts swallows AbortError).
                        if cancel.is_cancelled() {
                            interrupted = true;
                            break;
                        }
                        return Err(e);
                    }
                };

                if !chunk.reasoning_content.is_empty() {
                    full_thinking.push_str(&chunk.reasoning_content);
                    on_thinking(&full_thinking);
                }
                if !chunk.content.is_empty() {
                    full_content.push_str(&chunk.content);
                    on_content(&full_content);
                }

                for delta in &chunk.tool_calls {
                    let entry = by_index.entry(delta.index).or_default();
                    if let Some(id) = &delta.id {
                        if !id.is_empty() {
                            entry.id = id.clone();
                        }
                    }
                    if let Some(func) = &delta.function {
                        if let Some(name) = &func.name {
                            if !name.is_empty() {
                                entry.name = name.clone();
                            }
                        }
                        if let Some(args) = &func.arguments {
                            if !args.is_empty() {
                                entry.args.push_str(args);
                            }
                        }
                    }
                }

                if let Some(u) = chunk.usage {
                    last_usage = Some(u);
                }
                if let Some(fr) = chunk.finish_reason {
                    finish_reason = Some(fr);
                    break;
                }
            }
        }
    }

    let tool_calls: Vec<ToolCall> = by_index
        .into_values()
        .map(|p| ToolCall {
            id: p.id,
            kind: "function".into(),
            function: FunctionCall {
                name: p.name,
                arguments: p.args,
            },
        })
        .collect();

    let mut assistant = Message::assistant(full_content);
    assistant.role = Role::Assistant;
    assistant.reasoning_content = if full_thinking.is_empty() {
        None
    } else {
        Some(full_thinking)
    };
    // A mid-stream abort can leave tool_calls half-assembled with no results to
    // follow. Drop them so the message stays API-valid and the loop stops at
    // the no-tool-calls check (turn.ts:119-123).
    assistant.tool_calls = if interrupted || tool_calls.is_empty() {
        Vec::new()
    } else {
        tool_calls
    };
    assistant.interrupted = interrupted;

    Ok(StreamTurnResult {
        assistant,
        finish_reason,
        usage: last_usage,
        interrupted,
    })
}

/// Run one full turn end to end: build + stream the DeepSeek request, then
/// assemble the assistant message. The shared primitive behind the subagent
/// loop and (P2) the interactive loop. `overrides` scopes tools / persona.
pub async fn stream_turn(
    client: &reqwest::Client,
    config: &crate::config::Config,
    history: &[Message],
    cancel: &CancellationToken,
    overrides: crate::client::ChatOverrides,
    on_thinking: impl FnMut(&str),
    on_content: impl FnMut(&str),
) -> anyhow::Result<StreamTurnResult> {
    let stream = crate::client::chat(
        client.clone(),
        config.clone(),
        history.to_vec(),
        cancel.clone(),
        overrides,
    );
    assemble_turn(stream, cancel, on_thinking, on_content).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FunctionDelta, ToolCallDelta};

    fn content_chunk(s: &str) -> StreamChunk {
        StreamChunk {
            content: s.into(),
            ..Default::default()
        }
    }

    fn noop(_: &str) {}

    #[tokio::test]
    async fn accumulates_content_and_breaks_on_finish() {
        let chunks = vec![
            Ok(content_chunk("Hel")),
            Ok(content_chunk("lo")),
            Ok(StreamChunk {
                finish_reason: Some("stop".into()),
                ..Default::default()
            }),
            // This one must never be consumed (loop breaks on finish_reason).
            Ok(content_chunk(" IGNORED")),
        ];
        let stream = futures_util::stream::iter(chunks);
        let cancel = CancellationToken::new();
        let r = assemble_turn(stream, &cancel, noop, noop).await.unwrap();
        assert_eq!(r.assistant.content, "Hello");
        assert_eq!(r.finish_reason.as_deref(), Some("stop"));
        assert!(!r.interrupted);
        assert!(r.assistant.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn assembles_tool_call_across_deltas() {
        let mk = |id: Option<&str>, name: Option<&str>, args: Option<&str>| StreamChunk {
            tool_calls: vec![ToolCallDelta {
                index: 0,
                id: id.map(String::from),
                function: Some(FunctionDelta {
                    name: name.map(String::from),
                    arguments: args.map(String::from),
                }),
            }],
            ..Default::default()
        };
        let chunks = vec![
            Ok(mk(Some("call_1"), Some("read_file"), Some("{\"path\":"))),
            Ok(mk(None, None, Some("\"a.txt\"}"))),
            Ok(StreamChunk {
                finish_reason: Some("tool_calls".into()),
                ..Default::default()
            }),
        ];
        let stream = futures_util::stream::iter(chunks);
        let cancel = CancellationToken::new();
        let r = assemble_turn(stream, &cancel, noop, noop).await.unwrap();
        assert_eq!(r.assistant.tool_calls.len(), 1);
        let tc = &r.assistant.tool_calls[0];
        assert_eq!(tc.id, "call_1");
        assert_eq!(tc.function.name, "read_file");
        assert_eq!(tc.function.arguments, r#"{"path":"a.txt"}"#);
    }

    #[tokio::test]
    async fn cancellation_preserves_partial_and_drops_toolcalls() {
        let cancel = CancellationToken::new();
        cancel.cancel(); // pre-cancelled: the cancel branch wins immediately
        let chunks = vec![Ok(content_chunk("partial"))];
        let stream = futures_util::stream::iter(chunks);
        let r = assemble_turn(stream, &cancel, noop, noop).await.unwrap();
        assert!(r.interrupted);
        assert!(r.assistant.interrupted);
        // No content consumed because cancellation fired first (biased select).
        assert!(r.assistant.tool_calls.is_empty());
    }

    #[tokio::test]
    async fn propagates_non_cancel_errors() {
        let chunks: Vec<anyhow::Result<StreamChunk>> =
            vec![Ok(content_chunk("x")), Err(anyhow::anyhow!("boom"))];
        let stream = futures_util::stream::iter(chunks);
        let cancel = CancellationToken::new();
        let err = assemble_turn(stream, &cancel, noop, noop)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("boom"));
    }
}
