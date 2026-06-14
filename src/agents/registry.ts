import { ALL_TOOLS, type ToolDef } from "../tools/schema.js";
import type { AgentDefinition } from "./types.js";
import { GENERAL_PURPOSE_AGENT, EXPLORE_AGENT } from "./builtin.js";
import { loadCustomAgents } from "./load.js";

/**
 * Tools never exposed to ANY subagent, regardless of its definition:
 *  - `agent`: a subagent spawning subagents would recurse without bound. This
 *    is the single most important guard — the scoped tool list passed to
 *    chat() simply omits it, so a subagent can't even see it.
 *  - `ask_user_question`: subagents run headless with no terminal focus, so
 *    they can't prompt the user.
 *  - `skill`: skill loading mutates the main conversation's context; it's a
 *    main-session concern, not a subagent one.
 *  - `task_output` / `task_stop`: background-task management is a main-session
 *    concern; a headless subagent has no background tasks of its own to watch.
 */
const SUBAGENT_EXCLUDED = new Set([
  "agent",
  "ask_user_question",
  "skill",
  "task_output",
  "task_stop",
]);

export type AgentSource = "built-in" | "user" | "project";

export interface RegisteredAgent {
  def: AgentDefinition;
  source: AgentSource;
}

const BUILT_IN_AGENTS: AgentDefinition[] = [
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
];

// Built-ins + custom agents, deduped by agentType with LAST-WINS precedence
// (built-in < user < project), memoized so the disk scan happens once. Mirrors
// Claude Code's getAgentDefinitionsWithOverrides.
let registryCache: Map<string, RegisteredAgent> | null = null;

function buildRegistry(): Map<string, RegisteredAgent> {
  const map = new Map<string, RegisteredAgent>();
  for (const def of BUILT_IN_AGENTS) {
    map.set(def.agentType, { def, source: "built-in" });
  }
  for (const loaded of loadCustomAgents()) {
    const { source, filePath: _fp, ...def } = loaded;
    map.set(def.agentType, { def, source });
  }
  return map;
}

function registry(): Map<string, RegisteredAgent> {
  if (!registryCache) registryCache = buildRegistry();
  return registryCache;
}

/** Re-scan the agent directories on the next access (e.g. after `/agents`). */
export function reloadAgents(): void {
  registryCache = null;
}

export function getBuiltInAgents(): AgentDefinition[] {
  return BUILT_IN_AGENTS;
}

/** Every available agent — built-in and custom — in registration order. */
export function getAllAgents(): AgentDefinition[] {
  return Array.from(registry().values()).map((e) => e.def);
}

/** Every available agent with its provenance, for the `/agents` listing. */
export function getRegisteredAgents(): RegisteredAgent[] {
  return Array.from(registry().values());
}

/** Look up an agent by its `agentType`, or undefined if unknown. */
export function getAgent(agentType: string): AgentDefinition | undefined {
  return registry().get(agentType)?.def;
}

/**
 * The concrete tool set a subagent of this kind may use: ALL_TOOLS minus the
 * always-excluded set, then filtered by the agent's allowlist/denylist. This
 * is what gets passed to chat() as the `tools` override.
 */
export function resolveAgentTools(def: AgentDefinition): ToolDef[] {
  const allow = def.tools && def.tools.length > 0 ? new Set(def.tools) : null;
  // An explicit empty allowlist ("tools: none") means NO tools at all.
  const noTools = def.tools !== undefined && def.tools.length === 0;
  const deny = new Set(def.disallowedTools ?? []);
  if (noTools) return [];
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
