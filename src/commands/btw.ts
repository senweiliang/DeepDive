import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";

export const btwCommand: SlashCommand = {
  name: "btw",
  description: "Ask a quick side question without interrupting the main conversation",
  execute(ctx: SlashCommandContext, arg: string): boolean {
    info("slash", "/btw");
    const question = arg.trim();
    if (!question) {
      ctx.setError("Usage: /btw <question>");
      return true;
    }
    ctx.askBtw(question);
    return true;
  },
};
