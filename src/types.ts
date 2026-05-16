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
