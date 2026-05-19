import type { Message, TurnSummaryStrategy } from "./types.js";

export const TURN_SUMMARY_PREFIX = "<previous-turn-summary>\n";
export const TURN_SUMMARY_SUFFIX = "\n</previous-turn-summary>";
const TOOL_ONLY_MIN_BLOCKS = 2;

export const TURN_SUMMARY_INSTRUCTION = [
  "Summarize the selected messages from the previous user turn so the summary can replace those raw messages in future context.",
  "",
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Do NOT include a preamble.",
  "",
  "Preserve facts needed for follow-up work:",
  "- The user's request and intent if it appears in the selected messages.",
  "- Files, functions, and code regions inspected or changed.",
  "- Tool results that matter, including exact short snippets when important.",
  "- The assistant's visible conclusion or proposed plan if present.",
  "- Any pending next action if the user confirms.",
].join("\n");

function hasToolCalls(msg: Message): boolean {
  return (
    msg.role === "assistant" &&
    Array.isArray(msg.tool_calls) &&
    msg.tool_calls.length > 0
  );
}

function hasVisibleContent(msg: Message): boolean {
  return msg.content.trim().length > 0;
}

function isRealUser(msg: Message): boolean {
  return msg.role === "user" && !msg.meta && !isTurnSummaryMessage(msg);
}

function messageToolCallIds(msg: Message): Set<string> {
  return new Set(hasToolCalls(msg) ? msg.tool_calls!.map((tc) => tc.id) : []);
}

export function makeTurnSummaryMessage(
  summary: string,
  strategy: Exclude<TurnSummaryStrategy, "off">,
): Message {
  return {
    role: "user",
    meta: true,
    turn_summary_strategy: strategy,
    content: TURN_SUMMARY_PREFIX + summary + TURN_SUMMARY_SUFFIX,
  };
}

export function isTurnSummaryMessage(msg: Message): boolean {
  return (
    msg.role === "user" &&
    typeof msg.content === "string" &&
    msg.content.startsWith(TURN_SUMMARY_PREFIX)
  );
}

export function previousTurnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (isRealUser(msg)) return i;
  }
  return -1;
}

export function previousTurnMessages(messages: Message[]): Message[] {
  const start = previousTurnStart(messages);
  return start === -1 ? [] : messages.slice(start).filter((msg) => !msg.meta);
}

export interface TurnSummaryBlock {
  strategy: Exclude<TurnSummaryStrategy, "off">;
  messages: Message[];
}

function summaryMessagePayload(msg: Message): Record<string, unknown> {
  if (msg.role === "assistant") {
    return {
      role: msg.role,
      reasoning_content: msg.reasoning_content,
      tool_calls: msg.tool_calls,
    };
  }
  if (msg.role === "tool") {
    return {
      role: msg.role,
      tool_call_id: msg.tool_call_id,
      content: msg.content,
    };
  }
  return {
    role: msg.role,
    content: msg.content,
  };
}

export function buildTurnSummaryRequest(
  messages: Message[],
  instruction = TURN_SUMMARY_INSTRUCTION,
): Message[] {
  return [
    {
      role: "user",
      content: [
        instruction,
        "",
        "Selected messages as JSON text:",
        JSON.stringify(messages.map(summaryMessagePayload), null, 2),
      ].join("\n"),
    },
  ];
}

export function previousTurnSummaryBlocks(
  messages: Message[],
  strategy: TurnSummaryStrategy,
): TurnSummaryBlock[] {
  if (strategy === "off") return [];

  const turn = previousTurnMessages(messages);
  if (turn.length === 0) return [];

  if (strategy === "whole_turn") {
    const nonUser = turn.filter((msg) => !isRealUser(msg));
    return nonUser.length > 0 ? [{ strategy, messages: turn }] : [];
  }

  const blocks: TurnSummaryBlock[] = [];
  for (let i = 0; i < turn.length;) {
    const runStart = i;
    const runMessages: Message[] = [];
    let runBlocks = 0;

    while (i < turn.length) {
      const end = toolOnlyCanReplace(turn, i);
      if (end === -1) break;
      runMessages.push(...turn.slice(i, end));
      runBlocks++;
      i = end;
    }

    if (runBlocks >= TOOL_ONLY_MIN_BLOCKS) {
      blocks.push({ strategy, messages: runMessages });
      continue;
    }

    i = runStart + 1;
  }
  return blocks;
}

export function shouldSummarizePreviousTurn(
  messages: Message[],
  strategy: TurnSummaryStrategy,
): boolean {
  return previousTurnSummaryBlocks(messages, strategy).length > 0;
}

function nextSummaryIndex(
  summaries: Message[],
  strategy: Exclude<TurnSummaryStrategy, "off">,
  start: number,
): number {
  for (let i = start; i < summaries.length; i++) {
    const summary = summaries[i]!;
    if ((summary.turn_summary_strategy ?? "whole_turn") === strategy) return i;
  }
  return -1;
}

function toolOnlyCanReplace(turn: Message[], index: number): number {
  const msg = turn[index]!;
  if (!hasToolCalls(msg) || hasVisibleContent(msg)) return -1;

  const expected = messageToolCallIds(msg);
  const found = new Set<string>();
  let j = index + 1;
  while (j < turn.length) {
    const next = turn[j]!;
    if (next.role !== "tool") break;
    if (!next.tool_call_id || !expected.has(next.tool_call_id)) break;
    found.add(next.tool_call_id);
    j++;
  }
  return found.size === expected.size ? j : -1;
}

function applySummariesToTurn(
  turn: Message[],
  summaries: Message[],
): Message[] {
  let wholeIdx = nextSummaryIndex(summaries, "whole_turn", 0);
  if (wholeIdx !== -1) {
    return [turn[0]!, summaries[wholeIdx]!];
  }

  const out: Message[] = [];
  let summaryIdx = 0;
  for (let i = 0; i < turn.length;) {
    const runStart = i;
    let runBlocks = 0;

    while (i < turn.length) {
      const end = toolOnlyCanReplace(turn, i);
      if (end === -1) break;
      runBlocks++;
      i = end;
    }

    const nextIdx = nextSummaryIndex(summaries, "tool_only", summaryIdx);
    if (runBlocks >= TOOL_ONLY_MIN_BLOCKS && nextIdx !== -1) {
      out.push(summaries[nextIdx]!);
      summaryIdx = nextIdx + 1;
      continue;
    }

    if (i > runStart) {
      out.push(...turn.slice(runStart, i));
      continue;
    }

    out.push(turn[i]!);
    i++;
  }
  return out;
}

export function applyTurnSummaries(
  messages: Message[],
  strategy: TurnSummaryStrategy,
): Message[] {
  if (strategy === "off") {
    return messages.filter((msg) => !isTurnSummaryMessage(msg));
  }

  const out: Message[] = [];
  let turnStart = -1;
  let turnSummaries: Message[] = [];

  const flushTurn = () => {
    if (turnStart === -1) {
      out.push(...turnSummaries);
    } else {
      const prefixLen = turnStart;
      const turn = out.slice(prefixLen);
      out.splice(prefixLen);
      out.push(...applySummariesToTurn(turn, turnSummaries));
    }
    turnStart = -1;
    turnSummaries = [];
  };

  for (const msg of messages) {
    if (isTurnSummaryMessage(msg)) {
      turnSummaries.push(msg);
      continue;
    }

    if (isRealUser(msg)) {
      flushTurn();
      turnStart = out.length;
    }
    out.push(msg);
  }
  flushTurn();

  return out;
}
