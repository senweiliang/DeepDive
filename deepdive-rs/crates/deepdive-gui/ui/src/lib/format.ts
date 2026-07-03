// Pure helpers + static constants shared across the app.
// Mirrors the vanilla-JS source (dist/main.js) and PORT_SPEC §1.5 / §3.2 / §3.4 / §6.

export type ModeId = "auto" | "default" | "acceptEdits" | "plan" | "yolo";

export interface Mode {
  id: ModeId;
  label: string;
  desc: string;
}

export interface SlashItem {
  name: string;
  desc: string;
}

// §1.5 — 5 modes. Default mode is MODES[0] ("auto").
export const MODES: readonly Mode[] = [
  { id: "auto", label: "AUTO", desc: "只读放行，bash 智能判定" },
  { id: "default", label: "DEFAULT", desc: "写入 / 执行需确认" },
  { id: "acceptEdits", label: "ACCEPT-EDITS", desc: "自动写文件，bash 仍确认" },
  { id: "plan", label: "PLAN", desc: "只读，禁止写入 / 执行" },
  { id: "yolo", label: "YOLO", desc: "全部自动，不确认" },
];

// §6 — slash commands (filter is prefix-match on bare command, alpha-sorted at render time).
export const SLASH: readonly SlashItem[] = [
  { name: "model", desc: "切换模型（pro / flash）" },
  { name: "settings", desc: "运行时设置" },
  { name: "agents", desc: "列出可用子代理" },
  { name: "add-dir", desc: "添加额外工作目录" },
  { name: "rename", desc: "重命名当前会话" },
  { name: "compact", desc: "压缩对话以节省上下文" },
  { name: "clear", desc: "清空当前对话" },
  { name: "help", desc: "显示可用命令" },
];

// §1.5 — raw tool name → display label.
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit_file: "Edit",
  read_file: "Read",
  write_file: "Write",
  glob: "Search",
  grep: "Search",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  skill: "Skill",
  ask_user_question: "AskUser",
  agent: "Agent",
  task_output: "TaskOutput",
  task_stop: "TaskStop",
};

export function toolName(n: string): string {
  return TOOL_NAMES[n] || n;
}

// §3.4 — token formatter.
//   ≥1e6 → "x.xM"; ≥1e4 → "{round(n/1e3)}k"; ≥1e3 → "x.xk"; else String(n).
export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

// §3.2 — relative time. `now = Date.now()/1000`, secs is a unix timestamp (seconds).
//   0/falsy → ""; <60 → 刚刚; <3600 → N分; <86400 → N时; <604800 → N天; else N周.
export function relTime(secs: number): string {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + "分";
  if (d < 86400) return Math.floor(d / 3600) + "时";
  if (d < 604800) return Math.floor(d / 86400) + "天";
  return Math.floor(d / 604800) + "周";
}

// HTML-escape — escapes & < > only.
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
