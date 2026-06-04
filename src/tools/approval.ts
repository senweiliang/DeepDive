import type { ApprovalMode } from "../types.js";

// Which tools fall into which capability bucket.
// web_search/web_fetch are network-only and side-effect-free → treated as
// read-only: available in plan mode, never prompts for approval.
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
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
