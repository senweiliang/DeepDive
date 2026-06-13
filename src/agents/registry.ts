import { ALL_TOOLS, type ToolDef } from "../tools/schema.js";
import type { AgentDefinition } from "./types.js";
import { GENERAL_PURPOSE_AGENT, EXPLORE_AGENT } from "./builtin.js";

/**
 * Tools never exposed to ANY subagent, regardless of its definition:
 *  - `task`: a subagent spawning subagents would recurse without bound. This
 *    is the single most important guard — the scoped tool list passed to
 *    chat() simply omits `task`, so a subagent can't even see it.
 *  - `ask_user_question`: subagents run headless with no terminal focus, so
 *    they can't prompt the user.
 *  - `skill`: skill loading mutates the main conversation's context; it's a
 *    main-session concern, not a subagent one.
 */
const SUBAGENT_EXCLUDED = new Set(["agent", "ask_user_question", "skill"]);

const BUILT_IN_AGENTS: AgentDefinition[] = [
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
];

export function getBuiltInAgents(): AgentDefinition[] {
  return BUILT_IN_AGENTS;
}

/** Look up an agent by its `agentType`, or undefined if unknown. */
export function getAgent(agentType: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find((a) => a.agentType === agentType);
}

/**
 * The concrete tool set a subagent of this kind may use: ALL_TOOLS minus the
 * always-excluded set, then filtered by the agent's allowlist/denylist. This
 * is what gets passed to chat() as the `tools` override.
 */
export function resolveAgentTools(def: AgentDefinition): ToolDef[] {
  const allow = def.tools && def.tools.length > 0 ? new Set(def.tools) : null;
  const deny = new Set(def.disallowedTools ?? []);
  return ALL_TOOLS.filter((t) => {
    const name = t.function.name;
    if (SUBAGENT_EXCLUDED.has(name)) return false;
    if (allow && !allow.has(name)) return false;
    if (deny.has(name)) return false;
    return true;
  });
}

/** `- type: when-to-use` line for the task tool listing (and future docs). */
export function formatAgentLine(def: AgentDefinition): string {
  return `- ${def.agentType}: ${def.whenToUse}`;
}
