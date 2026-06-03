import type { Message } from "../types.js";

export interface SlashCommandContext {
  messages: Message[];
  setMessages: (msgs: Message[] | ((prev: Message[]) => Message[])) => void;
  setError: (err: string) => void;
  setUsage: (u: null) => void;
  setModelOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  compactHistory: (msgs: Message[], signal?: AbortSignal) => Promise<Message[]>;
  /** Clear refs used by /clear */
  clearRefs: () => void;
  /** Abort signal for the current send. Pass to fetch calls to support Esc interrupt. */
  signal?: AbortSignal;
  /** Current session ID, used by commands that persist session metadata. */
  sessionId: string;
  /** Rename the current session (title shown in the resume picker). */
  renameSession: (title: string) => void;
  /** Add a directory to the session-scoped grant list for out-of-workspace writes. */
  addDir: (dir: string) => void;
  /** All currently-active working directories (original cwd + session dirs + persisted). */
  workingDirs: string[];
  /** Show a confirm dialog for adding a directory. Resolves to user's choice. */
  confirmAddDir: (dir: string) => Promise<"session" | "persist" | "deny">;
}

export interface SlashCommand {
  name: string;
  description?: string;
  /** Return true if handled, false if unknown. */
  execute(ctx: SlashCommandContext, arg: string): boolean | Promise<boolean>;
}
