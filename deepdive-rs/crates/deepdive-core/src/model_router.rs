//! Model router — faithful port of `src/tools/model-router.ts`.
//!
//! Uses `deepseek-v4-flash` (no thinking) to classify a user message as "pro"
//! or "flash", so the agent can automatically pick the right model when
//! `config.model == "auto"` without the user manually switching.
//!
//! The KV cache is NOT shared between this classifier call and the main
//! conversation (different system prompts), so the input is kept minimal: only
//! the current user message — no history. Every failure path (network / non-2xx
//! / parse / unknown verdict) falls back to Pro, matching the TS original.

use crate::config::Config;
use serde_json::Value;

const ROUTER_PROMPT: &str = r#"You are a model router. Given the user's message, choose which model should handle this request.

Respond with exactly one line in the format:

<model> | <brief reason>

Where <model> is one of: pro, flash.

## Use "flash" when:
- Reading or searching code (read_file, grep, glob)
- Simple questions about how code works
- Web searches or fetching URLs
- Casual conversation, clarifications, or planning
- Quick lookups or one-step operations
- Simple configuration changes, one-line edits, or trivial string changes
- Changing a default value, renaming a config key, or updating a constant
- Running standard project commands (build, test, lint, typecheck, install, format)
- Routine git operations (status, log, diff, add, commit, push)
- Any well-defined, deterministic command whose outcome is predictable

## Use "pro" when:
- Writing, editing, or refactoring complex code
- Debugging complex issues or analyzing runtime errors
- Architecture or design decisions
- Implementing new features or significant changes
- Tasks requiring deep reasoning or multi-step analysis across files
- Ambiguous or open-ended problems where the right approach isn't obvious

## Examples
Refactor the auth module to use JWT → pro | refactoring complex code
Read the config file and tell me what models are available → flash | simple read
Fix the rate limiting bug in the API handler → pro | debugging complex issue
What does the .gitignore look like? → flash | simple file read
Search for all uses of useCallback in src/ → flash | code search
Implement OAuth2 login flow → pro | implementing new feature
Run pnpm typecheck → flash | standard project command
ls -la → flash | deterministic command
git log --oneline → flash | routine git operation
git push origin master → flash | routine git operation
Debug why the CI pipeline failed → pro | debugging complex issue
What version of React are we using? → flash | simple question
Change the default model from pro to auto → flash | simple configuration change

Output only one line: <model> | <reason>."#;

/// Which model the router picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRoute {
    Pro,
    Flash,
}

impl ModelRoute {
    /// The concrete API model id (`deepseek-v4-pro` / `deepseek-v4-flash`).
    pub fn model_id(self) -> &'static str {
        match self {
            ModelRoute::Pro => "deepseek-v4-pro",
            ModelRoute::Flash => "deepseek-v4-flash",
        }
    }
}

/// Classify `user_message` and return which model to use. Never errors — any
/// network / API / parse failure falls back to Pro (port of `routeModel`).
pub async fn route_model(
    client: &reqwest::Client,
    config: &Config,
    user_message: &str,
) -> ModelRoute {
    classify(client, config, user_message)
        .await
        .unwrap_or(ModelRoute::Pro)
}

/// The fallible core: `None` means "couldn't confidently classify" and the
/// caller falls back to Pro (mirrors the TS try/catch + non-"flash" → "pro").
async fn classify(
    client: &reqwest::Client,
    config: &Config,
    user_message: &str,
) -> Option<ModelRoute> {
    let url = format!("{}/chat/completions", config.base_url);
    let body = serde_json::json!({
        "model": "deepseek-v4-flash",
        "messages": [
            { "role": "system", "content": ROUTER_PROMPT },
            { "role": "user", "content": user_message },
        ],
        "max_tokens": 20,
        "temperature": 0,
        "stream": false,
        "thinking": { "type": "disabled" },
    });

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", config.api_key))
        .body(body.to_string())
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None; // → Pro fallback
    }

    let json: Value = resp.json().await.ok()?;
    let text = json
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?
        .trim();

    parse_verdict(text)
}

/// Parse the classifier's `"<model> | <reason>"` line into a route. Only an
/// explicit "flash"/"pro" first token counts; anything else → `None` (Pro).
fn parse_verdict(text: &str) -> Option<ModelRoute> {
    let verdict = text
        .split('|')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    match verdict.as_str() {
        "flash" => Some(ModelRoute::Flash),
        "pro" => Some(ModelRoute::Pro),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flash_and_pro_verdicts() {
        assert_eq!(parse_verdict("flash | simple read"), Some(ModelRoute::Flash));
        assert_eq!(parse_verdict("pro | complex refactor"), Some(ModelRoute::Pro));
        // case-insensitive, whitespace-tolerant
        assert_eq!(parse_verdict("  FLASH  "), Some(ModelRoute::Flash));
        assert_eq!(parse_verdict("Pro"), Some(ModelRoute::Pro));
    }

    #[test]
    fn unknown_verdict_falls_back_to_none() {
        // A non-pro/flash first token means "couldn't classify" → caller uses Pro.
        assert_eq!(parse_verdict("maybe | unsure"), None);
        assert_eq!(parse_verdict(""), None);
        assert_eq!(parse_verdict("the answer is pro"), None);
    }

    #[test]
    fn model_ids_match_chat_models() {
        assert_eq!(ModelRoute::Pro.model_id(), "deepseek-v4-pro");
        assert_eq!(ModelRoute::Flash.model_id(), "deepseek-v4-flash");
    }
}
