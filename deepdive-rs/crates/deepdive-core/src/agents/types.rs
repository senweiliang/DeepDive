//! Agent "kind" — persona + tool scope a subagent runs with. Port of
//! `src/agents/types.ts` (the `getSystemPrompt` closure becomes a stored
//! `system_prompt` String).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDefinition {
    /// Stable identifier the model passes as `subagent_type`.
    pub agent_type: String,
    /// One-line "use this when…" for the task tool listing.
    pub when_to_use: String,
    /// Tool allowlist. `Some(non-empty)` = only these; `Some(empty)` = no tools;
    /// `None` = all tools.
    pub tools: Option<Vec<String>>,
    /// Tool denylist, applied after the allowlist.
    pub disallowed_tools: Vec<String>,
    /// Optional model override (unset = inherit the session model).
    pub model: Option<String>,
    /// The agent's persona system prompt.
    pub system_prompt: String,
}
