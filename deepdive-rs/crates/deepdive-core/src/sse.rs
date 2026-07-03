//! Incremental SSE decoder — faithful port of the byte → line → JSON pipeline
//! in client.ts `chat()`.
//!
//! The TS code does `buffer += decoder.decode(value, {stream:true});
//! lines = buffer.split("\n"); buffer = lines.pop()`. We replicate both layers:
//!  - **UTF-8 layer**: a multibyte character can be split across two TCP chunks,
//!    so we keep a byte buffer and only hand the longest valid-UTF-8 prefix to
//!    the line buffer (TextDecoder's `{stream:true}` behavior).
//!  - **line layer**: accumulate text, split on '\n', retain the trailing
//!    partial line for the next feed.
//!
//! `[DONE]` is skipped; malformed JSON lines are ignored (matches TS `catch`).

use crate::types::{FunctionDelta, StreamChunk, ToolCallDelta, Usage};
use serde_json::Value;

#[derive(Default)]
pub struct SseDecoder {
    /// Trailing bytes of an incomplete UTF-8 sequence, carried to next feed.
    byte_buf: Vec<u8>,
    /// Trailing text of an incomplete line, carried to next feed.
    line_buf: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of raw bytes; returns parsed chunks for every complete
    /// `data:` line that became available.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<StreamChunk> {
        self.byte_buf.extend_from_slice(bytes);
        // Decode the longest valid UTF-8 prefix; keep any partial tail bytes.
        let valid = match std::str::from_utf8(&self.byte_buf) {
            Ok(s) => {
                self.line_buf.push_str(s);
                self.byte_buf.len()
            }
            Err(e) => {
                let v = e.valid_up_to();
                // SAFETY: bytes[..v] are valid UTF-8 by `valid_up_to`'s contract.
                self.line_buf
                    .push_str(unsafe { std::str::from_utf8_unchecked(&self.byte_buf[..v]) });
                v
            }
        };
        self.byte_buf.drain(..valid);

        let mut out = Vec::new();
        while let Some(nl) = self.line_buf.find('\n') {
            let line: String = self.line_buf.drain(..=nl).collect();
            // strip the trailing '\n' (1 byte, ASCII) then trim whitespace
            if let Some(chunk) = parse_sse_line(line[..line.len() - 1].trim()) {
                out.push(chunk);
            }
        }
        out
    }
}

fn parse_sse_line(trimmed: &str) -> Option<StreamChunk> {
    if trimmed.is_empty() || !trimmed.starts_with("data: ") {
        return None;
    }
    let data = &trimmed["data: ".len()..];
    if data == "[DONE]" {
        return None;
    }
    let parsed: Value = serde_json::from_str(data).ok()?;
    let choice = parsed.get("choices")?.get(0)?;
    // Matches TS `if (!delta) continue;` — skip lines without a delta object.
    let delta = choice.get("delta")?;

    Some(StreamChunk {
        content: delta
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        reasoning_content: delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        tool_calls: parse_tool_call_deltas(delta.get("tool_calls")),
        // TS: `finish_reason || null` — empty string folds to None.
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        usage: parse_usage(parsed.get("usage")),
    })
}

fn parse_tool_call_deltas(raw: Option<&Value>) -> Vec<ToolCallDelta> {
    let Some(Value::Array(arr)) = raw else {
        return Vec::new();
    };
    arr.iter()
        .map(|tc| ToolCallDelta {
            index: tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
            id: tc.get("id").and_then(Value::as_str).map(str::to_string),
            function: tc.get("function").map(|f| FunctionDelta {
                name: f.get("name").and_then(Value::as_str).map(str::to_string),
                arguments: f
                    .get("arguments")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }),
        })
        .collect()
}

fn parse_usage(raw: Option<&Value>) -> Option<Usage> {
    let raw = raw?;
    if !raw.is_object() {
        return None;
    }
    let g = |k: &str| raw.get(k).and_then(Value::as_u64);
    Some(Usage {
        input_tokens: g("prompt_tokens")
            .or_else(|| g("input_tokens"))
            .unwrap_or(0),
        output_tokens: g("completion_tokens")
            .or_else(|| g("output_tokens"))
            .unwrap_or(0),
        prompt_cache_hit_tokens: g("prompt_cache_hit_tokens"),
        prompt_cache_miss_tokens: g("prompt_cache_miss_tokens"),
        reasoning_tokens: raw
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_line(json: &str) -> Vec<u8> {
        format!("data: {json}\n\n").into_bytes()
    }

    #[test]
    fn parses_a_content_delta() {
        let mut d = SseDecoder::new();
        let out = d.feed(&data_line(r#"{"choices":[{"delta":{"content":"Hello"}}]}"#));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "Hello");
        assert_eq!(out[0].reasoning_content, "");
        assert!(out[0].finish_reason.is_none());
    }

    #[test]
    fn skips_done_and_blank_and_malformed() {
        let mut d = SseDecoder::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\n");
        bytes.extend_from_slice(b"data: [DONE]\n");
        bytes.extend_from_slice(b"data: {not json}\n");
        bytes.extend_from_slice(b": comment line\n");
        let out = d.feed(&bytes);
        assert!(out.is_empty(), "got {out:?}");
    }

    #[test]
    fn reassembles_a_line_split_across_feeds() {
        let mut d = SseDecoder::new();
        let full = data_line(r#"{"choices":[{"delta":{"content":"world"}}]}"#);
        let (a, b) = full.split_at(15); // mid-line split
        assert!(d.feed(a).is_empty());
        let out = d.feed(b);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "world");
    }

    #[test]
    fn reassembles_a_multibyte_char_split_across_feeds() {
        // "你好" — each char is 3 bytes; split the first char down the middle.
        let line = format!(
            "data: {}\n",
            r#"{"choices":[{"delta":{"content":"你好"}}]}"#
        );
        let bytes = line.into_bytes();
        // find the content bytes region; just split at an arbitrary index that
        // lands inside a multibyte sequence by scanning for the first non-ASCII.
        let split = bytes.iter().position(|&b| b >= 0x80).unwrap() + 1;
        let mut d = SseDecoder::new();
        let first = d.feed(&bytes[..split]);
        assert!(
            first.is_empty(),
            "partial char must not surface a chunk yet"
        );
        let out = d.feed(&bytes[split..]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "你好");
    }

    #[test]
    fn accumulates_tool_call_delta_fields() {
        let mut d = SseDecoder::new();
        let out = d.feed(&data_line(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#,
        ));
        assert_eq!(out.len(), 1);
        let tc = &out[0].tool_calls[0];
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("call_1"));
        let f = tc.function.as_ref().unwrap();
        assert_eq!(f.name.as_deref(), Some("read_file"));
        assert_eq!(f.arguments.as_deref(), Some(r#"{"pa"#));
    }

    #[test]
    fn parses_finish_reason_and_usage() {
        let mut d = SseDecoder::new();
        let out = d.feed(&data_line(
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":34,"prompt_cache_hit_tokens":8,"completion_tokens_details":{"reasoning_tokens":5}}}"#,
        ));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].finish_reason.as_deref(), Some("stop"));
        let u = out[0].usage.as_ref().unwrap();
        assert_eq!(u.input_tokens, 12);
        assert_eq!(u.output_tokens, 34);
        assert_eq!(u.prompt_cache_hit_tokens, Some(8));
        assert_eq!(u.reasoning_tokens, Some(5));
    }

    #[test]
    fn multiple_data_lines_in_one_feed() {
        let mut d = SseDecoder::new();
        let mut bytes = data_line(r#"{"choices":[{"delta":{"content":"a"}}]}"#);
        bytes.extend(data_line(r#"{"choices":[{"delta":{"content":"b"}}]}"#));
        let out = d.feed(&bytes);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].content, "a");
        assert_eq!(out[1].content, "b");
    }
}
