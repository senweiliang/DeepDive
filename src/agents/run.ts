import type { Config } from "../config.js";
import type { ApprovalMode, Message, SubagentStep } from "../types.js";
import type { PermissionConfig } from "../tools/permissions.js";
import { streamTurn } from "../turn.js";
import { summarizeArgs } from "../tools/format.js";
import { execute, executeBash } from "../tools/executor.js";
import { executeWebSearch } from "../tools/websearch.js";
import { executeWebFetch } from "../tools/webfetch.js";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";
import { checkPermission } from "../tools/permissions.js";
import { info } from "../log.js";
import { getAgent, getBuiltInAgents, resolveAgentTools } from "./registry.js";
import { GENERAL_PURPOSE_AGENT } from "./builtin.js";

/** Live status for the UI card while a subagent runs. */
export interface SubagentProgress {
  agentType: string;
  turn: number;
  toolCalls: number;
  /** Short label of the current activity, e.g. "thinking" or "grep". */
  activity: string;
}

export interface RunSubagentParams {
  /** Defaults to general-purpose when omitted/empty. */
  agentType?: string;
  /** Short 3-5 word task label (for the UI card / logs). */
  description: string;
  /** The full task briefing handed to the subagent. */
  prompt: string;
  config: Config;
  /** Current approval mode — drives the headless permission gate. */
  mode: ApprovalMode;
  /** Live permission rules from the main session (allow/deny still apply). */
  permissions: PermissionConfig;
  /** Directory the subagent's tools run against. */
  workspace: string;
  signal: AbortSignal;
  /** Hard turn cap (defence against runaway loops). */
  maxTurns?: number;
  onProgress?: (p: SubagentProgress) => void;
  /** Fired once per intermediate tool call, so the caller can record the
   *  subagent's steps for the transcript. Mirrors the toolCalls counter:
   *  fired at invocation (a denied call still counts as a step). */
  onStep?: (step: SubagentStep) => void;
}

export interface RunSubagentResult {
  /** Final assistant message — relayed to the caller as the tool result. */
  text: string;
  isError: boolean;
  turns: number;
  toolCalls: number;
}

/** Fallback turn cap when neither the call nor config sets one. A subagent
 *  runs unsupervised, so it always needs an upper bound. */
const DEFAULT_SUBAGENT_MAX_TURNS = 30;

/**
 * Run one subagent to completion, headless. Mirrors App.handleSend's agent
 * loop (stream → run tools → feed results back → repeat) but with no UI, no
 * approval prompts, and a scoped tool set. Returns the subagent's final text
 * for the caller to relay. The whole point is context isolation: all the
 * intermediate tool noise stays in `history` here and never reaches the
 * parent — only `text` does.
 */
export async function runSubagent(
  params: RunSubagentParams,
): Promise<RunSubagentResult> {
  const { agentType, prompt, config, signal, onProgress } = params;

  // Resolve the agent kind. An explicit-but-unknown type is a model error —
  // report it back instead of silently falling back, so the model can retry.
  if (agentType && !getAgent(agentType)) {
    const available = getBuiltInAgents()
      .map((a) => a.agentType)
      .join(", ");
    return {
      text: `Error: unknown subagent_type "${agentType}". Available types: ${available}.`,
      isError: true,
      turns: 0,
      toolCalls: 0,
    };
  }
  const def = (agentType ? getAgent(agentType) : undefined) ?? GENERAL_PURPOSE_AGENT;
  const tools = resolveAgentTools(def);
  const systemPrompt = def.getSystemPrompt();
  // Model override is wired but currently unused by built-ins; honour it anyway.
  const modelConfig = def.model ? { ...config, model: def.model } : config;
  const cap = params.maxTurns ?? config.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;

  info(
    "subagent",
    `start type=${def.agentType} desc="${params.description}" tools=${tools.length} cap=${cap}`,
  );

  let history: Message[] = [{ role: "user", content: prompt }];
  let turn = 0;
  let totalToolCalls = 0;
  let lastText = "";

  while (turn < cap) {
    if (signal.aborted) {
      return { text: lastText || "(aborted)", isError: true, turns: turn, toolCalls: totalToolCalls };
    }
    turn++;
    onProgress?.({ agentType: def.agentType, turn, toolCalls: totalToolCalls, activity: "thinking" });

    const res = await streamTurn(modelConfig, history, signal, { tools, systemPrompt });
    history = [...history, res.assistant];
    if (res.assistant.content) lastText = res.assistant.content;

    if (res.interrupted) {
      return { text: lastText || "(interrupted)", isError: true, turns: turn, toolCalls: totalToolCalls };
    }

    const calls = res.assistant.tool_calls;
    if (!calls || calls.length === 0 || res.finish_reason !== "tool_calls") {
      info("subagent", `done type=${def.agentType} turns=${turn} toolCalls=${totalToolCalls}`);
      return { text: lastText, isError: false, turns: turn, toolCalls: totalToolCalls };
    }

    const toolResults: Message[] = [];
    for (const tc of calls) {
      if (signal.aborted) {
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Aborted by user." });
        continue;
      }
      const name = tc.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      totalToolCalls++;
      onProgress?.({ agentType: def.agentType, turn, toolCalls: totalToolCalls, activity: name });
      params.onStep?.({ name, summary: summarizeArgs(name, args) });

      const gate = gateSubagentTool(name, args, params.mode, params.permissions);
      if (!gate.allowed) {
        info("subagent", `tool "${name}" blocked: ${gate.reason}`);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: tool "${name}" ${gate.reason}.`,
        });
        continue;
      }

      try {
        const content = await execSubagentTool(name, args, params);
        toolResults.push({ role: "tool", tool_call_id: tc.id, content });
      } catch (err) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    history = [...history, ...toolResults];
  }

  info("subagent", `hit cap type=${def.agentType} cap=${cap}`);
  return {
    text: lastText || `(subagent stopped after reaching the ${cap}-turn cap)`,
    isError: !lastText,
    turns: turn,
    toolCalls: totalToolCalls,
  };
}

/**
 * Headless permission decision. A subagent can't show an approval dialog, so
 * the rule is: honour explicit allow/deny rules, otherwise allow only what
 * would NOT prompt in the current mode. Anything that needs approval is denied
 * with a reason the model can act on (run it in the main session, or switch to
 * acceptEdits/yolo). This reuses the exact mode semantics of the main loop, so
 * a subagent's capabilities are predictable from the mode:
 *   default → read/search only; acceptEdits → +write/edit; yolo → everything.
 *
 * NOTE: out-of-workspace path gating (the main loop's per-call confirm) is not
 * yet applied here — see ROADMAP. In default mode writes are already blocked;
 * in acceptEdits/auto/yolo the user has opted into writes session-wide.
 */
function gateSubagentTool(
  name: string,
  args: Record<string, unknown>,
  mode: ApprovalMode,
  permissions: PermissionConfig,
): { allowed: boolean; reason?: string } {
  const decision = checkPermission(permissions, name, args);
  if (decision === "deny") return { allowed: false, reason: "denied by a permission rule" };
  if (decision === "allow") return { allowed: true };
  if (!toolAllowed(name, mode)) return { allowed: false, reason: `is not available in ${mode} mode` };
  if (toolNeedsApproval(name, mode)) {
    return {
      allowed: false,
      reason:
        "requires user approval, which a subagent cannot request — run it in the main session, or switch to acceptEdits/yolo mode",
    };
  }
  return { allowed: true };
}

/** Execute a single tool the same way the main loop does, but synchronously
 *  awaited (no live UI panel). */
async function execSubagentTool(
  name: string,
  args: Record<string, unknown>,
  params: RunSubagentParams,
): Promise<string> {
  if (name === "bash") {
    const exec = executeBash(args, params.workspace);
    const onAbort = () => exec.abort();
    params.signal.addEventListener("abort", onAbort);
    try {
      const r = await exec.promise;
      return r.content;
    } finally {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
  if (name === "web_search") {
    return (await executeWebSearch(args, { tavilyApiKey: params.config.tavilyApiKey })).content;
  }
  if (name === "web_fetch") {
    return (await executeWebFetch(args)).content;
  }
  // read_file / write_file / edit_file / glob / grep
  return execute(name, args, params.workspace).content;
}
