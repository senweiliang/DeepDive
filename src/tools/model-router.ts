import type { Config } from "../config.js";
import { info } from "../log.js";

/**
 * Model router: uses deepseek-v4-pro (no thinking) to classify a user
 * message as "pro" or "flash" based on the user message plus the last few
 * rounds of conversation context, so the agent can automatically pick the
 * right model without the user manually switching.
 *
 * contextMessages (last ~4 user messages, no assistant/tool) helps the
 * router see the task trajectory: if the user has been debugging or building
 * a feature over several turns, even a seemingly simple continuation should
 * stay on "pro".  Only user messages are included — assistant messages span
 * multiple tool_use cycles and thousands of reasoning tokens per turn, and
 * they add noise rather than signal.
 */

const ROUTER_PROMPT = `You are a model router. Given the user's message and the recent conversation context, choose which model should handle this request.

Respond with exactly one line in the format:

<model> | <brief reason>

Where <model> is one of: pro, flash.

The last few user messages from this conversation are provided before the current user message as context. Use them to understand the ongoing task trajectory (debugging session, feature build, code exploration, or simple Q&A).

## Use "flash" when:
- Reading or searching code (read_file, grep, glob)
- Simple questions about how code works
- Web searches or fetching URLs
- Casual conversation, clarifications, or planning
- Quick lookups or one-step operations
- Simple configuration changes, one-line edits, or trivial string changes
- Changing a default value, renaming a config key, or updating a constant
- Running standard project commands (build, test, lint, typecheck, install, format)
- Routine git operations (status, log, diff, add, commit, push)
- Any well-defined, deterministic command whose outcome is predictable

## Use "pro" when:
- Writing, editing, or refactoring complex code
- Debugging complex issues or analyzing runtime errors
- Architecture or design decisions
- Implementing new features or significant changes
- Tasks requiring deep reasoning or multi-step analysis across files
- Ambiguous or open-ended problems where the right approach isn't obvious

## Examples
Refactor the auth module to use JWT → pro | refactoring complex code
Read the config file and tell me what models are available → flash | simple read
Fix the rate limiting bug in the API handler → pro | debugging complex issue
What does the .gitignore look like? → flash | simple file read
Search for all uses of useCallback in src/ → flash | code search
Implement OAuth2 login flow → pro | implementing new feature
Run pnpm typecheck → flash | standard project command
ls -la → flash | deterministic command
git log --oneline → flash | routine git operation
git push origin master → flash | routine git operation
Debug why the CI pipeline failed → pro | debugging complex issue
What version of React are we using? → flash | simple question
Change the default model from pro to auto → flash | simple configuration change

Output only one line: <model> | <reason>.`;

export type ModelRoute = "pro" | "flash";

/**
 * Classify the user message and return which model to use. Also logs the
 * routing decision (with reason) to the session log.
 *
 * @param config - API config (base URL, key, etc.)
 * @param userMessage - The current turn's user message.
 * @param contextMessages - Last ~4 user messages from the recent history,
 *   NOT including the current userMessage.  Helps the router see task
 *   trajectory so a single-turn look isn't mistaken for simple.
 */
export async function routeModel(
  config: Config,
  userMessage: string,
  contextMessages?: Array<{ role: string; content: string }>,
): Promise<ModelRoute> {
  const log = (result: string, src: string, reason?: string) =>
    info(
      "model-router",
      `${result} [${src}]${reason ? ` — ${reason}` : ""}: ${userMessage.slice(0, 100)}`,
    );

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          ...(contextMessages || []).map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
          { role: "user", content: userMessage },
        ],
        max_tokens: 50,
        temperature: 0,
        stream: false,
        thinking: { type: "disabled" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      log("pro", `fallback (API ${response.status}: ${errText.slice(0, 100)})`);
      return "pro";
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    const parts = text.split("|");
    const verdict = parts[0]?.trim().toLowerCase() || "";
    const reason = parts[1]?.trim() || "";

    if (verdict === "flash") {
      log("flash", "model", reason);
      return "flash";
    }
    log("pro", verdict === "pro" ? "model" : `fallback [raw: ${text.slice(0, 50)}]`, reason);
    return "pro";
  } catch (err) {
    log("pro", `fallback (error: ${err instanceof Error ? err.message : String(err)})`);
    return "pro";
  }
}
