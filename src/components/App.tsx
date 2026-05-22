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
import {
  chat,
  summarize,
  dateChangeMessage,
  COMPACT_INSTRUCTION,
} from "../client.js";
import { fetchBalance } from "../balance.js";
import type { Balance } from "../balance.js";
import { execute, executeBash, type BashExecution } from "../tools/executor.js";
import { executeWebSearch } from "../tools/websearch.js";
import { executeWebFetch } from "../tools/webfetch.js";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";
import { classify } from "../tools/classifier.js";
import { checkPermission, suggestPermissionPattern } from "../tools/permissions.js";
import {
  CHAT_MODELS,
  MODEL_CONTEXT_WINDOWS,
  savePermission,
  saveModel,
  saveReasoningEffort,
  saveSearchEngine,
  saveTavilyKey,
  saveResponseLanguage,
  saveTurnSummaryStrategy,
  REASONING_EFFORTS,
  SEARCH_ENGINES,
  RESPONSE_LANGUAGES,
} from "../config.js";
import { info, warn, setSessionId } from "../log.js";
import { MessageItem, StreamPreview, TranscriptView } from "./Chat.js";
import { InputBox } from "./InputBox.js";
import { Running, DOT_BLINK_MS } from "./Running.js";
import { Block } from "./Block.js";
import { ToolResult } from "./ToolResult.js";
import { ConfirmBox } from "./ConfirmBox.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { ModelPanel } from "./ModelPanel.js";
import { Footer } from "./Footer.js";
import { appendCompact, appendMessage, makeSummaryMessage } from "../session.js";
import {
  buildTurnSummaryRequest,
  TURN_SUMMARY_INSTRUCTION,
  makeTurnSummaryMessage,
  previousTurnMessages,
  previousTurnSummaryBlocks,
  shouldSummarizePreviousTurn,
} from "../turn-summary.js";
import { truncate } from "../tools/format.js";

interface Props {
  config: Config;
  sessionId: string;
  initialMessages?: Message[];
  initialUsage?: Usage | null;
}


export function App({
  config,
  sessionId,
  initialMessages,
  initialUsage,
}: Props) {
  setSessionId(sessionId);
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [thinking, setThinking] = useState("");
  const [response, setResponse] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(initialUsage ?? null);
  const [error, setError] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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
  // Session-cumulative cache token counts (across all turns), used to show
  // a whole-session cache hit rate rather than the last turn's only.
  const cacheTotalsRef = useRef({
    hit: initialUsage?.prompt_cache_hit_tokens ?? 0,
    miss: initialUsage?.prompt_cache_miss_tokens ?? 0,
  });
  const [exitHint, setExitHint] = useState("");
  const [inputKey, setInputKey] = useState(0);
  // Text put back into the input box after a recall (send aborted before any
  // response). Consumed by the InputBox mount keyed on inputKey.
  const [recalledText, setRecalledText] = useState("");
  // The just-sent user message, held OUT of <Static> until the turn produces
  // its first output. <Static> is append-only (printed lines can't be
  // unprinted), so a message that might be recalled must live in the dynamic
  // area first, then commit into `messages` once we know it's staying.
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const { exit } = useApp();

  // recalledText is consumed by the InputBox that remounts on the inputKey
  // bump. Clear it right after so a later remount (e.g. idle Ctrl-C) starts
  // empty instead of re-injecting the recalled text. The InputBox keeps its
  // own state once mounted, so clearing here doesn't wipe the restored text.
  useEffect(() => {
    if (recalledText) setRecalledText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  // Pending tool call awaiting approval
  const [pendingTool, setPendingTool] = useState<{
    name: string;
    args: Record<string, unknown>;
    warning?: string;
    savePattern: string[] | null;
    /** Out-of-workspace write/edit: dir to grant for the session (null otherwise). */
    sessionDir: string | null;
    onApprove: () => void;
    onDeny: () => void;
    onAllowAlways: (patterns: string[]) => void;
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

      // Set when the user aborts mid-stream (Esc / Ctrl-C). We keep whatever
      // thinking/content streamed so far and surface it as an interrupted
      // assistant message instead of losing the whole turn.
      let interrupted = false;

      try {
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
      } catch (err) {
        // A user abort surfaces as an AbortError (DOMException) on the
        // in-flight fetch. Swallow it so the partial output is preserved as
        // an interrupted message; any other error propagates to handleSend.
        if (
          signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          interrupted = true;
        } else {
          throw err;
        }
      }

      let mergedUsage: Usage | null = null;
      if (lastUsage) {
        // Keep input/output (and thus ctx) reflecting the latest turn, but
        // accumulate cache hit/miss across the whole session so the footer
        // shows the session-wide hit rate.
        if (lastUsage.prompt_cache_hit_tokens != null) {
          cacheTotalsRef.current.hit += lastUsage.prompt_cache_hit_tokens;
        }
        if (lastUsage.prompt_cache_miss_tokens != null) {
          cacheTotalsRef.current.miss += lastUsage.prompt_cache_miss_tokens;
        }
        const { hit, miss } = cacheTotalsRef.current;
        mergedUsage = {
          ...lastUsage,
          prompt_cache_hit_tokens: hit + miss > 0 ? hit : undefined,
          prompt_cache_miss_tokens: hit + miss > 0 ? miss : undefined,
        };
        setUsage(mergedUsage);
      } else if (!interrupted) {
        setUsage(null);
      }
      // (interrupted with no usage chunk: leave the footer on the prior
      // turn's stats rather than blanking it.)

      // Build the assistant message. Usage rides on this message (mirrors
      // official Claude Code) so it's persisted by the existing
      // appendMessage path — no extra transcript lines — and restored on
      // `-r` resume from the last message that carries it.
      const toolCalls = [...toolCallsByIndex.values()].map(
        ({ id, type, function: fn }) => ({ id, type, function: fn }),
      );
      const assistantMsg: Message = {
        role: "assistant",
        content: fullContent,
        reasoning_content: fullThinking || undefined,
        // A mid-stream abort can leave tool_calls half-assembled with no
        // tool results to follow. Drop them so the message stays API-valid
        // and the loop stops cleanly at the no-tool-calls check.
        tool_calls: interrupted || !toolCalls.length ? undefined : toolCalls,
        usage: mergedUsage ?? undefined,
        interrupted: interrupted || undefined,
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

  const summarizePreviousTurn = useCallback(
    async (
      priorHistory: Message[],
      signal?: AbortSignal,
    ): Promise<Message[]> => {
      const blocks = previousTurnSummaryBlocks(
        priorHistory,
        config.turnSummaryStrategy,
      );
      if (blocks.length === 0) return priorHistory;

      const turnUser = previousTurnMessages(priorHistory).find(
        (msg) => msg.role === "user" && !msg.meta,
      );
      const summaryMsgs: Message[] = [];
      for (const block of blocks) {
        const input =
          block.strategy === "tool_only" && turnUser
            ? [turnUser, ...block.messages]
            : block.messages;
        const summary = await summarize(
          config,
          buildTurnSummaryRequest(input, TURN_SUMMARY_INSTRUCTION),
          signal,
        );
        summaryMsgs.push(makeTurnSummaryMessage(summary, block.strategy));
      }
      info(
        "summary",
        `previous turn summarized (${config.turnSummaryStrategy}, ${summaryMsgs.length} block(s))`,
      );
      return [...priorHistory, ...summaryMsgs];
    },
    [config],
  );

  async function handleSend(input: string) {
    setError("");
    setThinking("");
    setResponse("");

    // ── Inline bash mode (! prefix) ────────────────────────────────
    if (input.startsWith("!")) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      info("bash", `inline: ${cmd.slice(0, 100)}`);

      const userMsg: Message = { role: "user", content: cmd, bash: true };

      // Defer adding to <Static> until bash completes: Static never
      // re-renders existing items, so if we add the message now without
      // bashOutput and later try to replace it, the output never appears.
      // Instead, show the command + live output in the dynamic runningBash
      // panel, and push the complete message (with bashOutput) into
      // messages only once when done.

      // Show running bash state while executing
      const toolCallId = `bash-${Date.now()}`;
      setRunningBash({ toolCallId, command: cmd, output: "" });

      const bashExec = executeBash({ command: cmd }, process.cwd());
      let streamingContent = "";
      bashExec.onOutput((text) => {
        streamingContent += text;
        setRunningBash((prev) =>
          prev?.toolCallId === toolCallId
            ? { ...prev, output: streamingContent }
            : prev,
        );
      });

      try {
        const result = await bashExec.promise;
        // Write the output onto the user message itself instead of creating
        // a fake tool message — inline bash is NOT a model tool call, so a
        // tool-role message without a preceding assistant tool_calls would
        // break the API contract on the next turn.
        setMessages((prev) => [...prev, { ...userMsg, bashOutput: result.content }]);
      } finally {
        setRunningBash(null);
      }
      return;
    }
    const trimmed = input.trim();
    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (cmd === "clear") {
        setMessages([]);
        persistedCountRef.current = 0;
        setUsage(null);
        cacheTotalsRef.current = { hit: 0, miss: 0 };
        compactDisabledRef.current = false;
        tokensBeforeCompactRef.current = null;
        info("slash", "/clear");
        return;
      }

      if (cmd === "compact") {
        info("slash", "/compact");
        if (messages.length === 0) {
          setError("Nothing to compact — conversation is empty.");
          return;
        }
        try {
          await compactHistory(messages);
        } catch (err) {
          setError(
            "Compaction failed: " +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        return;
      }

      if (cmd === "help") {
        info("slash", "/help");
        const helpContent = [
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
        const userMsg: Message = { role: "user", content: trimmed };
        const helpMsg: Message = { role: "assistant", content: helpContent };
        setMessages([...messages, userMsg, helpMsg]);
        return;
      }

      if (cmd === "model") {
        info("slash", "/model");
        if (arg) {
          setError("Type /model and press Enter to choose pro or flash.");
          return;
        }
        setModelOpen(true);
        return;
      }

      if (cmd === "settings") {
        info("slash", "/settings");
        setSettingsOpen(true);
        return;
      }

      // Unknown slash command
      info("slash", `unknown: "${cmd}"`);
      setError(`Unknown command: /${cmd}. Type /help for available commands.`);
      return;
    }

    info("turn", `start: "${input.slice(0, 80)}${input.length > 80 ? "..." : ""}"`);
    // Keep last turn's usage visible during the new turn so the footer
    // (in/out/cache/ctx) doesn't blank out between sends.

    const userMsg: Message = { role: "user", content: input };
    let baseHistory = messages;
    let history = [...baseHistory, userMsg];
    setPendingUser(input);
    // Local mirror of "the user message is still held in pendingUser"
    // (state closures are stale inside this async handler).
    let userHeld = true;
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    controller.signal.addEventListener("abort", () => {
      runningShellsRef.current.forEach((exec) => exec.abort());
      runningShellsRef.current.clear();
    });

    try {
      if (
        shouldSummarizePreviousTurn(
          baseHistory,
          config.turnSummaryStrategy,
        )
      ) {
        try {
          baseHistory = await summarizePreviousTurn(
            baseHistory,
            controller.signal,
          );
        } catch (err) {
          if (controller.signal.aborted) throw err;
          warn(
            "summary",
            "previous-turn summary failed: " +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

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

      // Rebuild `history` after preflight summary/compact may have changed
      // `baseHistory`. The user message has already been shown via
      // `pendingUser`, but still stays out of <Static> until first output.
      history = [...baseHistory, userMsg];

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
        // Midnight rollover: splice a one-off date-change reminder into
        // history (persisted via the session) so later turns read the new
        // date from the cached prefix without rebuilding it. Safe insertion
        // point: history's tail is the user message (turn 1) or tool
        // results, both valid before this user-role reminder. Returns null
        // unless the local date actually changed. (Response language is
        // handled differently — frozen into the system prompt at session
        // start, see languageInstruction in client.ts.)
        const dateChange = dateChangeMessage();
        if (dateChange) {
          info("loop", "date rolled over — injecting date-change reminder");
          history = [...history, dateChange];
          setMessages(history);
        }
        info("loop", `turn ${turn}: calling API`);
        history = await runTurn(history, controller.signal);

        // Recall: aborted on the very first turn before the model produced
        // anything (no content, no thinking, no tool calls). The user message
        // never entered <Static>, so dropping `pendingUser` makes it vanish
        // cleanly; its text goes back into the input box.
        const produced = history[history.length - 1];
        if (
          turn === 1 &&
          produced?.role === "assistant" &&
          produced.interrupted &&
          !produced.content &&
          !produced.reasoning_content &&
          (!produced.tool_calls || produced.tool_calls.length === 0)
        ) {
          info("loop", "turn 1 interrupted before any output — recalled send");
          userHeld = false;
          setPendingUser(null);
          setRecalledText(input);
          setInputKey((k) => k + 1);
          break;
        }

        info("loop", `turn ${turn}: API response received`);
        // First output is in — commit the held user message into <Static>
        // alongside the assistant message (both ride in `history`).
        userHeld = false;
        setMessages(history);
        setPendingUser(null);
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
          // A previous tool was denied — push a minimal result so the API
          // has a response for every tool_call_id, but don't prompt the user.
          if (denied) {
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Error: User denied the tool execution.",
            });
            continue;
          }
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
                  onAllowAlways: (patterns) => {
                    for (const pattern of patterns) {
                      savePermission(pattern);
                      if (!permissionsRef.current.allow.includes(pattern)) {
                        permissionsRef.current.allow.push(pattern);
                      }
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
                  history.filter((m) => m.role === "user" && !m.meta).pop()?.content ||
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
          } else if (tc.function.name === "web_search") {
            info("exec", `web_search start: ${String(args.query || "").slice(0, 80)}`);
            const result = await executeWebSearch(args, {
              tavilyApiKey: config.tavilyApiKey,
            });
            info("exec", `web_search done (${result.content.length} chars, isError=${result.isError})`);
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
            });
          } else if (tc.function.name === "web_fetch") {
            info("exec", `web_fetch start: ${String(args.url || "").slice(0, 120)}`);
            const result = await executeWebFetch(args);
            info("exec", `web_fetch done (${result.content.length} chars, isError=${result.isError})`);
            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.content,
            });
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
        // A real error (not a user abort) before the user message was
        // committed: surface it in the transcript so the failure has context
        // instead of the message silently disappearing with `pendingUser`.
        if (userHeld) setMessages(history);
      }
    } finally {
      setThinking("");
      setResponse("");
      setPendingUser(null);
      // Only tear down if we're still the active run. If a later handleSend
      // already started (concurrent send), it owns abortRef/isStreaming now —
      // clearing them here would orphan its controller (Esc/Ctrl-C could no
      // longer abort it) and flip the streaming UI off mid-run.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
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
        {pendingUser !== null && (
          <MessageItem
            msg={{ role: "user", content: pendingUser }}
            showThinking={false}
            cols={cols}
          />
        )}
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
        {modelOpen ? (
          <ModelPanel
            options={CHAT_MODELS}
            current={config.model}
            onSave={(model) => {
              config.model = model;
              const knownWindow = MODEL_CONTEXT_WINDOWS[model];
              if (knownWindow !== undefined) {
                config.contextWindow = knownWindow;
              }
              saveModel(model);
              info("settings", `model=${model}`);
              setModelOpen(false);
              const userMsg: Message = { role: "user", content: "/model" };
              const note: Message = {
                role: "assistant",
                content: `已保存模型：\`${model}\`（写入 ~/.deepdive/settings.json，下一轮请求起生效）。`,
              };
              setMessages((m) => [...m, userMsg, note]);
            }}
            onCancel={() => setModelOpen(false)}
          />
        ) : settingsOpen ? (
          <SettingsPanel
            specs={[
              {
                kind: "enum",
                key: "model",
                label: "Model",
                options: CHAT_MODELS,
              },
              {
                kind: "enum",
                key: "reasoning",
                label: "Reasoning effort",
                options: REASONING_EFFORTS,
              },
              {
                kind: "enum",
                key: "search",
                label: "Web search engine",
                options: SEARCH_ENGINES,
                // Tavily key shows as a sub-line, only when tavily is picked.
                secret: {
                  key: "tavilyKey",
                  showWhen: "tavily",
                  label: "Tavily API key",
                  helpUrl: "https://app.tavily.com/home",
                },
              },
              {
                kind: "enum",
                key: "language",
                label: "Response language",
                options: RESPONSE_LANGUAGES,
              },
              {
                kind: "enum",
                key: "turnSummary",
                label: "Previous-turn summary",
                options: [
                  {
                    value: "off",
                    label: "off",
                    description: "不压缩上一轮历史，完整保留原始消息",
                  },
                  {
                    value: "whole_turn",
                    label: "whole_turn",
                    description: "压缩两个 user 之间的全部 assistant/tool 消息",
                  },
                  {
                    value: "tool_only",
                    label: "tool_only",
                    description: "只压缩纯 tool-call 链，保留可见 assistant 输出",
                  },
                ],
              },
            ]}
            current={{
              model: config.model,
              reasoning: config.reasoningEffort,
              search: config.searchEngine,
              tavilyKey: config.tavilyApiKey,
              language: config.responseLanguage,
              turnSummary: config.turnSummaryStrategy,
            }}
            onSave={(values) => {
              // Apply live: config is a stable prop object read at
              // request/tool time, so an in-place write takes effect next
              // turn (same in-memory pattern as the permissions ref). Also
              // persist for future sessions.
              const model = values.model!;
              const effort = values.reasoning!;
              const engine = (values.search as "tavily")!;
              const tavilyKey = values.tavilyKey ?? "";
              const language = values.language!;
              const turnSummary =
                values.turnSummary as typeof config.turnSummaryStrategy;
              config.model = model;
              const knownWindow = MODEL_CONTEXT_WINDOWS[model];
              if (knownWindow !== undefined) {
                config.contextWindow = knownWindow;
              }
              config.reasoningEffort = effort;
              config.searchEngine = engine;
              config.tavilyApiKey = tavilyKey;
              // Persisted for the next session. The running session's
              // language is frozen in the system prompt at session start
              // (sessionLanguage memoize in client.ts), so mutating this
              // here does NOT change the current prompt — it only affects a
              // fresh session, keeping the prefix cache intact mid-chat.
              config.responseLanguage = language;
              config.turnSummaryStrategy = turnSummary;
              saveModel(model);
              saveReasoningEffort(effort);
              saveSearchEngine(engine);
              saveTavilyKey(tavilyKey);
              saveResponseLanguage(language);
              saveTurnSummaryStrategy(turnSummary);
              info(
                "settings",
                `model=${model} reasoning=${effort} search=${engine} tavilyKey=${tavilyKey ? "set" : "empty"} language=${language} turnSummary=${turnSummary}`,
              );
              setSettingsOpen(false);
              const userMsg: Message = { role: "user", content: "/settings" };
              const tavilyMissing =
                !tavilyKey
                  ? "（未设置 key，在本面板「Tavily API key」行按 Enter 粘贴即可）"
                  : "";
              const note: Message = {
                role: "assistant",
                content: `已保存：模型 \`${model}\`，推理强度 \`${effort}\`，搜索引擎 \`${engine}\`，Tavily key \`${tavilyKey ? "已设置" : "未设置"}\`，上一轮摘要 \`${turnSummary}\`${tavilyMissing}（写入 ~/.deepdive/settings.json，下一轮起生效）。回复语言 \`${language}\` 已保存，但为不打断当前会话的缓存，**仅对新会话生效**——当前会话维持原语言（与 Claude Code 行为一致）。`,
              };
              setMessages((m) => [...m, userMsg, note]);
            }}
            onCancel={() => setSettingsOpen(false)}
          />
        ) : pendingTool ? (
          <ConfirmBox
            toolName={pendingTool.name}
            args={pendingTool.args}
            warning={pendingTool.warning}
            savePattern={pendingTool.savePattern}
            onApprove={() => {
              pendingTool.onApprove();
              setPendingTool(null);
            }}
            onAllowAlways={(patterns) => {
              pendingTool.onAllowAlways(patterns);
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
            {isCompacting && <Running verb="Compacting conversation" showHint={false} />}
            <InputBox
              key={inputKey}
              initialValue={recalledText}
              onSubmit={handleSend}
              streaming={isStreaming}
              error={error}
              history={messages.filter(m => m.role === "user" && !m.meta).map(m => m.content).reverse()}
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
