import type { Config } from "./config.js";
import type { Message } from "./types.js";
import { streamTurn } from "./turn.js";

export interface SideQuestionResult {
  response: string | null;
}

/**
 * DeepDive's port of Claude Code's "/btw" side question: answer one quick
 * aside without touching the main conversation's history or aborting it.
 *
 * `history` must be the SAME array the main loop would send next (i.e.
 * `ensureAgentListing(ensureSkillListing(messages))`), with no `tools`
 * override — buildBody() is a pure function of (config, messages), so an
 * unmodified prefix reproduces the exact bytes of the main loop's last (or
 * in-flight) request and rides its DeepSeek prefix cache for free. Unlike
 * Claude Code we don't need an explicit snapshot of "the last request's
 * params" for this — there's no per-turn system-prompt variance here to
 * capture, so simply reusing current `messages` already guarantees the
 * byte-identical prefix.
 *
 * Tools are left enabled (not stripped) for the same cache-safety reason;
 * the system-reminder below tells the model not to use them, and any
 * tool_calls it makes anyway are reported, never executed — this is a single
 * turn with no follow-up.
 */
export async function runSideQuestion(
  config: Config,
  history: Message[],
  question: string,
  signal: AbortSignal,
): Promise<SideQuestionResult> {
  const wrapped: Message = {
    role: "user",
    content: `<system-reminder>This is a side question from the user, asked with /btw. Answer it directly in this single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight instance spawned to answer this one question.
- The main agent is NOT interrupted — it keeps working independently in the background.
- You share the conversation context but are a completely separate turn.
- Do NOT reference being interrupted or what you were "previously doing" — that framing is incorrect.

CONSTRAINTS:
- You have NO tools available. Even if the tool list below appears in the schema, they are blocked.
  If asked whether you can read files, search, or execute commands, the answer is "no" for this
  side question — answer only from what you already know.
- Never say things like "Let me check...", "I'll look into...", or promise to take any action.
- If you don't know the answer, say so directly — do not offer to investigate.</system-reminder>

${question}`,
  };

  const result = await streamTurn(config, [...history, wrapped], signal);
  if (result.interrupted) return { response: null };

  const text = result.assistant.content?.trim();
  if (text) return { response: text };

  const toolCall = result.assistant.tool_calls?.[0];
  if (toolCall) {
    return {
      response: `(The model tried to call \`${toolCall.function.name}\` instead of answering directly. Try rephrasing, or ask in the main conversation.)`,
    };
  }

  return { response: null };
}
