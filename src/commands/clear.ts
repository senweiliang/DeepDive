import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear the current conversation",
  execute(ctx: SlashCommandContext, _arg: string): boolean {
    ctx.setMessages([]);
    ctx.clearRefs();
    ctx.setUsage(null);
    info("slash", "/clear");
    return true;
  },
};
