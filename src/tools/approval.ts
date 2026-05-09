import type { ApprovalMode } from "../types.js";

// Which tools fall into which capability bucket.
const READ_ONLY_TOOLS = new Set(["read_file", "glob", "grep"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const EXEC_TOOLS = new Set(["bash"]);

export function toolNeedsApproval(
  toolName: string,
  mode: ApprovalMode,
): boolean {
  switch (mode) {
    case "plan":
      // Plan: reject all writes and exec
      return WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName);
    case "yolo":
      // YOLO: never need approval
      return false;
    case "default":
    default:
      // Default: ask for writes and exec
      return WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName);
  }
}

export function toolAllowed(toolName: string, mode: ApprovalMode): boolean {
  // Plan mode: read-only only
  if (mode === "plan") {
    return READ_ONLY_TOOLS.has(toolName);
  }
  // Default and YOLO: all tools allowed
  return true;
}
