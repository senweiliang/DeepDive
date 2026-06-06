import { resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import type { SlashCommand, SlashCommandContext } from "./types.js";
import { getOriginalCwd, expandTilde } from "../workspace.js";
import { info } from "../log.js";

// ── Validation ──────────────────────────────────────────────────────────────

type ValidateResult =
  | { resultType: "emptyPath" }
  | { resultType: "pathNotFound"; absolutePath: string }
  | { resultType: "notADirectory"; absolutePath: string }
  | { resultType: "alreadyInWorkingDirectory"; absolutePath: string; workingDir: string }
  | { resultType: "success"; absolutePath: string };

async function validate(path: string, workingDirs: string[]): Promise<ValidateResult> {
  const raw = path.trim();
  if (!raw) return { resultType: "emptyPath" };

  // Bare drive letter (e.g. "d:") → root of that drive.
  // resolve(cwd, "d:") gives d:\cwd, not d:\.
  const absolutePath = /^[A-Za-z]:$/.test(raw)
    ? raw + "\\"
    : resolve(getOriginalCwd(), expandTilde(raw));

  // Check existence + type in one syscall
  try {
    const s = await stat(absolutePath);
    if (!s.isDirectory()) {
      return { resultType: "notADirectory", absolutePath };
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
      return { resultType: "pathNotFound", absolutePath };
    }
    throw e;
  }

  // Check if already accessible from an existing working directory
  for (const wd of workingDirs) {
    if (absolutePath === wd || absolutePath.startsWith(wd + sep)) {
      return { resultType: "alreadyInWorkingDirectory", absolutePath, workingDir: wd };
    }
  }

  return { resultType: "success", absolutePath };
}

// ── Command ─────────────────────────────────────────────────────────────────

export const addDirCommand: SlashCommand = {
  name: "add-dir",
  description: "Add an extra workspace directory",
  async execute(ctx: SlashCommandContext, arg: string): Promise<boolean> {
    const result = await validate(arg, ctx.workingDirs);

    switch (result.resultType) {
      case "emptyPath":
        ctx.setError("Usage: /add-dir <path>");
        return true;

      case "pathNotFound":
        ctx.setError(`Path \`${result.absolutePath}\` was not found.`);
        return true;

      case "notADirectory":
        ctx.setError(`\`${result.absolutePath}\` is not a directory.`);
        return true;

      case "alreadyInWorkingDirectory": {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: `/add-dir ${arg}` },
          {
            role: "assistant",
            content: `\`${result.absolutePath}\` is already accessible within \`${result.workingDir}\`.`,
          },
        ]);
        return true;
      }

      case "success": {
        const dir = result.absolutePath;
        const choice = await ctx.confirmAddDir(dir);

        if (choice === "deny") {
          ctx.setMessages((prev) => [
            ...prev,
            { role: "user", content: `/add-dir ${arg}` },
            {
              role: "assistant",
              content: `Did not add \`${dir}\` as a working directory.`,
            },
          ]);
          return true;
        }

        ctx.addDir(dir);
        // Persistence is handled inside confirmAddDir's onPersist callback
        // (saveAdditionalDirectory called by App.tsx).

        info("slash", `/add-dir "${dir}" (${choice})`);

        const hint =
          choice === "persist"
            ? "（已写入 ~/.deepdive/settings.json，下次启动自动加载）"
            : "（仅本会话有效）";

        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: `/add-dir ${arg}` },
          {
            role: "assistant",
            content: `已添加额外工作区目录：\`${dir}\`\n${hint}`,
          },
          {
            role: "user",
            meta: true,
            content: `Additional working directory added: ${dir}`,
          },
        ]);
        return true;
      }
    }
  },
};
