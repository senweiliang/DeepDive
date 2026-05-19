import type { Message } from "./types.js";

export const TURN_SUMMARY_PREFIX = "<previous-turn-summary>\n";
export const TURN_SUMMARY_SUFFIX = "\n</previous-turn-summary>";

export const TURN_SUMMARY_INSTRUCTION = [
  "Summarize the previous user turn so it can replace the raw assistant/tool-call chain in future context.",
  "",
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Do NOT include a preamble.",
  "",
  "Keep the summary compact but complete enough for the next turn to continue without re-reading the raw reasoning.",
  "Cover:",
  "- The user's request and intent.",
  "- Files, functions, and code regions inspected or changed.",
  "- Tool results that matter.",
  "- The final conclusion or proposed plan.",
  "- Any pending next action if the user confirms.",
].join("\n");

export function makeTurnSummaryMessage(summary: string): Message {
  return {
    role: "user",
    meta: true,
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
    if (msg.role === "user" && !msg.meta && !isTurnSummaryMessage(msg)) {
      return i;
    }
  }
  return -1;
}

export function previousTurnMessages(messages: Message[]): Message[] {
  const start = previousTurnStart(messages);
  return start === -1 ? [] : messages.slice(start);
}

export function previousTurnNeedsSummary(messages: Message[]): boolean {
  const turn = previousTurnMessages(messages);
  if (turn.length === 0) return false;
  if (turn.some(isTurnSummaryMessage)) return false;
  return turn.some(
    (msg) =>
      msg.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0,
  );
}

export function shouldSummarizePreviousTurn(
  messages: Message[],
): boolean {
  return previousTurnNeedsSummary(messages);
}

export function applyTurnSummaries(messages: Message[]): Message[] {
  const out: Message[] = [];

  for (const msg of messages) {
    if (!isTurnSummaryMessage(msg)) {
      out.push(msg);
      continue;
    }

    for (let i = out.length - 1; i >= 0; i--) {
      const candidate = out[i]!;
      if (
        candidate.role === "user" &&
        !candidate.meta &&
        !isTurnSummaryMessage(candidate)
      ) {
        out.splice(i);
        break;
      }
    }
    out.push(msg);
  }

  return out;
}
