export type ApprovalMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "yolo"
  | "auto";

export type TurnSummaryStrategy = "off" | "whole_turn" | "tool_only";

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
  /**
   * Injected session-state reminder (date rollover, response-language
   * change). Sent to the model (role+content) and persisted so reloads keep
   * it, but NOT rendered in the transcript — the user never typed it. The
   * `meta` flag itself is stripped before the request (see stripNonApiFields)
   * and skipped by MessageItem.
   */
  meta?: boolean;
  /**
   * User message originated from !bash mode (inline shell command).
   * Rendered with `!` prefix instead of `>`, stripped before API requests.
   */
  bash?: boolean;
  /**
   * Output of an inline bash (!) command, stored on the user message so it
   * renders below it in the transcript without creating a fake tool message
   * that would break the API's tool_calls→tool_result contract.
   */
  bashOutput?: string;
  /**
   * Client-only error notice (unknown command, compaction/API failure, etc.).
   * Rendered in the transcript like an assistant response but with a red `●`
   * bullet. NOT sent to the model — stripNonApiFields drops these entirely.
   */
  error?: boolean;
  /**
   * Client-only metadata for hidden turn summaries. The summary itself is
   * persisted as a meta user message; this field tells the request builder
   * which raw history region it may replace. Stripped before API requests.
   */
  turn_summary_strategy?: TurnSummaryStrategy;
  /**
   * Client-only record of a subagent (task tool) run, stamped onto the tool
   * result message. Lets the transcript show the subagent's intermediate tool
   * calls indented under the `● Task(…)` line. Persisted for reload / `-r`
   * resume but NEVER sent to the model — only the message's `content` (the
   * subagent's final report) crosses back into the parent context, which is
   * the whole point of context isolation. Stripped by stripNonApiFields.
   */
  subagent?: SubagentRun;
}

/** One intermediate tool call made by a subagent, for transcript display. */
export interface SubagentStep {
  /** Tool name as the subagent invoked it, e.g. "read_file". */
  name: string;
  /** summarizeArgs() output, e.g. "src/auth.ts". May be empty. */
  summary: string;
  /** One-line result tag, e.g. "120 lines" / "5 matches" / "error". */
  result?: string;
}

/** A completed subagent run as recorded on its tool result message. */
export interface SubagentRun {
  /** The full briefing the parent handed to the subagent (the agent tool's
   *  `prompt` arg). Kept here so the transcript can show it alongside the
   *  steps, same source, never out of sync. */
  prompt: string;
  turns: number;
  toolCalls: number;
  steps: SubagentStep[];
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
