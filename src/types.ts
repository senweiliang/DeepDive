export type ApprovalMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "yolo"
  | "auto";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  /**
   * Per-turn usage, stamped onto the assistant message that closed the turn.
   * input/output reflect that turn; cache hit/miss are session-cumulative.
   * Persisted inline with the message (no extra transcript lines) and used
   * to restore the footer stats on `-r` resume. Stripped before sending to
   * the model — see stripNonApiFields in client.ts.
   */
  usage?: Usage;
  /**
   * Set on an assistant message whose streaming (thinking or response) was
   * cut short by the user (Esc / Ctrl-C). The partial text is kept; the UI
   * renders a `⎿ Interrupted by user` marker under it. Client-only — stripped
   * before the message is sent back to the model.
   */
  interrupted?: boolean;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  reasoning_tokens?: number;
}

export interface StreamChunk {
  content: string;
  reasoning_content: string;
  tool_calls: ToolCallDelta[];
  finish_reason: string | null;
  usage: Usage | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}
