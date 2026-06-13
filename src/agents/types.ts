/**
 * An agent "kind" — the persona + tool scope a subagent runs with. This is the
 * DeepDive analogue of Claude Code's AgentDefinition (tools/AgentTool), kept
 * deliberately small for the first cut: built-in agents only. Loading
 * user-defined agents from `.deepdive/agents/*.md` frontmatter is on the
 * ROADMAP and will extend this shape (model/permissionMode/maxTurns/etc.).
 */
export interface AgentDefinition {
  /** Stable identifier the model passes as `subagent_type`. */
  agentType: string;
  /** One-line "use this when…" shown to the model in the task tool listing. */
  whenToUse: string;
  /**
   * Tool-name allowlist. When set and non-empty, ONLY these tools are exposed
   * (after the always-excluded set is removed). Omit for "all tools".
   */
  tools?: string[];
  /** Tool-name denylist, applied after the allowlist. */
  disallowedTools?: string[];
  /**
   * Optional model override (e.g. a faster model for search agents). Unset =
   * inherit the main session's model. Wired through but unused by the built-ins
   * for now (DeepSeek's model lineup is small); kept for parity + ROADMAP.
   */
  model?: string;
  /**
   * The agent's persona. Replaces only the base persona head of the system
   * prompt — env/working-directory/language/project context is still appended
   * by the client, so a subagent inherits that for free.
   */
  getSystemPrompt: () => string;
}
