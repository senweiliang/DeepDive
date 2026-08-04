import type { SlashCommand } from "./types.js";
import {
  getRemoteStatus,
  startRemoteServer,
  stopRemoteServer,
} from "../remote/server.js";

/**
 * /remote — 开关手机/浏览器远程控制（局域网）。
 *
 * 开启后终端打印带 token 的 URL + 二维码（App 订阅 remote/server.ts 的
 * 状态渲染），手机扫码即成为当前会话的第二个「窗口」：实时看、可发消息。
 * 再次执行则关闭。`DEEPDIVE_REMOTE=1` 可启动即开，等价于自动执行本命令。
 */
export const remoteCommand: SlashCommand = {
  name: "remote",
  description: "开启/关闭手机远程控制（局域网扫码）",
  async execute(ctx) {
    if (getRemoteStatus()?.running) {
      stopRemoteServer();
      // Client-only notice (error flag = stripped before API requests).
      ctx.setError("Remote control stopped");
      return true;
    }
    try {
      await startRemoteServer(ctx.config.remotePort);
    } catch (err) {
      ctx.setError(err instanceof Error ? err.message : "无法启动远程控制");
    }
    return true;
  },
};
