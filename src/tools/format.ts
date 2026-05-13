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

/** Whether the tool should show its args summary inline. */
export function toolShowArgs(name: string): boolean {
  return name === "bash" || name === "glob" || name === "grep";
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
      return String(args.file_path || "");
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
