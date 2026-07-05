import type { SlashCommand } from "./types.js";
import { getMcpManager } from "../mcp/manager.js";

/**
 * `/mcp` — show the connection status of every configured MCP server: transport,
 * connected/failed, and discovered tool count. Read-only; usable anytime.
 */
export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show MCP server connection status",
  execute(ctx) {
    const statuses = getMcpManager()?.statuses() ?? [];
    let note: string;
    if (statuses.length === 0) {
      note =
        "未配置 MCP 服务器。用 `deepdive mcp add <name> -- <命令> [参数...]` 添加，" +
        "或手动编辑 `~/.deepdive/settings.json` 的 `mcpServers` / 项目根 `.mcp.json`，重启后生效。";
    } else {
      const lines = statuses.map((s) =>
        s.connected
          ? `**${s.name}** _(${s.transport})_ — ✓ 已连接，${s.toolCount} 个工具`
          : `**${s.name}** _(${s.transport})_ — ✗ 连接失败：${s.error ?? "未知错误"}`,
      );
      note = `MCP 服务器（共 ${statuses.length} 个）：\n\n${lines.join("\n\n")}`;
    }
    ctx.setMessages((prev) => [
      ...prev,
      { role: "user", content: "/mcp" },
      { role: "assistant", content: note },
    ]);
    return true;
  },
};
