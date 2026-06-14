import type { SlashCommand } from "./types.js";
import { getRegisteredAgents, reloadAgents } from "../agents/registry.js";
import { isAgentListingMessage } from "../agents/listing.js";

function toolsLabel(tools: string[] | undefined): string {
  if (tools === undefined) return "all tools";
  if (tools.length === 0) return "no tools";
  return tools.join(", ");
}

/**
 * `/agents` — list every available subagent (built-in + custom) with its
 * source and tool scope. Re-scans `.deepdive/agents` first so freshly-edited
 * files show up without a restart.
 */
export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List available subagents (built-in + custom)",
  execute(ctx) {
    reloadAgents();
    const registered = getRegisteredAgents();
    const lines = registered.map(({ def, source }) => {
      const bg = def.model ? ` · model ${def.model}` : "";
      return (
        `**${def.agentType}** _(${source})_ — ${toolsLabel(def.tools)}${bg}\n` +
        `  ${def.whenToUse}`
      );
    });
    const body =
      lines.length > 0
        ? lines.join("\n\n")
        : "No agents found.";
    const note =
      `可用 subagent（共 ${registered.length} 个，自定义 agent 来自 ` +
      `\`.deepdive/agents/*.md\`，项目目录与 \`~\` 均扫描）：\n\n${body}`;
    // Drop any already-injected agent listing so the next turn's
    // ensureAgentListing rebuilds it from the just-reloaded registry — without
    // this, a mid-session agent edit would never reach the model's menu (the
    // listing is injected once and idempotently). Only the small listing block
    // is invalidated; buildBody keeps it in the stable cache region.
    ctx.setMessages((prev) => [
      ...prev.filter((m) => !isAgentListingMessage(m)),
      { role: "user", content: "/agents" },
      { role: "assistant", content: note },
    ]);
    return true;
  },
};
