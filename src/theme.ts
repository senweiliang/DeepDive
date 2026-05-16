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
  thinking: "#e5c67b",  // thinking blocks — 色相 39→43°（更黄），与 approval 拉开
  approval: "#d8885a",  // approval prompt, default mode, ctx>=60% — 色相 29→22°（更橙）
  action: "#56b6c2",    // selected option, plan mode
  cost: "#c678dd",      // balance, compaction indicator
};
