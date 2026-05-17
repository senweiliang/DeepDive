// One Dark Code — colored text palette for the TUI.
//
// Only the semantically-colored positions are themed here. Plain body text,
// tool arguments, file paths and tool results stay on the terminal's default
// foreground so DeepDive blends with the user's shell colors.

// 以 One Dark 为基底，做了一轮和谐度调优：accent 蓝（品牌色）刻意保持
// 高饱和不变；其余色收进一致的中高饱和带，并拉开 thinking/approval 的色相。
export const theme = {
  accent: "#61afef",    // brand, tool names, headings — HSL(207,82,66) 品牌色，保持
  success: "#8cd369",   // ● bullets, cache hit, auto mode, +diff — S 38→55，与 error 红权重对等
  error: "#e06c75",     // errors, -diff, yolo mode, ctx>=80% — HSL(355,65,65) 红/绿语义锚点
  thinking: "#f0c14b",  // thinking 标题/标签 — H43 S85 L62 鲜明琥珀金，S 拉满+绝不 dim（区别于当初被 dim 的土黄）
  thinkingBody: "#d8a82f", // thinking 正文 — H43 S78 L52 仍高饱和，比标题暗以分层（靠明度不靠 dim/降饱和）
  thinkingFolded: "#a07c22", // thinking 折叠态单行 — H43 S65 L38 暗琥珀，明显压低存在感（靠降明度，S>40 不发灰）
  approval: "#d8885a",  // approval prompt, default mode, ctx>=60% — 色相 29→22°（更橙）
  action: "#56b6c2",    // selected option, plan mode
  cost: "#c678dd",      // balance, compaction indicator
};
