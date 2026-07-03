// Engine bridge: routes invoke/listen through the real Tauri bridge when it is
// present (window.__TAURI__, injected by the desktop shell via withGlobalTauri)
// and otherwise falls back to a full dev mock that reproduces the protocol used
// by `vite dev` — including the live-streamed demoRun reply.
//
// The real path is intentionally tiny; all demo data lives in the mock below.
// The only stable backend surface is invoke(command) + listen("agent-event").

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 — Command arg / return shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface AppInfo {
  model: string;
  mode: string;
  cwd: string;
  /** camelCase on the wire */
  contextWindow: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  /** unix seconds */
  mtime: number;
}

export interface ResumedMessage {
  /** "user" | "assistant" | "summary" */
  role: string;
  content: string;
  interrupted: boolean;
  /** persisted reasoning on assistant turns; null/absent otherwise */
  thinking?: string | null;
}

export interface ModelOption {
  value: string;
  label: string;
  description: string;
  current: boolean;
}

export interface SettingsInfo {
  model: string;
  reasoning_effort: string;
  response_language: string;
  turn_summary: string;
  tavily_set: boolean;
  models: string[];
  reasoning_efforts: string[];
  response_languages: string[];
  turn_summaries: string[];
}

export interface AgentInfo {
  name: string;
  source: string;
  tools: string;
  model: string;
  when_to_use: string;
}

export interface SaveApiKeyArgs {
  key: string;
}
export interface ResumeSessionArgs {
  id: string;
}
export interface RenameSessionArgs {
  title: string;
}
export interface SetModeArgs {
  /** a MODES[].id */
  mode: string;
}
export interface ApproveArgs {
  id: number;
  /** "approve" | "deny" | "always" */
  decision: string;
}
export interface AnswerArgs {
  id: number;
  /** keyed by question text; null = decline/cancel */
  answers: Record<string, string> | null;
}
export interface SubmitArgs {
  input: string;
}
export interface SetModelArgs {
  model: string;
}
export interface SaveSettingsArgs {
  model: string;
  reasoningEffort: string;
  responseLanguage: string;
  turnSummary: string;
  /** empty/absent → null = keep unchanged */
  tavilyKey?: string | null;
}
export interface AddDirArgs {
  path: string;
  persist: boolean;
}

/** Maps each command name to its return type (for typed `invoke`). */
export interface CommandReturns {
  app_info: AppInfo;
  need_setup: boolean;
  save_api_key: null;
  list_sessions: SessionSummary[];
  resume_session: ResumedMessage[];
  new_session: null;
  rename_session: null;
  balance: string | null;
  set_mode: null;
  approve: null;
  answer: null;
  submit: null;
  abort: null;
  compact: null;
  set_model: null;
  list_models: ModelOption[];
  get_settings: SettingsInfo;
  save_settings: null;
  list_agents: AgentInfo[];
  add_dir: string;
}

export type CommandName = keyof CommandReturns;

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 — agent-event payload (discriminated union on `kind`)
// ─────────────────────────────────────────────────────────────────────────────

export interface QuestionItem {
  question: string;
  header?: string;
  options: string[];
  multiSelect: boolean;
}

export type AgentEventPayload =
  | { kind: "turnStarted"; turn: number }
  | { kind: "thinking"; text: string }
  | { kind: "content"; text: string }
  | { kind: "bashOutput"; chunk: string }
  | { kind: "assistant"; content: string; interrupted?: boolean }
  | { kind: "toolStarted"; callId: string; name: string; summary: string }
  | { kind: "toolFinished"; callId: string; tag: string; ok: boolean; preview: string }
  | {
      kind: "subagentProgress";
      callId: string;
      turn: number;
      toolCalls: number;
      activity: string;
      agentType?: string;
    }
  | { kind: "subagentStep"; callId: string; name: string; summary: string }
  | {
      kind: "usage";
      input: number;
      output: number;
      cacheHit: number;
      cacheMiss: number;
      reasoning: number;
    }
  | { kind: "bgTasks"; running: number }
  | { kind: "recall"; text: string }
  | { kind: "turnComplete" }
  | { kind: "error"; message: string }
  | {
      kind: "approval";
      id: number;
      toolName: string;
      /** JSON string, pretty-printed by the UI */
      args: string;
      warning?: string;
      savePatterns?: string[];
    }
  | { kind: "question"; id: number; items: QuestionItem[] };

/** Event listener callback. */
export type EventCallback<T> = (event: { payload: T }) => void;
export type UnlistenFn = () => void;

// ─────────────────────────────────────────────────────────────────────────────
// Real Tauri bridge shape (subset we touch)
// ─────────────────────────────────────────────────────────────────────────────

interface TauriBridge {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  event?: { listen?: (name: string, cb: EventCallback<unknown>) => Promise<UnlistenFn> };
}

const realBridge = (globalThis as { __TAURI__?: TauriBridge }).__TAURI__;
const realInvoke = realBridge?.core?.invoke;
const realListen = realBridge?.event?.listen;

/** True when running against the dev mock (no real Tauri bridge present). */
export const isMock: boolean = !realInvoke;

// ─────────────────────────────────────────────────────────────────────────────
// Dev mock — full protocol reproduction (ported from dist/preview.html)
// ─────────────────────────────────────────────────────────────────────────────

const mockListeners: Record<string, EventCallback<unknown>> = {};

function emit(payload: AgentEventPayload): void {
  const cb = mockListeners["agent-event"] as
    | EventCallback<AgentEventPayload>
    | undefined;
  cb?.({ payload });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

let pvBusy = false;

async function demoRun(_input: string): Promise<void> {
  pvBusy = true;
  emit({ kind: "turnStarted", turn: 1 });

  const think =
    "用户想了解项目结构。先用 glob 扫描源码，再按层次总结关键模块与入口。";
  for (let i = 6; i <= think.length; i += 5) {
    emit({ kind: "thinking", text: think.slice(0, i) });
    await sleep(34);
  }

  emit({ kind: "toolStarted", callId: "t1", name: "glob", summary: "crates/**/*.rs" });
  await sleep(520);
  emit({
    kind: "toolFinished",
    callId: "t1",
    tag: "34 matches",
    ok: true,
    preview:
      "crates/deepdive-core/src/engine.rs\ncrates/deepdive-core/src/client.rs\ncrates/deepdive-core/src/bridge.rs\ncrates/deepdive-cli/src/main.rs\ncrates/deepdive-gui/src/main.rs\n…",
  });
  await sleep(280);

  const out =
    "## 项目结构\n\nDeepDive 是用 **Rust** 编写的终端编程助手，核心分三层，全部共享 `deepdive-core` 引擎：\n\n" +
    "- `deepdive-core` — 引擎（无 UI，事件驱动）\n- `deepdive-cli` — headless `exec` + 交互 REPL\n- `deepdive-gui` — 当前这个 Tauri 桌面应用\n\n" +
    "关键入口是 `engine::run_turn_loop`：\n\n```rust\npub async fn run_turn_loop(\n    client: &Client,\n    session: &mut Session,\n    events: &Sender<AgentEvent>,\n) -> TurnLoopOutcome {\n    // stream → tools → 回灌 → 重复\n    let count = 42;\n}\n```\n\n" +
    "我对入口做了一处小改动：\n\n```diff\n--- a/crates/deepdive-core/src/engine.rs\n+++ b/crates/deepdive-core/src/engine.rs\n@@ -120,7 +120,8 @@ pub async fn run_turn_loop(\n     let mut session = Session::new(&config);\n-    let notify = session.tasks.completion_notify();\n+    let mut notify = session.tasks.completion_notify();\n+    let bg_cancel = CancellationToken::new();\n     loop {\n```\n\n" +
    "| 前端 | 形态 |\n|---|---|\n| exec | 一次性 |\n| repl | 行交互 |\n| gui | 桌面 |\n\n> 所有前端只是同一引擎的「薄」消费者。\n\n需要我深入看 `run_turn_loop` 的实现吗？";

  for (let i = 8; i <= out.length; i += 7) {
    emit({ kind: "content", text: out.slice(0, i) });
    await sleep(14);
  }
  emit({ kind: "assistant", content: out });
  emit({
    kind: "usage",
    input: 642000,
    output: 142,
    cacheHit: 580000,
    cacheMiss: 62000,
    reasoning: 1240,
  });
  emit({ kind: "bgTasks", running: 1 });
  emit({ kind: "turnComplete" });
  pvBusy = false;
}

async function mockInvoke(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  switch (cmd) {
    case "app_info":
      return {
        model: "deepseek-v4-flash",
        mode: "auto",
        cwd: "/Users/you/project",
        contextWindow: 1_000_000,
      } satisfies AppInfo;

    case "need_setup":
      return typeof location !== "undefined" && location.hash === "#setup";

    case "save_api_key":
      return null;

    case "list_sessions":
      return [
        { id: "a", title: "重构鉴权模块，提取 token 校验", mtime: now() - 240 },
        { id: "b", title: "修复流式渲染的段间空行抖动", mtime: now() - 7200 },
        { id: "c", title: "分析 /Users/you/Downloads/server.log", mtime: now() - 86400 * 3 },
        { id: "d", title: "为 SSE 解码器补单元测试", mtime: now() - 86400 * 9 },
      ] satisfies SessionSummary[];

    case "balance":
      return "12.34 CNY";

    case "list_models":
      return [
        { value: "deepseek-v4-pro", label: "pro", description: "DeepSeek V4 Pro", current: true },
        { value: "deepseek-v4-flash", label: "flash", description: "DeepSeek V4 Flash", current: false },
      ] satisfies ModelOption[];

    case "set_model":
      return null;

    case "get_settings":
      return {
        model: "deepseek-v4-pro",
        reasoning_effort: "high",
        response_language: "auto",
        turn_summary: "off",
        tavily_set: true,
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
        reasoning_efforts: ["none", "low", "medium", "high", "max", "xhigh"],
        response_languages: ["auto", "zh", "zh-Hant", "en", "ja", "ko"],
        turn_summaries: ["off", "whole_turn", "tool_only"],
      } satisfies SettingsInfo;

    case "save_settings":
      return null;

    case "rename_session":
      return null;

    case "add_dir":
      return (
        ((args?.persist as boolean | undefined)
          ? "已添加（工作区所有会话）："
          : "已添加（仅本会话）：") + String(args?.path ?? "")
      );

    case "list_agents":
      return [
        {
          name: "general",
          source: "内置",
          tools: "全部工具",
          model: "继承",
          when_to_use: "通用多步任务与代码检索的兜底代理。",
        },
        {
          name: "explore",
          source: "内置",
          tools: "read_file, glob, grep",
          model: "继承",
          when_to_use: "只读检索：跨多文件/目录广度扫描，只要结论不要正文。",
        },
        {
          name: "reviewer",
          source: "项目",
          tools: "read_file, grep",
          model: "deepseek-v4-pro",
          when_to_use: "对改动做对抗式代码审查，给出可定位的问题清单。",
        },
      ] satisfies AgentInfo[];

    case "submit":
      // busy → queued, no new turn (matches the backend busy coupling)
      if (!pvBusy) void demoRun(String(args?.input ?? ""));
      return null;

    case "resume_session":
      return [
        {
          role: "summary",
          content:
            "用户请求重构鉴权模块。我们提取了 `verify_token`，补了 3 个单测，并修复了过期判定的 off-by-one。后续：把刷新逻辑也抽出来。",
          interrupted: false,
        },
        { role: "user", content: "看看这个会话的历史", interrupted: false },
        {
          role: "assistant",
          content:
            "这是一个**已恢复**的会话示例。\n\n```bash\ncargo test --workspace # 跑全量\n```\n\n共 154 个测试通过。",
          interrupted: true,
          thinking:
            "用户想看历史会话。恢复的 transcript 现在能带回当时的思考过程：先确认测试入口，再跑全量并汇总结果。",
        },
      ] satisfies ResumedMessage[];

    // §8.21 — these 6 are absent from the original preview mock; the real
    // backend implements them. Explicit no-op cases here for clarity.
    case "approve":
    case "answer":
    case "abort":
    case "set_mode":
    case "new_session":
    case "compact":
      return null;

    default:
      return null;
  }
}

async function mockListen(
  name: string,
  cb: EventCallback<unknown>,
): Promise<UnlistenFn> {
  mockListeners[name] = cb;
  return () => {
    delete mockListeners[name];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — tiny real path, mock fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invoke an engine command. Returns are typed per `CommandReturns` for known
 * command names; arbitrary names fall back to `unknown`.
 */
export function invoke<K extends CommandName>(
  cmd: K,
  args?: Record<string, unknown>,
): Promise<CommandReturns[K]>;
export function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
export function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return realInvoke ? realInvoke(cmd, args) : mockInvoke(cmd, args);
}

/**
 * Subscribe to a Tauri event channel (the app uses `"agent-event"`). Resolves to
 * an unlisten function.
 */
export function listen<T = AgentEventPayload>(
  event: string,
  cb: EventCallback<T>,
): Promise<UnlistenFn> {
  return realListen
    ? realListen(event, cb as EventCallback<unknown>)
    : mockListen(event, cb as EventCallback<unknown>);
}

// Dev-only: expose the mock emitter so events the demo flow never produces
// (approval / question / recall / error) can be fired by hand in `vite dev` or by
// automated UI tests, e.g. `window.__ddEmit({ kind: "approval", ... })`. No-op
// against the real Tauri backend.
if (isMock && typeof window !== "undefined") {
  (window as unknown as { __ddEmit?: (p: AgentEventPayload) => void }).__ddEmit = emit;
}
