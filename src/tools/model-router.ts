import type { Config } from "../config.js";
import { info } from "../log.js";

/**
 * Model router: uses deepseek-v4-flash (no thinking) to classify a user
 * message as "pro" or "flash", so the agent can automatically pick the right
 * model without the user manually switching.
 *
 * The KV cache is NOT shared between this classifier call and the main
 * conversation (different system prompts), so we keep the input minimal:
 * only the current user message — no history.
 */

const ROUTER_PROMPT = `You are a model router. Given the user's message, choose which model should handle this request.

Respond with exactly one line in the format:

<model> | <brief reason>

Where <model> is one of: pro, flash.

## Use "pro" when:
- The user wants to write, edit, or refactor code
- Debugging complex issues or analyzing runtime errors
- Architecture or design decisions
- Implementing new features or significant changes
- Running shell commands that modify files or state
- Tasks requiring deep reasoning across multiple files

## Use "flash" when:
- Reading or searching code (read_file, grep, glob)
- Simple questions about how code works
- Web searches or fetching URLs
- Casual conversation, clarifications, or planning
- Quick lookups or one-step operations

## Examples
How do I refactor this async function? → pro | code refactoring
Read the config file and tell me what models are available → flash | simple read
Fix the rate limiting bug in the API handler → pro | debugging complex issue
What does the .gitignore look like? → flash | simple file read
Search for all uses of useCallback in src/ → flash | code search
Implement OAuth2 login flow → pro | implementing new feature
Run pnpm typecheck → pro | running build command
ls -la → pro | shell command
git log --oneline → pro | shell command
What version of React are we using? → flash | simple question

Output only one line: <model> | <reason>.`;

export type ModelRoute = "pro" | "flash";

/**
 * Classify the user message and return which model to use. Also logs the
 * routing decision (with reason) to the session log.
 */
export async function routeModel(
  config: Config,
  userMessage: string,
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
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: 20,
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
