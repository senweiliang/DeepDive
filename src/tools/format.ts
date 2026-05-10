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
