import { useState, useCallback, useRef } from "react";
import { Box, useInput } from "ink";
import type { ApprovalMode, Message, ToolCall, ToolCallDelta, Usage } from "../types.js";
import type { Config } from "../config.js";
import { chat } from "../client.js";
import { execute } from "../tools/executor.js";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";
import { Chat } from "./Chat.js";
import { InputBox } from "./InputBox.js";
import { ConfirmBox } from "./ConfirmBox.js";
import { Footer } from "./Footer.js";

interface Props {
  config: Config;
}

const PASTE_THRESHOLD = 256;

function formatPastedText(text: string, counter: number): string {
  const lines = text.split("\n");
  const base = `[Pasted text #${counter}`;
  if (lines.length > 1) {
    return `${base} +${lines.length} lines]`;
  }
  return `${base}]`;
}

export function App({ config }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [thinking, setThinking] = useState("");
  const [response, setResponse] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [mode, setMode] = useState<ApprovalMode>(config.approvalMode);
  const pastedCounter = useRef(1);

  // Pending tool call awaiting approval
  const [pendingTool, setPendingTool] = useState<{
    name: string;
    args: Record<string, unknown>;
    onApprove: () => void;
    onDeny: () => void;
  } | null>(null);

  useInput((input, key) => {
    if (key.shift && key.tab) {
      setMode((prev) => {
        const next: ApprovalMode =
          prev === "default" ? "plan" : prev === "plan" ? "yolo" : "default";
        return next;
      });
    }
    if (key.ctrl && input === "t") {
      setShowThinking((prev) => !prev);
    }
    // Handle approval keys
    if (pendingTool) {
      if (input.toLowerCase() === "y") {
        pendingTool.onApprove();
        setPendingTool(null);
      } else if (input.toLowerCase() === "n") {
        pendingTool.onDeny();
        setPendingTool(null);
      }
    }
  });

  const runTurn = useCallback(
    async (history: Message[]): Promise<Message[]> => {
      let fullContent = "";
      let fullThinking = "";
      let lastUsage: Usage | null = null;

      // Accumulate streaming tool calls: index → assembled ToolCall
      const toolCallsByIndex = new Map<number, ToolCall & { argsStr: string }>();

      for await (const chunk of chat(config, history)) {
        if (chunk.reasoning_content) {
          fullThinking += chunk.reasoning_content;
          setThinking(fullThinking);
        }
        if (chunk.content) {
          fullContent += chunk.content;
          setResponse(fullContent);
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
          break;
        }
      }

      setUsage(lastUsage);

      // Build the assistant message
      const toolCalls = [...toolCallsByIndex.values()].map(
        ({ id, type, function: fn }) => ({ id, type, function: fn }),
      );
      const assistantMsg: Message = {
        role: "assistant",
        content: fullContent,
        reasoning_content: fullThinking || undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      };

      return [...history, assistantMsg];
    },
    [config],
  );

  async function handleSend(input: string) {
    setError("");
    setThinking("");
    setResponse("");
    setUsage(null);

    // Format pasted text if needed
    let displayContent = input;
    if (input.length > PASTE_THRESHOLD) {
      displayContent = formatPastedText(input, pastedCounter.current++);
    }

    const userMsg: Message = { role: "user", content: displayContent };
    let history = [...messages, userMsg];
    setMessages(history);
    setIsStreaming(true);

    try {
      let maxTurns = 10; // safety limit for tool calling loops

      while (maxTurns-- > 0) {
        history = await runTurn(history);
        setMessages(history);

        const lastMsg = history[history.length - 1];
        if (!lastMsg || !lastMsg.tool_calls || lastMsg.tool_calls.length === 0) {
          break; // stop: model said something without tools
        }

        // Process tool calls
        const toolResults: Message[] = [];

        for (const tc of lastMsg.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }

          // Check if tool is allowed
          if (!toolAllowed(tc.function.name, mode)) {
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: `Error: tool "${tc.function.name}" is not available in ${mode} mode.`,
            });
            continue;
          }

          // Check if tool needs approval
          if (toolNeedsApproval(tc.function.name, mode)) {
            const approved = await new Promise<boolean>((resolve) => {
              setPendingTool({
                name: tc.function.name,
                args,
                onApprove: () => resolve(true),
                onDeny: () => resolve(false),
              });
            });

            if (!approved) {
              toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "User denied the tool execution.",
              });
              continue;
            }
          }

          // Execute
          const result = execute(tc.function.name, args, process.cwd());
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.content,
          });
        }

        // Add all tool results and continue the loop
        history = [...history, ...toolResults];
        setMessages(history);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <Box flexDirection="column" height="100%">
      <Chat
        messages={messages}
        thinking={thinking}
        response={response}
        isStreaming={isStreaming}
        showThinking={showThinking}
      />
      {pendingTool && (
        <ConfirmBox
          toolName={pendingTool.name}
          args={pendingTool.args}
        />
      )}
      <InputBox
        onSubmit={handleSend}
        disabled={pendingTool !== null}
        streaming={isStreaming}
        error={error}
      />
      <Footer model={config.model} usage={usage} mode={mode} />
    </Box>
  );
}
