/**
 * AI session-title generation — port of Claude Code's
 * `src/utils/sessionTitle.ts` (Haiku → DeepSeek flash, sentence-case →
 * concise Chinese).
 *
 * One-shot, fire-and-forget: called once after the first real user message of
 * a FRESH session (never on resume). Failures return null silently — the
 * session just keeps its default/`/rename` title.
 */

import type { Config } from "./config.js";
import { resolveModel } from "./config.js";
import type { Message } from "./types.js";

export const SESSION_TITLE_TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_TITLE_TOKENS = 100;

export const SESSION_TITLE_PROMPT = [
  "为这个编码会话生成一个简洁的中文标题（3-10 字），准确概括会话的主要任务或目标。标题要足够清晰，让用户在会话列表中能一眼认出。",
  "",
  "只返回 JSON：{\"title\": \"...\"}",
  "",
  "好例子：",
  "{\"title\": \"修复移动端登录按钮\"}",
  "{\"title\": \"添加 OAuth 认证\"}",
  "{\"title\": \"排查 CI 测试失败\"}",
  "{\"title\": \"重构 API 客户端错误处理\"}",
  "",
  "坏例子（太笼统）：{\"title\": \"代码修改\"}",
  "坏例子（太长）：{\"title\": \"调查并修复移动设备上登录按钮无法响应的问题\"}",
  "坏例子（口语化）：{\"title\": \"帮我搞一下那个登录的 bug\"}",
].join("\n");

/** Tolerant `{"title":"..."}` extraction (survives markdown fences / stray text). */
export function extractTitleJson(text: string): string | null {
  const m = text.match(/"title"\s*:\s*"([^"]*)"/);
  if (!m) return null;
  const title = m[1]!.trim();
  return title.length > 0 ? title : null;
}

/**
 * First real user-message text: skips meta messages, slash commands (`/…`)
 * and inline bash (`!…`), tail-capped so recent context isn't flooded with
 * a pasted blob.
 */
export function firstRealUserText(messages: Message[]): string | null {
  for (const msg of messages) {
    if (msg.role !== "user" || msg.meta) continue;
    const text = msg.content.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) continue;
    return text.slice(0, MAX_DESCRIPTION_LENGTH);
  }
  return null;
}

/**
 * Generate a session title from the user's first message, via the summary
 * model (flash). Returns null on ANY failure — the caller treats it as
 * "no title, keep the default" and never retries this session.
 */
export async function generateSessionTitle(
  config: Config,
  description: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const trimmed = description.trim();
  if (!trimmed) return null;

  const model = resolveModel(config.summaryModel || config.model);
  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [SESSION_TITLE_PROMPT, "", trimmed].join("\n"),
      },
    ],
    max_tokens: MAX_TITLE_TOKENS,
    // "none" (not "off") is the API's no-thinking level: with any thinking
    // enabled the reasoning phase eats the whole 100-token budget and
    // `content` comes back empty (finish_reason: length → no title).
    reasoning_effort: "none",
    stream: false,
  });

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      ...(signal ? { signal } : {}),
    } as RequestInit);
    if (!response.ok) return null;
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    return typeof content === "string" ? extractTitleJson(content) : null;
  } catch {
    return null;
  }
}
