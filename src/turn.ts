import { chat, type ChatOverrides } from "./client.js";
import type { Config } from "./config.js";
import type { Message, ToolCall, Usage } from "./types.js";

/**
 * One streamed model round-trip, with no UI/React coupling. This is the
 * shared primitive behind both the interactive agent loop (App.runTurn wraps
 * it with React state + session accounting) and the headless subagent loop
 * (agents/run.ts wraps it with automated tool execution).
 *
 * It does exactly what one turn requires and nothing more: stream the
 * response, accumulate text / thinking / tool-call deltas, and assemble the
 * assistant message. Session-level concerns (cache-hit accumulation,
 * cumulative token totals, persistence, the running-bash panel) stay in the
 * caller — they differ between the interactive and headless paths, so folding
 * them in here would just produce `if (isSubagent)` branches.
 *
 * UI side effects are injected as `onThinking` / `onContent` callbacks; pass
 * none for a fully headless run. `tools` / `systemPrompt` (from
 * {@link ChatOverrides}) flow straight through to the request, which is how a
 * subagent gets a scoped tool set and its own persona.
 */
export interface StreamTurnOptions extends ChatOverrides {
  /** Called with the full accumulated thinking text on each delta. */
  onThinking?: (full: string) => void;
  /** Called with the full accumulated response text on each delta. */
  onContent?: (full: string) => void;
}

export interface StreamTurnResult {
  /** The assembled assistant message. `usage` is intentionally NOT set — the
   *  caller owns usage accounting and stamps the final value on. */
  assistant: Message;
  finish_reason: string | null;
  /** Raw last-seen usage chunk for this turn (no cache/cumulative merging). */
  usage: Usage | null;
  /** True when the user aborted mid-stream; partial output is preserved. */
  interrupted: boolean;
}

export async function streamTurn(
  config: Config,
  history: Message[],
  signal: AbortSignal,
  opts: StreamTurnOptions = {},
): Promise<StreamTurnResult> {
  const { onThinking, onContent, ...overrides } = opts;

  let fullContent = "";
  let fullThinking = "";
  let lastUsage: Usage | null = null;
  let finishReason: string | null = null;

  // Accumulate streaming tool calls: index → assembled ToolCall
  const toolCallsByIndex = new Map<number, ToolCall & { argsStr: string }>();

  // Set when the user aborts mid-stream (Esc / Ctrl-C). We keep whatever
  // thinking/content streamed so far and surface it as an interrupted
  // assistant message instead of losing the whole turn.
  let interrupted = false;

  try {
    for await (const chunk of chat(config, history, signal, overrides)) {
      if (chunk.reasoning_content) {
        fullThinking += chunk.reasoning_content;
        onThinking?.(fullThinking);
      }
      if (chunk.content) {
        fullContent += chunk.content;
        onContent?.(fullContent);
      }

      // Accumulate tool call deltas
      for (const delta of chunk.tool_calls) {
        const existing = toolCallsByIndex.get(delta.index);
        if (!existing) {
          toolCallsByIndex.set(delta.index, {
            id: delta.id || "",
            type: "function",
            function: { name: delta.function?.name || "", arguments: "" },
            argsStr: delta.function?.arguments || "",
          });
        } else {
          if (delta.id) existing.id = delta.id;
          if (delta.function?.name) existing.function.name = delta.function.name;
          if (delta.function?.arguments) {
            existing.argsStr += delta.function.arguments;
            existing.function.arguments = existing.argsStr;
          }
        }
      }

      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
      if (chunk.finish_reason) {
        finishReason = chunk.finish_reason;
        break;
      }
    }
  } catch (err) {
    // A user abort surfaces as an AbortError (DOMException) on the in-flight
    // fetch. Swallow it so the partial output is preserved as an interrupted
    // message; any other error propagates to the caller.
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      interrupted = true;
    } else {
      throw err;
    }
  }

  const toolCalls = [...toolCallsByIndex.values()].map(
    ({ id, type, function: fn }) => ({ id, type, function: fn }),
  );
  const assistant: Message = {
    role: "assistant",
    content: fullContent,
    reasoning_content: fullThinking || undefined,
    // A mid-stream abort can leave tool_calls half-assembled with no tool
    // results to follow. Drop them so the message stays API-valid and the
    // loop stops cleanly at the no-tool-calls check.
    tool_calls: interrupted || !toolCalls.length ? undefined : toolCalls,
    interrupted: interrupted || undefined,
  };

  return {
    assistant,
    finish_reason: finishReason,
    usage: lastUsage,
    interrupted,
  };
}
