import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";

export const modelCommand: SlashCommand = {
  name: "model",
  execute(ctx: SlashCommandContext, arg: string): boolean {
    info("slash", "/model");
    if (arg) {
      ctx.setError("Type /model and press Enter to choose pro or flash.");
      return true;
    }
    ctx.setModelOpen(true);
    return true;
  },
};
