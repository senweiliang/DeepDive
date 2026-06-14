import { relative, isAbsolute } from "node:path";
import { getOriginalCwd } from "../workspace.js";

/**
 * Shorten a path for display: if it lives under the original working
 * directory, show it relative to that cwd (no leading "./"); otherwise show
 * it unchanged. Paths that escape cwd ("../…") keep the absolute form.
 */
export function displayPath(p: string): string {
  if (!p || !isAbsolute(p)) return p;
  const rel = relative(getOriginalCwd(), p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel;
}

/** Human-readable display name for a tool. */
export function toolDisplayName(name: string): string {
  switch (name) {
    case "bash":
      return "Bash";
    case "edit_file":
      return "Edit";
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "glob":
    case "grep":
      return "Search";
    case "web_search":
      return "WebSearch";
    case "web_fetch":
      return "WebFetch";
    case "skill":
      return "Skill";
    case "ask_user_question":
      return "AskUser";
    case "agent":
      return "Agent";
    case "task_output":
      return "TaskOutput";
    case "task_stop":
      return "TaskStop";
    default:
      return name;
  }
}

export function summarizeArgs(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "bash":
      return String(args.command || "");
    case "read_file":
    case "write_file":
    case "edit_file":
      return displayPath(String(args.file_path || ""));
    case "glob":
    case "grep":
      return String(args.pattern || "");
    case "web_search":
      return String(args.query || "");
    case "web_fetch":
      return String(args.url || "");
    case "skill":
      return String(args.name || "");
    case "agent": {
      const type = args.subagent_type ? String(args.subagent_type) : "general-purpose";
      const desc = String(args.description || "");
      const bg = args.run_in_background ? " (background)" : "";
      return (desc ? `${type}: ${desc}` : type) + bg;
    }
    case "task_output":
    case "task_stop":
      return String(args.task_id || "");
    case "ask_user_question": {
      const qs = Array.isArray(args.questions) ? args.questions : [];
      const first =
        qs[0] && typeof qs[0] === "object"
          ? String((qs[0] as Record<string, unknown>).question ?? "")
          : "";
      return qs.length > 1 ? `${first} (+${qs.length - 1} more)` : first;
    }
    default:
      return JSON.stringify(args);
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
