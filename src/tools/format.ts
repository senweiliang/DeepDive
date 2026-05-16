import { relative, isAbsolute } from "node:path";

/**
 * Shorten a path for display: if it lives under the current working
 * directory, show it relative to cwd (no leading "./"); otherwise show
 * it unchanged. Paths that escape cwd ("../…") keep the absolute form.
 */
export function displayPath(p: string): string {
  if (!p || !isAbsolute(p)) return p;
  const rel = relative(process.cwd(), p);
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
    default:
      return JSON.stringify(args);
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
