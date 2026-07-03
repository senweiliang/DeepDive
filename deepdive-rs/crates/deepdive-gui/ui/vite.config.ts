import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// 注意 build.target：Tauri 在 macOS 上是 WKWebView(WebKit)，不是 Chrome，
// 所以按 Safari 基线编译，避免用到 WebKit 不支持的语法。
export default defineConfig({
  plugins: [solid()],
  // strictPort: must match devUrl in tauri.conf.json (5180). Fail loudly if taken
  // rather than silently switching ports (which would leave the Tauri webview blank).
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", target: "safari15" },
});
