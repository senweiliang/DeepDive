import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";

export const settingsCommand: SlashCommand = {
  name: "settings",
  description: "Adjust runtime settings",
  execute(ctx: SlashCommandContext, _arg: string): boolean {
    info("slash", "/settings");
    ctx.setSettingsOpen(true);
    return true;
  },
};
