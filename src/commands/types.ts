import type { Message } from "../types.js";

export interface SlashCommandContext {
  messages: Message[];
  setMessages: (msgs: Message[] | ((prev: Message[]) => Message[])) => void;
  setError: (err: string) => void;
  setUsage: (u: null) => void;
  setModelOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  compactHistory: (msgs: Message[]) => Promise<Message[]>;
  /** Clear refs used by /clear */
  clearRefs: () => void;
}

export interface SlashCommand {
  name: string;
  /** Return true if handled, false if unknown. */
  execute(ctx: SlashCommandContext, arg: string): boolean | Promise<boolean>;
}
