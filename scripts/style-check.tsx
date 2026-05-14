// Run in Ghostty:  pnpm tsx scripts/style-check.tsx
import React from "react";
import { render, Text, Box } from "ink";
import { Markdown } from "../src/components/Markdown.js";

const md = `**bold 粗体** *italic 斜体* ***both 粗斜体*** ~~strike 删除~~

\`code 行内\` [link](https://example.com)`;

const App = () =>
  React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, null, "── raw Ink Text ──"),
    React.createElement(
      Text,
      null,
      React.createElement(Text, { bold: true }, "BOLD"),
      " ",
      React.createElement(Text, { italic: true }, "ITALIC"),
      " ",
      React.createElement(Text, { bold: true, italic: true }, "BOTH"),
      " ",
      React.createElement(Text, { strikethrough: true }, "STRIKE"),
    ),
    React.createElement(Text, null, ""),
    React.createElement(Text, null, "── via Markdown component ──"),
    React.createElement(Markdown, {
      content: md,
      firstPrefix: "● ",
      restPrefix: "  ",
      cols: 80,
    }),
  );

const inst = render(React.createElement(App));
setTimeout(() => {
  inst.unmount();
  process.exit(0);
}, 200);
