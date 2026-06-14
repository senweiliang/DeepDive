import type { ApprovalMode } from "../types.js";

// Which tools fall into which capability bucket.
// web_search/web_fetch are network-only and side-effect-free → treated as
// read-only: available in plan mode, never prompts for approval.
// ask_user_question only renders a TUI prompt and reads the user's choice —
// no filesystem/command side effects → read-only, and crucially available in
// plan mode (where it's the canonical way to clarify requirements). It never
// needs approval because it IS the user being asked.
// task_output only READS a background task's status/buffered output → no side
// effects → read-only, no prompt, available everywhere. task_stop is NOT here:
// killing a process is a real side effect, so it stays out of the read-only
// bucket and is therefore blocked in plan mode (like bash) — plan mode must not
// mutate live process state without confirmation.
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "task_output",
]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const EXEC_TOOLS = new Set(["bash"]);

export function toolNeedsApproval(
  toolName: string,
  mode: ApprovalMode,
): boolean {
  switch (mode) {
    case "plan":
      return WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName);
    case "yolo":
      return false;
    case "acceptEdits":
      // Auto-accept file edits this session; bash still asks every time.
      return EXEC_TOOLS.has(toolName);
    case "auto":
      // Auto mode: only bash needs classifier; read/write auto-pass
      return EXEC_TOOLS.has(toolName);
    case "default":
    default:
      return WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName);
  }
}

export function toolAllowed(toolName: string, mode: ApprovalMode): boolean {
  if (mode === "plan") {
    return READ_ONLY_TOOLS.has(toolName);
  }
  // All other modes allow all tools (bash may be blocked by classifier)
  return true;
}
