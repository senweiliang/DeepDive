import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

export type ToolResult = {
  content: string;
  isError: boolean;
};

export function execute(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  try {
    switch (name) {
      case "read_file":
        return readFile(args, workspace);
      case "write_file":
        return writeFile(args, workspace);
      case "edit_file":
        return editFile(args, workspace);
      case "glob":
        return runGlob(args, workspace);
      case "grep":
        return runGrep(args, workspace);
      case "bash":
        return runBash(args, workspace);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

function checkPath(workspace: string, filePath: string): string | null {
  const resolved = resolve(workspace, filePath);
  if (!resolved.startsWith(resolve(workspace))) {
    return null;
  }
  return resolved;
}

function readFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.path));
  if (!resolved) {
    return { content: "Error: path escapes workspace", isError: true };
  }
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = args.limit ? Number(args.limit) : undefined;
  const sliced = limit
    ? lines.slice(offset, offset + limit).join("\n")
    : lines.slice(offset).join("\n");
  return { content: sliced, isError: false };
}

function writeFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.path));
  if (!resolved) {
    return { content: "Error: path escapes workspace", isError: true };
  }
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolved, String(args.content), "utf-8");
  return { content: `Wrote ${String(args.path)}`, isError: false };
}

function editFile(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const resolved = checkPath(workspace, String(args.path));
  if (!resolved) {
    return { content: "Error: path escapes workspace", isError: true };
  }
  const content = readFileSync(resolved, "utf-8");
  const oldStr = String(args.old_string);
  const newStr = String(args.new_string);

  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    return { content: "Error: old_string not found in file", isError: true };
  }
  if (count > 1) {
    return {
      content: `Error: old_string appears ${count} times. Provide more context.`,
      isError: true,
    };
  }

  const updated = content.replace(oldStr, newStr);
  writeFileSync(resolved, updated, "utf-8");
  return { content: `Edited ${String(args.path)}`, isError: false };
}

function runGlob(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const pattern = String(args.pattern);
  const results: string[] = [];
  scanDir(workspace, pattern, workspace, results);
  return {
    content: results.length ? results.join("\n") : "(no matches)",
    isError: false,
  };
}

function scanDir(
  dir: string,
  pattern: string,
  workspace: string,
  results: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith("."))
      continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      scanDir(full, pattern, workspace, results);
    } else {
      const rel = full.slice(workspace.length + 1).replaceAll("\\", "/");
      if (simpleMatch(rel, pattern)) {
        results.push(rel);
      }
    }
  }
}

function simpleMatch(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(str);
}

function runGrep(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const pattern = String(args.pattern);
  const searchPath = args.path
    ? resolve(workspace, String(args.path))
    : workspace;

  if (!searchPath.startsWith(resolve(workspace))) {
    return { content: "Error: path escapes workspace", isError: true };
  }

  const regex = new RegExp(pattern, "g");
  const results: string[] = [];

  function search(obj: { path: string }): void {
    let entries: string[];
    try {
      entries = readdirSync(obj.path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(obj.path, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        search({ path: full });
      } else if (stat.isFile()) {
        try {
          const content = readFileSync(full, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              const rel = full.slice(workspace.length + 1).replaceAll("\\", "/");
              results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
              if (results.length >= 50) return;
            }
          }
        } catch {
          // binary / unreadable — skip
        }
      }
    }
  }

  if (existsSync(searchPath)) {
    const stat = statSync(searchPath);
    if (stat.isDirectory()) {
      search({ path: searchPath });
    } else {
      const content = readFileSync(searchPath, "utf-8");
      const lines = content.split("\n");
      const rel = searchPath.slice(workspace.length + 1).replaceAll("\\", "/");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
  }

  return {
    content: results.length ? results.join("\n") : "(no matches)",
    isError: false,
  };
}

function runBash(
  args: Record<string, unknown>,
  workspace: string,
): ToolResult {
  const cmd = String(args.command);
  try {
    const stdout = execSync(cmd, {
      cwd: workspace,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      shell: process.env.COMSPEC || "bash",
    });
    return { content: stdout || "(no output)", isError: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      content: e.stdout || e.stderr || e.message || "Unknown error",
      isError: true,
    };
  }
}
