import type { SlashCommand, SlashCommandContext } from "./types.js";
import { info } from "../log.js";
import type { Message } from "../types.js";

const HELP = [
  "**Slash Commands**",
  "",
  "| Command | Description |",
  "|---------|-------------|",
  "| `/clear` | Clear the current conversation |",
  "| `/compact` | Manually compact context to save tokens |",
  "| `/model` | Choose the chat model |",
  "| `/settings` | Adjust runtime settings |",
  "| `/help` | Show this help |",
  "",
  "**Keybindings**",
  "",
  "| Key | Action |",
  "|-----|--------|",
  "| `Enter` | Send message |",
  "| `Ctrl+Enter` | Insert newline |",
  "| `Ctrl+C` | Abort in-progress / exit idle (×2) |",
  "| `Ctrl+O` | Open transcript viewer |",
  "| `Shift+Tab` | Cycle approval mode |",
  "| `Escape` | Deny pending confirm / abort streaming |",
  "| `↑/↓` | Browse input history |",
].join("\n");

export const helpCommand: SlashCommand = {
  name: "help",
  execute(ctx: SlashCommandContext, arg: string): boolean {
    info("slash", "/help");
    const userMsg: Message = { role: "user", content: "/help" + (arg ? " " + arg : "") };
    const helpMsg: Message = { role: "assistant", content: HELP };
    ctx.setMessages(prev => [...prev, userMsg, helpMsg]);
    return true;
  },
};
