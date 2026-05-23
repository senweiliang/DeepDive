import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";

export const compactCommand: SlashCommand = {
  name: "compact",
  async execute(ctx: SlashCommandContext, _arg: string): Promise<boolean> {
    info("slash", "/compact");
    if (ctx.messages.length === 0) {
      ctx.setError("Nothing to compact — conversation is empty.");
      return true;
    }
    try {
      await ctx.compactHistory(ctx.messages, ctx.signal);
    } catch (err) {
      // User aborted via Esc — no need to show an error.
      if (err instanceof Error && err.name === "AbortError") return true;
      ctx.setError(
        "Compaction failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return true;
  },
};
