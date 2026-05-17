import { useState, useCallback, useRef, useInsertionEffect, useEffect } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { resolve as resolvePath, dirname, sep } from "node:path";

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
import { chat, summarize, COMPACT_INSTRUCTION } from "../client.js";
import { fetchBalance } from "../balance.js";
import type { Balance } from "../balance.js";
import { execute, executeBash, type BashExecution } from "../tools/executor.js";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";
import { classify } from "../tools/classifier.js";
import { checkPermission, suggestPermissionPattern } from "../tools/permissions.js";
import { savePermission } from "../config.js";
import { info, warn, setSessionId } from "../log.js";
import { MessageItem, StreamPreview, TranscriptView } from "./Chat.js";
import { InputBox } from "./InputBox.js";
import { Running, DOT_BLINK_MS } from "./Running.js";
import { Block } from "./Block.js";
import { ToolResult } from "./ToolResult.js";
import { ConfirmBox } from "./ConfirmBox.js";
import { Footer } from "./Footer.js";
import { appendCompact, appendMessage, makeSummaryMessage } from "../session.js";
import { truncate } from "../tools/format.js";

interface Props {
  config: Config;
  sessionId: string;
  initialMessages?: Message[];
}


export function App({ config, sessionId, initialMessages }: Props) {
  setSessionId(sessionId);
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [thinking, setThinking] = useState("");
  const [response, setResponse] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [mode, setMode] = useState<ApprovalMode>(config.approvalMode);
  const modeRef = useRef<ApprovalMode>(mode);
  modeRef.current = mode; // keep ref in sync so handleSend always reads latest
  const [balance, setBalance] = useState<Balance | null>(null);
  const [runningBash, setRunningBash] = useState<{
    toolCallId: string;
    command: string;
    output: string;
  } | null>(null);
  const [bashDotVisible, setBashDotVisible] = useState(true);

  useEffect(() => {
    fetchBalance(config).then(setBalance);
  }, [config]);

  // Blink ● while bash is running
  useEffect(() => {
    if (!runningBash) {
      setBashDotVisible(true);
      return;
    }
    const timer = setInterval(() => {
      setBashDotVisible((v) => !v);
    }, DOT_BLINK_MS);
    return () => clearInterval(timer);
  }, [!!runningBash]);

  // When mode changes, if a tool is waiting for approval and the new mode
  // no longer requires it, auto-approve immediately.
  useEffect(() => {
    if (!pendingTool) return;
    if (!toolNeedsApproval(pendingTool.name, mode) && toolAllowed(pendingTool.name, mode)) {
      pendingTool.onApprove();
      setPendingTool(null);
    }
    // Only re-run when mode changes; pendingTool refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
  // Live permission rules: seeded from disk at startup, mutated in-memory on
  // "Allow always" so the rule takes effect immediately (not just next session).
  const permissionsRef = useRef(config.permissions);
  // Session-scoped directory grants (mirrors official `addDirectories`,
  // session destination): absolute resolved dirs the user OK'd writes into
  // for this run only. Never persisted to settings.
  const sessionDirsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runningShellsRef = useRef<Map<string, BashExecution>>(new Map());
  const ctrlCAtRef = useRef<number>(0);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Auto-compact circuit breaker: if compact runs but the next turn's
  // input_tokens still exceeds threshold (system prompt + summary > window),
  // disable further auto-compact for this session to avoid infinite loops.
  const compactDisabledRef = useRef(false);
  const tokensBeforeCompactRef = useRef<number | null>(null);
  const [exitHint, setExitHint] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const { exit } = useApp();

  // Pending tool call awaiting approval
  const [pendingTool, setPendingTool] = useState<{
    name: string;
    args: Record<string, unknown>;
    warning?: string;
    savePattern: string | null;
    /** Out-of-workspace write/edit: dir to grant for the session (null otherwise). */
    sessionDir: string | null;
    onApprove: () => void;
    onDeny: () => void;
    onAllowAlways: (pattern: string) => void;
  } | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      // If anything is in progress, abort it first.
      if (isStreaming || pendingTool || runningBash) {
        abortRef.current?.abort();
        if (pendingTool) {
          pendingTool.onDeny();
          setPendingTool(null);
        }
        setExitHint("Press Ctrl-C again to exit");
        ctrlCAtRef.current = now;
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => {
          setExitHint("");
          ctrlCAtRef.current = 0;
        }, 2000);
        return;
      }
      // Idle: double-tap to exit.
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
        const order: ApprovalMode[] = [
          "default",
          "acceptEdits",
          "plan",
          "yolo",
          "auto",
        ];
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

  const compactHistory = useCallback(
    async (priorHistory: Message[]): Promise<Message[]> => {
      if (priorHistory.length === 0) return priorHistory;
      setIsCompacting(true);
      try {
        const summarizeReq: Message[] = [
          ...priorHistory,
          { role: "user", content: COMPACT_INSTRUCTION },
        ];
        const summary = await summarize(config, summarizeReq);
        appendCompact(sessionId, summary, []);
        const summaryMsg = makeSummaryMessage(summary);
        // Append (don't replace): <Static> is append-only, so the only way
        // the summary actually shows up in the terminal is by extending the
        // messages array. The API client slices from the last summary forward
        // when constructing requests, so token cost stays low regardless.
        const next = [...priorHistory, summaryMsg];
        // The summary is persisted as a {type:"compact"} event above, not as
        // a regular msg row — advance the counter past it so the persist
        // effect doesn't write a duplicate {type:"msg"} for the summary.
        persistedCountRef.current = next.length;
        setMessages(next);
        return next;
      } finally {
        setIsCompacting(false);
      }
    },
    [config, sessionId],
  );

  async function handleSend(input: string) {
    setError("");
    setThinking("");
    setResponse("");
    info("turn", `start: "${input.slice(0, 80)}${input.length > 80 ? "..." : ""}"`);
    // Keep last turn's usage visible during the new turn so the footer
    // (in/out/cache/ctx) doesn't blank out between sends.

    const userMsg: Message = { role: "user", content: input };
    let baseHistory = messages;

    // Window pressure: use last turn's input_tokens as the live estimate.
    if (
      !compactDisabledRef.current &&
      usage &&
      config.contextWindow > 0 &&
      usage.input_tokens > config.contextWindow * 0.8
    ) {
      // If the previous compact didn't bring tokens down meaningfully,
      // assume the contextWindow is set too low (system + summary already
      // saturate it) and stop auto-compacting to avoid an infinite loop.
      const prev = tokensBeforeCompactRef.current;
      if (prev !== null && usage.input_tokens > prev * 0.8) {
        compactDisabledRef.current = true;
        setError(
          "Auto-compact disabled: previous compaction did not reduce input tokens enough " +
            "(likely DEEPSEEK_CONTEXT_WINDOW is too small for the base prompt). Raise it in settings.",
        );
      } else {
        tokensBeforeCompactRef.current = usage.input_tokens;
        try {
          baseHistory = await compactHistory(baseHistory);
        } catch (err) {
          setError(
            "Compaction failed: " +
              (err instanceof Error ? err.message : String(err)),
          );
          // continue with original history; API call may still fit
        }
      }
    }

    let history = [...baseHistory, userMsg];
    setMessages(history);
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    controller.signal.addEventListener("abort", () => {
      runningShellsRef.current.forEach((exec) => exec.abort());
      runningShellsRef.current.clear();
    });

    try {
      // No hard cap by default — loop until the model stops calling tools.
      // An optional cap (config.maxTurns, from DEEPSEEK_MAX_TURNS) is a
      // last-resort guard against runaway loops.
      const maxTurns = config.maxTurns;
      let turn = 0;

      while (true) {
        if (controller.signal.aborted) break;
        turn++;
        if (maxTurns !== undefined && turn > maxTurns) {
          info("loop", `reached max-turns cap (${maxTurns}) — stopping`);
          const notice: Message = {
            role: "assistant",
            content:
              `⚠ 已达到工具调用轮数上限（${maxTurns} 轮），任务可能尚未完成。\n` +
              `输入“继续”可接着执行；或在 ~/.deepdive/settings.json 的 ` +
              `env.DEEPSEEK_MAX_TURNS 调高/删除该项以放宽或取消上限。`,
          };
          history = [...history, notice];
          setMessages(history);
          break;
        }
        info("loop", `turn ${turn}: calling API`);
        history = await runTurn(history, controller.signal);
        info("loop", `turn ${turn}: API response received`);
        setMessages(history);
        setThinking("");
        setResponse("");

        const lastMsg = history[history.length - 1];
        if (!lastMsg || !lastMsg.tool_calls || lastMsg.tool_calls.length === 0) {
          info("loop", `turn ${turn}: no tool calls — done`);
          break; // stop: model said something without tools
        }

        const toolNames = lastMsg.tool_calls.map(tc => tc.function.name).join(", ");
        info("loop", `turn ${turn}: ${lastMsg.tool_calls.length} tool call(s): ${toolNames}`);

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
          if (!toolAllowed(tc.function.name, modeRef.current)) {
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: `Error: tool "${tc.function.name}" is not available in ${mode} mode.`,
            });
            continue;
          }

          // Any file tool touching a path outside the working directory must
          // be confirmed by the user (instead of hard-failing in the executor),
          // regardless of mode.
          const filePath =
            tc.function.name === "read_file" ||
            tc.function.name === "write_file" ||
            tc.function.name === "edit_file"
              ? String(args.file_path ?? "")
              : "";
          const cwd = resolvePath(process.cwd());
          const resolvedPath = filePath ? resolvePath(cwd, filePath) : "";
          const inGrantedDir = sessionDirsRef.current.some(
            (d) => resolvedPath === d || resolvedPath.startsWith(d + sep),
          );
          const outsideWorkspace =
            !!resolvedPath &&
            resolvedPath !== cwd &&
            !resolvedPath.startsWith(cwd + sep) &&
            !inGrantedDir;
          // For an out-of-workspace write/edit, offer a session-scoped grant
          // of its containing directory (skip filesystem root — too broad).
          const isEditTool =
            tc.function.name === "write_file" ||
            tc.function.name === "edit_file";
          const grantDir =
            outsideWorkspace && isEditTool
              ? dirname(resolvedPath)
              : "";
          const sessionDir =
            grantDir && grantDir !== sep && grantDir !== "/"
              ? grantDir
              : null;

          // Check if tool needs approval
          if (
            toolNeedsApproval(tc.function.name, modeRef.current) ||
            outsideWorkspace
          ) {
            const savePattern = suggestPermissionPattern(
              tc.function.name,
              args,
            );
            const askUser = (warning?: string) =>
              new Promise<boolean>((resolve) => {
                setPendingTool({
                  name: tc.function.name,
                  args,
                  warning,
                  savePattern,
                  sessionDir,
                  onApprove: () => resolve(true),
                  onDeny: () => resolve(false),
                  onAllowAlways: (pattern) => {
                    savePermission(pattern);
                    if (!permissionsRef.current.allow.includes(pattern)) {
                      permissionsRef.current.allow.push(pattern);
                    }
                    resolve(true);
                  },
                });
              });

            const decision = checkPermission(
              permissionsRef.current,
              tc.function.name,
              args,
            );
            let approved = false;

            if (decision === "deny") {
              denied = true;
              info("approval", `${tc.function.name} denied by deny rule`);
              toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "Error: Permission denied by a deny rule.",
              });
              continue;
            } else if (decision === "allow") {
              approved = true;
              info(
                "approval",
                `${tc.function.name} auto-allowed by permission rule`,
              );
            } else if (decision === "ask") {
              // Explicit ask rule: always prompt, no classifier shortcut.
              approved = await askUser();
            } else if (outsideWorkspace) {
              // No allow/deny rule, path is outside cwd → confirm with the user.
              approved = await askUser();
            } else {
              // passthrough: auto mode runs the bash classifier first.
              if (
                modeRef.current === "auto" &&
                tc.function.name === "bash"
              ) {
                const cmd = String(args.command || "");
                const userMsg =
                  history.filter((m) => m.role === "user").pop()?.content ||
                  "";
                const verdict = await classify(config, cmd, userMsg);
                if (verdict === "allow") {
                  approved = true;
                } else {
                  approved = await askUser(
                    verdict === "block"
                      ? "(classifier flagged this as dangerous)"
                      : undefined,
                  );
                }
              } else {
                approved = await askUser();
              }
            }

            if (!approved) {
              denied = true;
              toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "Error: User denied the tool execution.",
              });
              continue;
            }
          }

          // Execute
          if (tc.function.name === "bash") {
            // Async bash: show live output outside <Static>, add result when done
            const cmd = String(args.command || "");
            info("exec", `bash start: ${cmd.slice(0, 100)}`);
            setRunningBash({ toolCallId: tc.id, command: cmd, output: "" });

            const bashExec = executeBash(args, process.cwd());
            runningShellsRef.current.set(tc.id, bashExec);

            let streamingContent = "";
            bashExec.onOutput((text) => {
              streamingContent += text;
              setRunningBash((prev) =>
                prev?.toolCallId === tc.id
                  ? { ...prev, output: streamingContent }
                  : prev,
              );
            });

            try {
              const result = await bashExec.promise;
              const finalContent = controller.signal.aborted
                ? "Aborted by user."
                : result.content;
              info("exec", `bash done (${finalContent.length} chars, isError=${result.isError})`);
              toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: finalContent,
              });
            } finally {
              runningShellsRef.current.delete(tc.id);
              setRunningBash(null);
            }
          } else {
            info("exec", `${tc.function.name} start`);
            const result = execute(tc.function.name, args, process.cwd());
            info("exec", `${tc.function.name} done (${result.content.length} chars, isError=${result.isError})`);
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
            });
          }
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
  const toolCalls = new Map<string, ToolCall>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNames.set(tc.id, tc.function.name);
        toolCalls.set(tc.id, tc);
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
            toolCalls={toolCalls}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {transcriptOpen ? (
          <TranscriptView messages={messages} cols={cols} rows={rows} hiddenToolIds={hiddenToolIds} toolNames={toolNames} toolCalls={toolCalls} />
        ) : (
          <>
        <StreamPreview
          thinking={thinking}
          response={response}
          isStreaming={isStreaming}
          showThinking={false}
          cols={cols}
        />
        {runningBash && (
          <Block>
            <Text>
              <Text>{bashDotVisible ? "● " : "  "}</Text>
              <Text bold>Bash</Text>
              <Text>(</Text>
              <Text>{truncate(runningBash.command, 80)}</Text>
              <Text>)</Text>
            </Text>
            <ToolResult content={runningBash.output} cols={cols} />
          </Block>
        )}
        {pendingTool ? (
          <ConfirmBox
            toolName={pendingTool.name}
            args={pendingTool.args}
            warning={pendingTool.warning}
            savePattern={pendingTool.savePattern}
            onApprove={() => {
              pendingTool.onApprove();
              setPendingTool(null);
            }}
            onAllowAlways={(pattern) => {
              pendingTool.onAllowAlways(pattern);
              setPendingTool(null);
            }}
            onAcceptEdits={() => {
              setMode("acceptEdits");
              // Out-of-workspace edit: also grant its dir to the session, so
              // acceptEdits is actually effective there (acceptEdits alone
              // never bypasses the outsideWorkspace gate). Bundled, mirrors
              // official setMode+addDirectories.
              const dir = pendingTool.sessionDir;
              if (dir && !sessionDirsRef.current.includes(dir)) {
                sessionDirsRef.current.push(dir);
              }
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
            {isStreaming && <Running />}
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
              contextWindow={config.contextWindow}
              compacting={isCompacting}
            />
          </>
        )}
          </>
        )}
      </Box>
    </>
  );
}
