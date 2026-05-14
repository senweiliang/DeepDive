// One Dark Code — colored text palette for the TUI.
//
// Only the semantically-colored positions are themed here. Plain body text,
// tool arguments, file paths and tool results stay on the terminal's default
// foreground so DeepDive blends with the user's shell colors.

export const theme = {
  accent: "#61afef",    // brand, tool names, headings
  success: "#98c379",   // ● bullets, cache hit, auto mode, +diff
  error: "#e06c75",     // errors, -diff, yolo mode, ctx>=80%
  thinking: "#e5c07b",  // thinking blocks
  approval: "#d19a66",  // approval prompt, default mode, ctx>=60%
  action: "#56b6c2",    // selected option, plan mode
  cost: "#c678dd",      // balance, compaction indicator
};
