import type { Config } from "./config.js";
import type { Message } from "./types.js";
import { streamTurn } from "./turn.js";

export interface SideQuestionResult {
  response: string | null;
}

const SIDE_QUESTION_REMINDER = `<system-reminder>This is a side question from the user, started with /btw. Answer directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question.
- The main agent is NOT interrupted — it keeps working independently in the background.
- You share the conversation context but are a completely separate instance.
- Do NOT reference being interrupted or what you were "previously doing" — that framing is incorrect.

CONSTRAINTS:
- You have NO tools available — they are physically stripped from this request.
  If asked whether you can read files, search, or execute commands, the answer is "no" for this
  side question — answer only from what you already know from the conversation context.
- This is a one-off response — there will be no follow-up turns.
- Never say things like "Let me check...", "I'll look into...", or promise to take any action.
- If you don't know the answer, say so directly — do not offer to investigate.</system-reminder>`;

/**
 * DeepDive's port of Claude Code's "/btw" side question — extended to allow a
 * few quick follow-ups in the same side thread (upstream Claude Code caps
 * this at one turn; here `priorExchanges` lets the panel keep going).
 *
 * `mainHistory` must be the SAME array the main loop would send next (i.e.
 * `ensureAgentListing(ensureSkillListing(messages))`), with no `tools`
 * override — buildBody() is a pure function of (config, messages), so an
 * unmodified prefix reproduces the exact bytes of the main loop's last (or
 * in-flight) request and rides its DeepSeek prefix cache for free. Unlike
 * Claude Code we don't need an explicit snapshot of "the last request's
 * params" for this — there's no per-turn system-prompt variance here to
 * capture, so simply reusing current `messages` already guarantees the
 * byte-identical prefix.
 *
 * `priorExchanges` are this side thread's own already-answered turns
 * (plain user/assistant message pairs, no reminder wrapper) — appended after
 * `mainHistory` so later follow-ups share the cache built by earlier ones.
 * The reminder is only prepended to the FIRST question in the thread.
 *
 * Tools are left at their default (not stripped) for the same cache-safety
 * reason; the reminder tells the model not to call them, and any tool_calls
 * it makes anyway are reported, never executed.
 *
 * Tools are stripped (empty array) so the LLM physically cannot call any.
 * This creates its own cache dimension — the first request misses, but
 * follow-ups within this thread hit it. The main session's full-tools
 * cache is unaffected.
 */
export async function runSideQuestion(
  config: Config,
  mainHistory: Message[],
  priorExchanges: Message[],
  question: string,
  signal: AbortSignal,
): Promise<SideQuestionResult> {
  const questionMsg: Message = {
    role: "user",
    content:
      priorExchanges.length === 0
        ? `${SIDE_QUESTION_REMINDER}\n\n${question}`
        : question,
  };

  const result = await streamTurn(
    config,
    [...mainHistory, ...priorExchanges, questionMsg],
    signal,
    { tools: [] },
  );
  if (result.interrupted) return { response: null };

  const text = result.assistant.content?.trim();
  if (text) return { response: text };

  // `turn.ts` copies `reasoning_content` to `content` when content is
  // empty (no tool calls), so the check above already covers most cases.
  // Still check reasoning as a belt-and-suspenders fallback.
  const reasoning = result.assistant.reasoning_content?.trim();
  if (reasoning) return { response: reasoning };

  return { response: null };
}
