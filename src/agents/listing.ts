import type { Message } from "../types.js";
import { formatAgentLine, getAllAgents } from "./registry.js";

/**
 * The available-agents listing is delivered as a hidden system-reminder (a
 * `meta` user message), NOT baked into the `agent` tool's JSON schema. That
 * keeps the tools array byte-identical across every request — the head of
 * DeepSeek's prefix-cache key — exactly like the skill listing
 * (see makeSkillListingMessage). The model reads the agent menu from here, so
 * custom `.deepdive/agents/*.md` agents surface without ever touching the
 * cached tool schema. buildBody() in client.ts repositions this block right
 * after the system message so it stays in the stable cache region.
 */
export const AGENT_LISTING_MARKER = "<deepdive-agent-listing>";

export function makeAgentListingMessage(): Message | null {
  const agents = getAllAgents();
  if (agents.length === 0) return null;
  const lines = agents.map(formatAgentLine).join("\n");
  return {
    role: "user",
    meta: true,
    content:
      `<system-reminder>\n${AGENT_LISTING_MARKER}\n` +
      `Available subagent_type values for the agent tool — pass one as ` +
      `subagent_type (omit for general-purpose):\n\n${lines}\n\n` +
      `Custom agents are loaded from .deepdive/agents/*.md (project and ~). ` +
      `Pass run_in_background:true to the agent tool to launch one in the ` +
      `background; you'll be notified when it finishes, so don't poll.\n` +
      `</system-reminder>`,
  };
}

export function isAgentListingMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.meta === true &&
    message.content.includes(AGENT_LISTING_MARKER)
  );
}
