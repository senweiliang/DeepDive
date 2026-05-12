import { useState, useCallback, useRef, useInsertionEffect, useEffect } from "react";
import { Box, Static, useApp, useInput } from "ink";

interface InkInternal {
  lastOutput?: string;
  lastOutputToRender?: string;
  lastOutputHeight?: number;
  log?: { reset?: () => void; clear?: () => void };
}

let inkInstances: WeakMap<NodeJS.WriteStream, InkInternal> | null = null;

export function setInkInstances(
  map: WeakMap<NodeJS.WriteStream, InkInternal>,
): void {
  inkInstances = map;
}

function resetInkOutputState() {
  const ink = inkInstances?.get(process.stdout);
  if (!ink) return;
  ink.lastOutput = "";
  ink.lastOutputToRender = "";
  ink.lastOutputHeight = 0;
  // log-update tracks its own previousLineCount separately. reset() clears
  // it without emitting an erase sequence, so ink's next render starts from
  // a clean state and doesn't eraseLines() up into real scrollback.
  ink.log?.reset?.();
}
import type { ApprovalMode, Message, ToolCall, ToolCallDelta, Usage } from "../types.js";
import type { Config } from "../config.js";
import { chat } from "../client.js";
import { fetchBalance } from "../balance.js";
import type { Balance } from "../balance.js";
import { execute } from "../tools/executor.js";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";
import { classify } from "../tools/classifier.js";
import { MessageItem, StreamPreview, TranscriptView } from "./Chat.js";
import { InputBox } from "./InputBox.js";
import { ConfirmBox } from "./ConfirmBox.js";
import { Footer } from "./Footer.js";
import { appendMessage } from "../session.js";

interface Props {
  config: Config;
  sessionId: string;
  initialMessages?: Message[];
}


export function App({ config, sessionId, initialMessages }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [thinking, setThinking] = useState("");
  const [response, setResponse] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [mode, setMode] = useState<ApprovalMode>(config.approvalMode);
  const [balance, setBalance] = useState<Balance | null>(null);

  useEffect(() => {
    fetchBalance(config).then(setBalance);
  }, [config]);

  // Persist new messages to the session jsonl as they arrive.
  const persistedCountRef = useRef(initialMessages?.length ?? 0);
  useEffect(() => {
    while (persistedCountRef.current < messages.length) {
      const msg = messages[persistedCountRef.current];
      if (msg) appendMessage(sessionId, msg);
      persistedCountRef.current++;
    }
  }, [messages, sessionId]);

  useInsertionEffect(() => {
    if (!transcriptOpen) return;
    // Erase the active area BEFORE switching screens. log.clear() emits
    // eraseLines(previousLineCount), leaving the cursor at the top of where
    // the active area used to live. \x1b[?1049h then saves THAT cursor
    // position, so when we exit the alt screen the cursor returns to the
    // start of the old active area and ink's next render overwrites it in
    // place instead of appending a duplicate below.
    const ink = inkInstances?.get(process.stdout);
    ink?.log?.clear?.();
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    resetInkOutputState();
    return () => {
      process.stdout.write("\x1b[?1049l");
      resetInkOutputState();
    };
  }, [transcriptOpen]);
  const abortRef = useRef<AbortController | null>(null);
  const ctrlCAtRef = useRef<number>(0);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [exitHint, setExitHint] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const { exit } = useApp();

  // Pending tool call awaiting approval
  const [pendingTool, setPendingTool] = useState<{
    name: string;
    args: Record<string, unknown>;
    warning?: string;
    onApprove: () => void;
    onDeny: () => void;
  } | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - ctrlCAtRef.current < 1000) {
        exit();
        process.exit(0);
      }
      ctrlCAtRef.current = now;
      setInputKey((k) => k + 1);
      setExitHint("Press Ctrl-C again to exit");
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => {
        setExitHint("");
        ctrlCAtRef.current = 0;
      }, 1000);
      return;
    }
    if (key.ctrl && input === "o") {
      setTranscriptOpen((v) => !v);
      return;
    }
    if (transcriptOpen) {
      if (key.escape) {
        setTranscriptOpen(false);
      }
      return;
    }
    if (key.shift && key.tab) {
      setMode((prev) => {
        const order: ApprovalMode[] = ["default", "plan", "yolo", "auto"];
        const idx = order.indexOf(prev);
        return order[(idx + 1) % order.length]!;
      });
    }
    if (key.escape) {
      if (pendingTool) {
        abortRef.current?.abort();
        pendingTool.onDeny();
        setPendingTool(null);
        return;
      }
      if (isStreaming) {
        abortRef.current?.abort();
      }
    }
  });

  const runTurn = useCallback(
    async (history: Message[], signal: AbortSignal): Promise<Message[]> => {
      let fullContent = "";
      let fullThinking = "";
      let lastUsage: Usage | null = null;

      // Accumulate streaming tool calls: index → assembled ToolCall
      const toolCallsByIndex = new Map<number, ToolCall & { argsStr: string }>();

      for await (const chunk of chat(config, history, signal)) {
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

    const userMsg: Message = { role: "user", content: input };
    let history = [...messages, userMsg];
    setMessages(history);
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let maxTurns = 10; // safety limit for tool calling loops

      while (maxTurns-- > 0) {
        if (controller.signal.aborted) break;
        history = await runTurn(history, controller.signal);
        setMessages(history);
        setThinking("");
        setResponse("");

        const lastMsg = history[history.length - 1];
        if (!lastMsg || !lastMsg.tool_calls || lastMsg.tool_calls.length === 0) {
          break; // stop: model said something without tools
        }

        // Process tool calls
        const toolResults: Message[] = [];
        let denied = false;

        for (const tc of lastMsg.tool_calls) {
          if (controller.signal.aborted) {
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Aborted by user.",
            });
            continue;
          }
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
            let approved = false;

            // Auto mode: use classifier for bash commands
            if (mode === "auto" && tc.function.name === "bash") {
              const cmd = String(args.command || "");
              // Pass the last user message so the classifier can judge intent
              const userMsg = history
                .filter((m) => m.role === "user")
                .pop()?.content || "";
              const verdict = await classify(config, cmd, userMsg);

              if (verdict === "allow") {
                approved = true;
              } else {
                // "block" or "ask" both show the user a confirmation prompt.
                // "block" adds a warning that the classifier flagged it.
                const warning = verdict === "block"
                  ? "(classifier flagged this as dangerous)"
                  : undefined;
                approved = await new Promise<boolean>((resolve) => {
                  setPendingTool({
                    name: tc.function.name,
                    args,
                    warning,
                    onApprove: () => resolve(true),
                    onDeny: () => resolve(false),
                  });
                });
              }
            } else {
              // Default/plan mode: always ask user
              approved = await new Promise<boolean>((resolve) => {
                setPendingTool({
                  name: tc.function.name,
                  args,
                  onApprove: () => resolve(true),
                  onDeny: () => resolve(false),
                });
              });
            }

            if (!approved) {
              denied = true;
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
        if (denied) break;
      }
    } catch (err: unknown) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (!aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setThinking("");
      setResponse("");
      setIsStreaming(false);
    }
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const hiddenToolIds = new Set<string>();
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNames.set(tc.id, tc.function.name);
        if (tc.function.name === "read_file") {
          hiddenToolIds.add(tc.id);
        }
      }
    }
  }

  return (
    <>
      <Static items={messages}>
        {(msg, i) => (
          <MessageItem
            key={i}
            msg={msg}
            showThinking={false}
            cols={cols}
            hiddenToolIds={hiddenToolIds}
            toolNames={toolNames}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {transcriptOpen ? (
          <TranscriptView messages={messages} cols={cols} rows={rows} hiddenToolIds={hiddenToolIds} toolNames={toolNames} />
        ) : (
          <>
        <StreamPreview
          thinking={thinking}
          response={response}
          isStreaming={isStreaming}
          showThinking={false}
        />
        {pendingTool ? (
          <ConfirmBox
            toolName={pendingTool.name}
            args={pendingTool.args}
            warning={pendingTool.warning}
            onApprove={() => {
              pendingTool.onApprove();
              setPendingTool(null);
            }}
            onDeny={() => {
              pendingTool.onDeny();
              setPendingTool(null);
            }}
          />
        ) : (
          <>
            <InputBox
              key={inputKey}
              onSubmit={handleSend}
              streaming={isStreaming}
              error={error}
              history={messages.filter(m => m.role === "user").map(m => m.content).reverse()}
            />
            <Footer
              model={config.model}
              usage={usage}
              mode={mode}
              hint={exitHint}
              balance={balance}
            />
          </>
        )}
          </>
        )}
      </Box>
    </>
  );
}
