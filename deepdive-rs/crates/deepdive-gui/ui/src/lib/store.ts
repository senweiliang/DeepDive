// store.ts — central state + logic for the DeepDive GUI.
//
// This is the keystone module: components are thin renderers that import the
// signals/store and call the action functions defined here. It owns:
//   • the structured `state` store (§7) + high-churn `liveThinking`/`liveContent`/`toasts` signals,
//   • `handleEvent(payload)` — the single agent-event dispatcher (§2.2 + §8 edge cases),
//   • command wrappers around `invoke` (submit/abort/setMode/…),
//   • message + tool-card mutation actions,
//   • modal helpers + the question state machine,
//   • slash dispatch, toasts, theme, and the boot flow (§1.2).
//
// Conventions enforced here:
//   • `⎿` (U+23BF) is ALWAYS followed by exactly ONE space.
//   • Block spacing lives in CSS only — never inline margin.
//   • Streaming `thinking`/`content` are cumulative (replace); `bashOutput` appends.

import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import { createSignal } from "solid-js";

import {
  invoke,
  type AgentEventPayload,
  type AppInfo,
  type SettingsInfo,
  type ModelOption,
  type AgentInfo,
  type SessionSummary,
  type ResumedMessage,
  type QuestionItem,
} from "./tauri";
import { MODES, type ModeId, type Mode, SLASH } from "./format";
import { renderMarkdown } from "./md";

// Re-export `renderMarkdown` under the short name components use for `.body`/`.cd-body`.
export const md = renderMarkdown;

// ─────────────────────────────────────────────────────────────────────────────
// Types — the message discriminated union, tool cards, usage, modal state (§7)
// ─────────────────────────────────────────────────────────────────────────────

export type Msg =
  | { type: "user"; id: number; text: string; queued: boolean }
  | {
      type: "assistant";
      id: number;
      thinking: string;
      content: string;
      interrupted: boolean;
      hasThinking: boolean;
    }
  | { type: "assistantPlain"; id: number; content: string; interrupted: boolean }
  | { type: "summary"; id: number; content: string }
  | { type: "error"; id: number; message: string }
  | { type: "tool"; id: number; callId: string };

export interface ToolCard {
  name: string;
  summary: string;
  /** dot class — fully replaced on finish (run → ok | err), never additive. */
  dot: "run" | "ok" | "err";
  ok: boolean;
  tag: string;
  tagErr: boolean;
  /** formatted preview lines (line 0 → "⎿ ", lines 1+ → two leading spaces). */
  previewLines: string[];
  fullPreview: string;
  previewed: boolean;
  overflow: boolean;
  overflowMore: string;
  open: boolean;
  isSubagent: boolean;
  /** sub-steps capped at the last 3. */
  subSteps: string[];
  subProgress: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  reasoning: number;
}

export interface Session {
  id: string;
  title: string;
  mtime: number;
}

export type ModalState =
  | {
      kind: "approval";
      id: number;
      toolName: string;
      args: string;
      warning?: string;
      savePatterns?: string[];
    }
  | { kind: "question"; id: number; items: QuestionItem[] }
  | {
      kind: "info";
      view: "model" | "settings" | "agents" | "help" | "addDir";
      data?: unknown;
    }
  | { kind: "setup"; error?: string };

export interface ModelPickerData {
  models: ModelOption[];
}
export interface SettingsData {
  settings: SettingsInfo;
}
export interface AgentsData {
  agents: AgentInfo[];
}
export interface AddDirData {
  path: string;
}

export interface Toast {
  id: number;
  msg: string;
  kind: "" | "err";
}

export interface AppState {
  // thread (committed, append-only)
  messages: Msg[];
  hasContent: boolean;

  // turn / status
  busy: boolean;
  modeId: ModeId;
  model: string;
  cwd: string;
  contextWindow: number;
  balance: string;
  usage: Usage | null;
  bgTasks: number;
  title: string;

  // tool calls (keyed by callId)
  tools: Record<string, ToolCard>;

  // sessions sidebar
  sessions: Session[];
  activeSessionId: string | null;

  // modal (single shell)
  modal: ModalState | null;

  // theme
  theme: "light" | "dark";
}

// ─────────────────────────────────────────────────────────────────────────────
// Stores + signals
// ─────────────────────────────────────────────────────────────────────────────

export const [state, setState]: [AppState, SetStoreFunction<AppState>] =
  createStore<AppState>({
    messages: [],
    hasContent: false,

    busy: false,
    modeId: "auto",
    model: "",
    cwd: "",
    contextWindow: 0,
    balance: "",
    usage: null,
    bgTasks: 0,
    title: "DeepDive",

    tools: {},

    sessions: [],
    activeSessionId: null,

    modal: null,

    theme: "light",
  });

// High-churn streaming signals — re-set many times per second; kept out of the
// store to avoid store-diff cost on every chunk.
export const [liveThinking, setLiveThinking] = createSignal("");
export const [liveContent, setLiveContent] = createSignal("");
export const [toasts, setToasts] = createSignal<Toast[]>([]);

// Monotonic ids for keyed <For> over messages and for tool markers.
let nextMsgId = 1;
const newMsgId = (): number => nextMsgId++;

// ─────────────────────────────────────────────────────────────────────────────
// Non-reactive imperative machinery (§1.4) — plain module vars.
// Exposed via small accessors so the composer component can drive them.
// ─────────────────────────────────────────────────────────────────────────────

let cmdHistory: string[] = [];
let histIdx = -1;
let histDraft = "";

/** Active question modal state machine; null when no question is open.
 * A Solid signal (not a plain var) so the QuestionModal re-renders on every
 * sel/checked/advance change — all mutations go through immutable setQState. */
const [qStateSig, setQStateSig] = createSignal<QState | null>(null);

export interface QState {
  e: { id: number; items: QuestionItem[] };
  qi: number;
  sel: number;
  answers: Record<string, string>;
  checked: Set<number>;
  other: string;
  multi: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toasts (§3.11) — auto-removed after 2600ms.
// ─────────────────────────────────────────────────────────────────────────────

let nextToastId = 1;

export function toast(msg: string, kind: "" | "err" = ""): void {
  const id = nextToastId++;
  setToasts((ts) => [...ts, { id, msg, kind }]);
  setTimeout(() => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, 2600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme (§3.4 / §8.16) — pre-paint script already set <html data-theme>.
// ─────────────────────────────────────────────────────────────────────────────

/** Current theme read from the live <html data-theme> attribute. */
export function curTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

/** Sync the attribute + store with a theme (no persistence, no toast). */
export function applyTheme(t: "light" | "dark"): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
  }
  setState("theme", t);
}

/** Toggle theme, persist to localStorage["dd-theme"], and toast. */
export function toggleTheme(): void {
  const next = curTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("dd-theme", next);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
  toast(next === "dark" ? "已切换到暗色" : "已切换到浅色");
}

// ─────────────────────────────────────────────────────────────────────────────
// Greeting / thread lifecycle (§3.5 markActive, §8.18/§8.19 clearThread)
// ─────────────────────────────────────────────────────────────────────────────

/** First time real content appears: hide greeting. Also called from <Live> the
 * moment live streaming text/cursor appears (§8.18), not only on committed msgs. */
export function markActive(): void {
  if (!state.hasContent) setState("hasContent", true);
}

/** Re-evaluate greeting visibility after a withdrawal (recall): show when empty. */
function refreshGreeting(): void {
  setState("hasContent", state.messages.length > 0);
}

/**
 * Reset the transcript region (§8.19): empties #thread, clears live, drops the
 * tool map, restores greeting, clears busy + footer bgtasks/usage.
 */
export function clearThread(): void {
  setState(
    produce((s) => {
      s.messages = [];
      s.tools = {};
      s.hasContent = false;
      s.busy = false;
      s.bgTasks = 0;
      s.usage = null;
    }),
  );
  clearLive();
}

function clearLive(): void {
  setLiveThinking("");
  setLiveContent("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll helpers (§3.5 / §3.8 / §8.14)
//
// The committed builders scroll unconditionally; the live region only sticks if
// it was at the bottom before the update. Components own the #scroll element;
// these helpers resolve it lazily so the store stays DOM-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

function scrollEl(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("scroll");
}

export function scrollDown(): void {
  // Defer to after Solid flushes the DOM mutation.
  queueMicrotask(() => {
    const el = scrollEl();
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** True when the scroll viewport is within 60px of the bottom (§8.14). */
export function atBottom(): boolean {
  const el = scrollEl();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message / transcript mutation actions (§3.5)
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_TITLES = new Set(["DeepDive", "新对话"]);

/** Append a user bubble. `queued` when submitted mid-stream (§8.5). */
export function addUser(text: string, queued: boolean): void {
  setState("messages", (m) => [
    ...m,
    { type: "user", id: newMsgId(), text, queued },
  ]);
  markActive();
  // Derive the session title from the first user line if still a placeholder.
  if (FALLBACK_TITLES.has(state.title)) {
    const t = text.trim().slice(0, 60);
    if (t) setState("title", t);
  }
  scrollDown();
}

/**
 * Commit an assistant message, folding in the accumulated live thinking.
 * `hasThinking` controls whether the <details class="thinking"> block renders.
 */
export function addAssistant(
  thinking: string,
  content: string,
  interrupted: boolean,
): void {
  const hasThinking = thinking.trim().length > 0;
  setState("messages", (m) => [
    ...m,
    {
      type: "assistant",
      id: newMsgId(),
      thinking,
      content,
      interrupted,
      hasThinking,
    },
  ]);
  markActive();
  scrollDown();
}

/** Resume-time assistant variant for turns with no persisted thinking (§3.5);
 * turns that do carry reasoning_content go through addAssistant instead. */
export function addAssistantPlain(content: string, interrupted: boolean): void {
  setState("messages", (m) => [
    ...m,
    { type: "assistantPlain", id: newMsgId(), content, interrupted },
  ]);
  markActive();
  scrollDown();
}

/** Compaction divider (role "summary" on resume, §3.5 / §8.12). */
export function addSummary(content: string): void {
  setState("messages", (m) => [
    ...m,
    { type: "summary", id: newMsgId(), content },
  ]);
  markActive();
  scrollDown();
}

/** Error row (§3.5). */
export function addError(message: string): void {
  setState("messages", (m) => [
    ...m,
    { type: "error", id: newMsgId(), message },
  ]);
  markActive();
  scrollDown();
}

// ── Tool cards (§3.6) ────────────────────────────────────────────────────────

/** Register a running tool card + an inline ordering marker in messages. */
export function toolStarted(callId: string, name: string, summary: string): void {
  const card: ToolCard = {
    name,
    summary,
    dot: "run",
    ok: false,
    tag: "",
    tagErr: false,
    previewLines: [],
    fullPreview: "",
    previewed: false,
    overflow: false,
    overflowMore: "",
    open: false,
    isSubagent: name === "agent",
    subSteps: [],
    subProgress: "",
  };
  setState(
    produce((s) => {
      s.tools[callId] = card;
      s.messages.push({ type: "tool", id: newMsgId(), callId });
    }),
  );
  markActive();
  scrollDown();
}

/**
 * Finish a tool card: replace the dot, set tag, format the preview (⎿ + 2-space
 * continuation lines), compute overflow. `ask_user_question` results are routed
 * through renderQA and return early (no overflow logic) (§3.6).
 */
export function toolFinished(
  callId: string,
  tag: string,
  ok: boolean,
  preview: string,
): void {
  const existing = state.tools[callId];
  if (!existing) return;

  setState("tools", callId, "dot", ok ? "ok" : "err");
  setState("tools", callId, "ok", ok);
  setState("tools", callId, "tag", tag || "");
  setState("tools", callId, "tagErr", !ok);

  // QA result: ask_user_question with a JSON preview → special rendering.
  if (existing.name === "ask_user_question" && renderQA(callId, preview)) return;

  if (!preview.trim()) {
    scrollDown();
    return;
  }

  const lines = preview.replace(/\s+$/, "").split("\n");
  const previewLines = lines
    .slice(0, 3)
    .map((l, idx) => (idx ? "  " : "⎿ ") + l);

  setState(
    produce((s) => {
      const c = s.tools[callId];
      if (!c) return;
      c.previewLines = previewLines;
      c.fullPreview = preview;
      c.previewed = true;
      if (lines.length > 3) {
        c.overflow = true;
        c.overflowMore = "… +" + (lines.length - 3) + " 行";
      } else {
        c.overflow = false;
        c.overflowMore = "";
      }
    }),
  );
  scrollDown();
}

/**
 * QA result for ask_user_question (§3.6). Returns true if `preview` was a
 * recognized JSON answer/decline payload (and applied it); false to fall back
 * to the normal preview path.
 */
function renderQA(callId: string, preview: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(preview);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object") return false;

  let header = "";
  const lines: string[] = [];
  const o = obj as { answers?: Record<string, string>; declined?: string[] };

  if (o.answers && typeof o.answers === "object" && !Array.isArray(o.answers)) {
    header = "用户已回答：";
    for (const [q, a] of Object.entries(o.answers)) {
      lines.push(`· ${q} → ${a}`);
    }
  } else if (Array.isArray(o.declined)) {
    header = "用户拒绝回答";
    for (const q of o.declined) lines.push(`· ${q}`);
  } else {
    return false;
  }

  // ⎿ + single space on the header line; each body line gets 3 leading spaces.
  const previewLines = ["⎿ " + header, ...lines.map((l) => "   " + l)];
  setState(
    produce((s) => {
      const c = s.tools[callId];
      if (!c) return;
      c.previewLines = previewLines;
      c.fullPreview = preview;
      c.previewed = true;
      c.overflow = false;
      c.overflowMore = "";
    }),
  );
  scrollDown();
  return true;
}

/** Toggle a tool card's expanded body (head click when expandable). */
export function toggleToolOpen(callId: string): void {
  const c = state.tools[callId];
  if (!c) return;
  setState("tools", callId, "open", !c.open);
}

/** subagentProgress → update the `.sub-progress` line on an agent card (§3.6). */
export function subagentProgress(
  callId: string,
  turn: number,
  toolCalls: number,
  activity: string,
): void {
  if (!state.tools[callId]) return;
  const line =
    `turn ${turn} · ${toolCalls} 工具调用` + (activity ? " · " + activity : "");
  setState("tools", callId, "isSubagent", true);
  setState("tools", callId, "subProgress", line);
}

/** subagentStep → append a `.sub-step`, keeping only the last 3 (§3.6). */
export function subagentStep(callId: string, name: string, summary: string): void {
  if (!state.tools[callId]) return;
  // ⎿ + single trailing space, then "name(summary)".
  const step = `⎿ ${name}(${summary})`;
  setState(
    produce((s) => {
      const c = s.tools[callId];
      if (!c) return;
      c.isSubagent = true;
      c.subSteps = [...c.subSteps, step].slice(-3);
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Event dispatcher (§2.2) — the single inbound handler for "agent-event".
// Unlisted kinds are silently ignored (no default case).
// ─────────────────────────────────────────────────────────────────────────────

export function handleEvent(e: AgentEventPayload): void {
  switch (e.kind) {
    case "turnStarted": {
      setState("busy", true);
      clearLive();
      // Un-queue every queued user bubble (§8.5).
      setState(
        produce((s) => {
          for (const m of s.messages) {
            if (m.type === "user" && m.queued) m.queued = false;
          }
        }),
      );
      break;
    }

    case "thinking": {
      // Cumulative replace.
      setLiveThinking(e.text);
      break;
    }

    case "content": {
      // Cumulative replace.
      setLiveContent(e.text);
      break;
    }

    case "bashOutput": {
      // The one append case; shares liveContent with `content`.
      setLiveContent((prev) => prev + e.chunk);
      break;
    }

    case "assistant": {
      // Commit, folding in accumulated live thinking; then clear live.
      addAssistant(liveThinking(), e.content, !!e.interrupted);
      clearLive();
      scrollDown();
      break;
    }

    case "toolStarted": {
      toolStarted(e.callId, e.name, e.summary);
      break;
    }

    case "toolFinished": {
      toolFinished(e.callId, e.tag, e.ok, e.preview);
      break;
    }

    case "subagentProgress": {
      subagentProgress(e.callId, e.turn, e.toolCalls, e.activity);
      break;
    }

    case "subagentStep": {
      subagentStep(e.callId, e.name, e.summary);
      break;
    }

    case "usage": {
      setState("usage", {
        input: e.input,
        output: e.output,
        cacheHit: e.cacheHit,
        cacheMiss: e.cacheMiss,
        reasoning: e.reasoning,
      });
      break;
    }

    case "bgTasks": {
      setState("bgTasks", e.running);
      break;
    }

    case "recall": {
      // Withdraw the last user message back into the composer (§8.6).
      setState(
        produce((s) => {
          for (let i = s.messages.length - 1; i >= 0; i--) {
            if (s.messages[i].type === "user") {
              s.messages.splice(i, 1);
              break;
            }
          }
        }),
      );
      refreshGreeting();
      setComposerValue(e.text);
      setState("busy", false);
      break;
    }

    case "turnComplete": {
      setState("busy", false);
      clearLive();
      void loadSessions();
      void loadBalance();
      break;
    }

    case "error": {
      addError(e.message);
      clearLive();
      setState("busy", false);
      break;
    }

    case "approval": {
      showApproval(e);
      break;
    }

    case "question": {
      showQuestion(e);
      break;
    }

    // No default: unlisted kinds are silently ignored (§2.2).
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command wrappers (§2.1 / §3) — fire-and-forget invoke calls + local effects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submit composer text. Slash commands are dispatched locally and never sent.
 * Otherwise the bubble is rendered optimistically (queued if mid-stream) and the
 * text is sent (the backend queues mid-turn input without starting a new turn).
 */
export function submit(text: string): void {
  if (!text.trim()) return;

  // Recall history bookkeeping (slash commands ARE pushed — §8.7).
  if (cmdHistory[cmdHistory.length - 1] !== text) cmdHistory.push(text);
  histIdx = -1;
  histDraft = "";

  const trimmed = text.trim();
  if (trimmed[0] === "/") {
    if (!dispatchSlash(trimmed)) {
      const name = trimmed.slice(1).split(/\s+/)[0];
      toast(`未知命令：/${name}`, "err");
    }
    return;
  }

  addUser(text, state.busy);
  void invoke("submit", { input: text });
}

export function abort(): void {
  void invoke("abort");
}

/** Switch approval mode (footer menu / approval translate). */
export function setMode(id: ModeId): void {
  setState("modeId", id);
  void invoke("set_mode", { mode: id });
  const mode = MODES.find((m) => m.id === id);
  if (mode) toast(`审批模式 → ${mode.label}`);
}

export function setModel(value: string): void {
  setState("model", value);
  void invoke("set_model", { model: value });
  toast(`模型 → ${value}`);
}

export function saveSettings(args: {
  model: string;
  reasoningEffort: string;
  responseLanguage: string;
  turnSummary: string;
  tavilyKey: string | null;
}): void {
  void invoke("save_settings", {
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    responseLanguage: args.responseLanguage,
    turnSummary: args.turnSummary,
    tavilyKey: args.tavilyKey,
  });
  setState("model", args.model);
  toast("设置已保存");
  closeModal();
}

/** New chat (§3.2 / §6 clear). */
export function newChat(): void {
  void invoke("new_session");
  clearThread();
  setState("title", "新对话");
  setState("activeSessionId", null);
  void loadSessions();
  focusComposer();
}

/** Resume a session, guarding against mid-turn switches (§8.17). */
export async function resumeSession(id: string): Promise<void> {
  if (state.busy) {
    toast("运行中，无法切换会话");
    return;
  }
  try {
    const msgs = (await invoke("resume_session", { id })) as ResumedMessage[];
    clearThread();
    setState("activeSessionId", id);
    const session = state.sessions.find((s) => s.id === id);
    setState("title", session?.title || "DeepDive");
    for (const m of msgs) {
      if (m.role === "summary") addSummary(m.content);
      else if (m.role === "user") addUser(m.content, false);
      else if (m.thinking && m.thinking.trim())
        addAssistant(m.thinking, m.content, m.interrupted);
      else addAssistantPlain(m.content, m.interrupted);
    }
    scrollDown();
  } catch {
    /* swallow — loaders are best-effort */
  }
}

export function compact(): void {
  void invoke("compact");
  toast("已请求压缩对话");
}

/** Add an extra working directory; toast the returned status line (§3.10.7). */
export async function addDir(path: string, persist: boolean): Promise<void> {
  closeModal();
  try {
    const status = (await invoke("add_dir", { path, persist })) as string;
    toast(status);
  } catch {
    toast("添加目录失败", "err");
  }
}

/** Rename current session (§6 rename). */
export async function rename(arg: string): Promise<void> {
  const title = arg.trim();
  if (!title) {
    toast("用法：/rename <新标题>", "err");
    return;
  }
  try {
    await invoke("rename_session", { title });
    setState("title", title.slice(0, 60));
    toast(`已重命名：${title}`);
    void loadSessions();
  } catch {
    toast("重命名失败", "err");
  }
}

/** Save the DeepSeek API key from the setup gate (§3.10.8). */
export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    setState("modal", { kind: "setup", error: "⚠ API Key 不能为空" });
    return;
  }
  void invoke("save_api_key", { key: trimmed });
  closeModal();
  toast("API Key 已保存");
  void afterSetup();
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal helpers (§3.10) — fetch + set state.modal.
// ─────────────────────────────────────────────────────────────────────────────

export function closeModal(): void {
  setQStateSig(null);
  setState("modal", null);
}

/** Approval modal from an `approval` event (§3.10.1). */
export function showApproval(e: {
  id: number;
  toolName: string;
  args: string;
  warning?: string;
  savePatterns?: string[];
}): void {
  let args = e.args;
  try {
    args = JSON.stringify(JSON.parse(e.args), null, 2);
  } catch {
    /* keep raw */
  }
  setState("modal", {
    kind: "approval",
    id: e.id,
    toolName: e.toolName,
    args,
    warning: e.warning,
    savePatterns: e.savePatterns,
  });
}

/** Question modal from a `question` event (§3.10.2). */
export function showQuestion(e: { id: number; items: QuestionItem[] }): void {
  setQStateSig(mkQ(e, 0));
  setState("modal", { kind: "question", id: e.id, items: e.items });
}

export async function openModelPicker(): Promise<void> {
  try {
    const models = (await invoke("list_models")) as ModelOption[];
    setState("modal", {
      kind: "info",
      view: "model",
      data: { models } satisfies ModelPickerData,
    });
  } catch {
    /* swallow */
  }
}

export async function openSettings(): Promise<void> {
  try {
    const settings = (await invoke("get_settings")) as SettingsInfo;
    setState("modal", {
      kind: "info",
      view: "settings",
      data: { settings } satisfies SettingsData,
    });
  } catch {
    /* swallow */
  }
}

export async function openAgents(): Promise<void> {
  try {
    const agents = (await invoke("list_agents")) as AgentInfo[];
    setState("modal", {
      kind: "info",
      view: "agents",
      data: { agents } satisfies AgentsData,
    });
  } catch {
    /* swallow */
  }
}

export function showHelp(): void {
  setState("modal", { kind: "info", view: "help" });
}

/** Add-dir modal (§3.10.7). Empty path → usage toast, no modal. */
export function openAddDir(path: string): void {
  const p = path.trim();
  if (!p) {
    toast("用法：/add-dir <路径>", "err");
    return;
  }
  setState("modal", {
    kind: "info",
    view: "addDir",
    data: { path: p } satisfies AddDirData,
  });
}

export function showSetup(): void {
  setState("modal", { kind: "setup" });
}

/**
 * Apply an approval decision (§3.10.1 / §8.13). `"edits"` is translated, never
 * sent: it flips the mode to acceptEdits and then approves.
 */
export function approveWith(id: number, decision: string): void {
  if (decision === "edits") {
    setState("modeId", "acceptEdits");
    void invoke("set_mode", { mode: "acceptEdits" });
    void invoke("approve", { id, decision: "approve" });
  } else {
    void invoke("approve", { id, decision });
  }
  closeModal();
}

// ─────────────────────────────────────────────────────────────────────────────
// Question state machine (§3.10.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Build per-question state; `answers` carries across, sel/checked/other reset. */
export function mkQ(
  e: { id: number; items: QuestionItem[] },
  qi: number,
  prevAnswers?: Record<string, string>,
): QState {
  return {
    e,
    qi,
    sel: 0,
    answers: prevAnswers ? { ...prevAnswers } : {},
    checked: new Set<number>(),
    other: "",
    multi: !!e.items[qi].multiSelect,
  };
}

/** Read the live question machine — a reactive signal read, so any component
 * that calls this inside JSX re-renders when the machine advances/toggles. */
export function getQState(): QState | null {
  return qStateSig();
}

/** Replace the question machine (pass a NEW object for immutable updates). */
export function setQState(next: QState | null): void {
  setQStateSig(next);
}

/**
 * Commit an answer for the current question. If it was the last question, send
 * all answers and close; otherwise advance to the next question (§3.10.2).
 */
export function commitAnswer(value: string): void {
  const s = qStateSig();
  if (!s) return;
  const q = s.e.items[s.qi];
  const answers = { ...s.answers, [q.question]: value };

  if (s.qi >= s.e.items.length - 1) {
    void invoke("answer", { id: s.e.id, answers });
    closeModal();
  } else {
    setQStateSig(mkQ(s.e, s.qi + 1, answers));
  }
}

/**
 * Submit a multi-select question: gather checked options (sorted) plus any
 * free-text "other". Empty selection → error toast (§3.10.2).
 */
export function submitMulti(): void {
  const s = qStateSig();
  if (!s) return;
  const q = s.e.items[s.qi];
  const picks = Array.from(s.checked)
    .sort((a, b) => a - b)
    .map((i) => q.options[i]);
  const other = s.other.trim();
  if (other) picks.push(other);
  if (picks.length === 0) {
    toast("请至少选择一项", "err");
    return;
  }
  commitAnswer(picks.join(", "));
}

/** Decline/cancel the current question (§3.10.2 Esc path → answers:null). */
export function declineQuestion(): void {
  const s = qStateSig();
  if (!s) return;
  void invoke("answer", { id: s.e.id, answers: null });
  closeModal();
}

// ─────────────────────────────────────────────────────────────────────────────
// Composer bridge — the store does not own the textarea, so the composer
// registers setter/focus callbacks here (used by recall + completeSlash, etc.).
// ─────────────────────────────────────────────────────────────────────────────

let composerSetValue: ((text: string) => void) | null = null;
let composerFocus: (() => void) | null = null;

export function registerComposer(
  setValue: (text: string) => void,
  focus: () => void,
): void {
  composerSetValue = setValue;
  composerFocus = focus;
}

export function setComposerValue(text: string): void {
  composerSetValue?.(text);
}

export function focusComposer(): void {
  composerFocus?.();
}

// ── recall history accessors (composer drives keydown; logic lives here) ──────

export function pushHistory(text: string): void {
  if (cmdHistory[cmdHistory.length - 1] !== text) cmdHistory.push(text);
}

export function resetHistoryIdx(): void {
  histIdx = -1;
}

/** ↑ history-prev is active only while recalling OR when history exists (§3.9 #2);
 * otherwise ArrowUp must fall through to native caret movement. */
export function canRecallPrev(): boolean {
  return histIdx !== -1 || cmdHistory.length > 0;
}

/** ↓ history-next is active only while actively recalling (§3.9 #3). */
export function isRecalling(): boolean {
  return histIdx !== -1;
}

/**
 * Walk back through submitted-input history (§3.9 / §8.7). `current` is the live
 * draft (stashed on first ↑). Returns the value to load, or null for no change.
 */
export function historyPrev(current: string): string | null {
  if (cmdHistory.length === 0) return null;
  if (histIdx === -1) {
    histDraft = current;
    histIdx = cmdHistory.length;
  }
  if (histIdx > 0) {
    histIdx--;
    return cmdHistory[histIdx];
  }
  return null;
}

/**
 * Walk forward through history; restores the stashed draft past the newest entry
 * (§3.9). Returns the value to load, or null for no change.
 */
export function historyNext(): string | null {
  if (histIdx === -1) return null;
  histIdx++;
  if (histIdx >= cmdHistory.length) {
    histIdx = -1;
    return histDraft;
  }
  return cmdHistory[histIdx];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash dispatch (§6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch a slash command. Returns true if handled (so the caller can toast on
 * unknown commands). `text` is the trimmed composer value starting with "/".
 */
export function dispatchSlash(text: string): boolean {
  const name = text.slice(1).split(/\s+/)[0].toLowerCase();
  const arg = text.slice(1 + name.length).trim();

  switch (name) {
    case "help":
      showHelp();
      return true;
    case "clear":
      newChat();
      return true;
    case "compact":
      compact();
      return true;
    case "model":
      void openModelPicker();
      return true;
    case "settings":
      void openSettings();
      return true;
    case "agents":
      void openAgents();
      return true;
    case "rename":
      void rename(arg);
      return true;
    case "add-dir":
    case "adddir":
      openAddDir(arg);
      return true;
    default:
      return false;
  }
}

/** Slash autocomplete filtering (§6). null query → no menu. */
export function slashQueryFor(value: string): string | null {
  if (value[0] !== "/" || /\s/.test(value)) return null;
  return value.slice(1).toLowerCase();
}

/** Filtered + alpha-sorted slash items for a query fragment (§6). */
export function filterSlash(query: string): typeof SLASH[number][] {
  return SLASH.filter((c) => c.name.startsWith(query)).slice().sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders (§1.2) — boot, afterSetup, sessions, balance.
// ─────────────────────────────────────────────────────────────────────────────

/** Boot flow (§1.2). Sync theme, load app info, gate on need_setup. */
export async function boot(): Promise<void> {
  applyTheme(curTheme());

  try {
    const info = (await invoke("app_info")) as AppInfo;
    setState("model", info.model);
    setState("cwd", info.cwd);
    setState("contextWindow", info.contextWindow);
    const mode: Mode =
      MODES.find((m) => m.id === info.mode) ?? MODES[0];
    setState("modeId", mode.id);
  } catch {
    /* swallow; fall back to defaults */
  }

  let needs = false;
  try {
    needs = (await invoke("need_setup")) as boolean;
  } catch {
    needs = false;
  }

  if (needs === true) {
    showSetup();
    return;
  }
  await afterSetup();
}

/** Post-gate startup: load sessions + balance, focus the composer (§1.2). */
export async function afterSetup(): Promise<void> {
  await loadSessions();
  await loadBalance();
  focusComposer();
}

export async function loadSessions(): Promise<void> {
  try {
    const sessions = (await invoke("list_sessions")) as SessionSummary[];
    setState("sessions", sessions);
  } catch {
    /* swallow */
  }
}

export async function loadBalance(): Promise<void> {
  try {
    const bal = (await invoke("balance")) as string | null;
    setState("balance", bal ?? "");
  } catch {
    setState("balance", "");
  }
}
