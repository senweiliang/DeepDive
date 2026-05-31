import type { SlashCommand, SlashCommandContext } from "./types.js";
import { updateSessionTitle } from "../session.js";
import { info } from "../log.js";

export const renameCommand: SlashCommand = {
  name: "rename",
  description: "Rename the current session",
  execute(ctx: SlashCommandContext, arg: string): boolean {
    const title = arg.trim();
    if (!title) {
      ctx.setError("Usage: /rename <session title>");
      return true;
    }
    ctx.renameSession(title);
    updateSessionTitle(ctx.sessionId, title);
    info("slash", `/rename "${title}"`);
    ctx.setMessages((prev) => [
      ...prev,
      { role: "user", content: `/rename ${title}` },
      {
        role: "assistant",
        content: `已重命名会话为：「${title}」`,
      },
    ]);
    return true;
  },
};
