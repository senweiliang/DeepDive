import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import type { Message, ToolCall } from "../types.js";
import { Thinking } from "./Thinking.js";
import { Markdown } from "./Markdown.js";
import { summarizeArgs, toolDisplayName, truncate } from "../tools/format.js";
import { theme } from "../theme.js";

const RESULT_PREVIEW_LINES = 3;
const RESULT_LINE_MAX = 120;
const ARGS_SUMMARY_MAX = 80;

// 命令参数最多占终端宽度的 80%，剩余留给工具名/括号与右侧呼吸空间。
function argsMax(cols: number): number {
  return Math.max(ARGS_SUMMARY_MAX, Math.floor(cols * 0.8));
}

function ToolCallLine({ call, cols }: { call: ToolCall; cols: number }) {
  const displayName = toolDisplayName(call.function.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    // keep args empty if streaming was incomplete
  }
  const summary = truncate(
    summarizeArgs(call.function.name, args),
    argsMax(cols),
  );
  return (
    <Box>
      <Text>
        <Text>● </Text>
        <Text bold>{displayName}</Text>
        <Text>(</Text>
        <Text>{summary}</Text>
        <Text>)</Text>
      </Text>
    </Box>
  );
}

function parseDiff(content: string): {
  diffLines: string[];
  added: number;
  removed: number;
  numWidth: number;
} | null {
  const fenceIdx = content.indexOf("```diff");
  if (fenceIdx === -1) return null;
  const diffStart = content.indexOf("\n", fenceIdx) + 1;
  const diffEnd = content.lastIndexOf("\n```");
  const diffText =
    diffEnd !== -1 ? content.slice(diffStart, diffEnd) : content.slice(diffStart);
  const lines = diffText.split("\n");
  let added = 0;
  let removed = 0;
  let maxNum = 0;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
      if (m) {
        oldLine = parseInt(m[1]!);
        newLine = parseInt(m[2]!);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      maxNum = Math.max(maxNum, newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
      maxNum = Math.max(maxNum, oldLine);
      oldLine++;
    } else if (!line.startsWith("---") && !line.startsWith("+++")) {
      maxNum = Math.max(maxNum, newLine);
      oldLine++;
      newLine++;
    }
  }
  return { diffLines: lines, added, removed, numWidth: Math.max(1, String(maxNum).length) };
}

function DiffView({ content, cols }: { content: string; cols: number }) {
  const parsed = parseDiff(content);
  if (!parsed) {
    const lines = content.split("\n");
    const preview = lines.slice(0, RESULT_PREVIEW_LINES);
    const more = lines.length - preview.length;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {preview.map((line, i) => (
          <Text key={i} dimColor>
            {i === 0 ? "⎿ " : "  "}
            {truncate(line, RESULT_LINE_MAX)}
          </Text>
        ))}
        {more > 0 && <Text dimColor>{"  "}… +{more} lines</Text>}
      </Box>
    );
  }

  const { diffLines, added, removed, numWidth } = parsed;
  const lines: ReactNode[] = [];

  // Stats on the ⎿ line
  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${added} lines`);
  if (removed > 0) parts.push(`removed ${removed} lines`);
  lines.push(
    <Text key="stats" dimColor>
      {"  ⎿  "}{parts.join(", ")}
    </Text>,
  );

  // Background ends at cols-5, leaving the rightmost 5 cols unstyled
  const targetWidth = Math.max(1, cols - 5);
  const leftPad = "     ";
  let oldLine = 0;
  let newLine = 0;

  function clipped(s: string, maxCols: number): string {
    if (maxCols <= 0) return "";
    let out = "";
    let w = 0;
    for (const ch of s) {
      const cw = stringWidth(ch);
      if (w + cw > maxCols) break;
      out += ch;
      w += cw;
    }
    return out;
  }

  for (const line of diffLines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
      if (m) {
        oldLine = parseInt(m[1]!);
        newLine = parseInt(m[2]!);
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    const num = (line.startsWith("+") ? String(newLine) : line.startsWith("-") ? String(oldLine) : String(newLine)).padStart(numWidth);
    const lpw = stringWidth(leftPad);
    const prefix = ` ${num} `;
    const maxContent = Math.max(0, targetWidth - lpw - stringWidth(prefix));
    const visible = clipped(line, maxContent);
    const bgWidth = lpw + stringWidth(prefix) + stringWidth(visible);
    const pad = bgWidth < targetWidth ? " ".repeat(targetWidth - bgWidth) : "";

    if (line.startsWith("+")) {
      lines.push(
        <Text key={`a${lines.length}`}>
          {leftPad}
          <Text backgroundColor="#1a3a1a">
            <Text color={theme.success}>{prefix}</Text>{visible}{pad}
          </Text>
        </Text>,
      );
      newLine++;
    } else if (line.startsWith("-")) {
      lines.push(
        <Text key={`r${lines.length}`}>
          {leftPad}
          <Text backgroundColor="#3a1a1a">
            <Text color={theme.error}>{prefix}</Text>{visible}{pad}
          </Text>
        </Text>,
      );
      oldLine++;
    } else {
      lines.push(
        <Text key={`c${lines.length}`}>
          {leftPad}{prefix}{visible}{pad}
        </Text>,
      );
      oldLine++;
      newLine++;
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines}
    </Box>
  );
}

function ToolResultLines({
  content,
  toolName,
  cols,
}: {
  content: string;
  toolName?: string;
  cols: number;
}) {
  if (toolName === "edit_file" && content.includes("```diff")) {
    return <DiffView content={content} cols={cols} />;
  }

  const isError = content.startsWith("Error:");
  const lines = content.replace(/\n+$/, "").split("\n");
  const preview = lines.slice(0, RESULT_PREVIEW_LINES);
  const more = lines.length - preview.length;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      {preview.map((line, i) => (
        <Text key={i} color={isError ? theme.error : undefined} dimColor={!isError}>
          {i === 0 ? "⎿ " : "  "}
          {truncate(line, RESULT_LINE_MAX)}
        </Text>
      ))}
      {more > 0 && (
        <Text dimColor>{"  "}… +{more} lines</Text>
      )}
    </Box>
  );
}

function padLines(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      const w = stringWidth(line);
      return w >= width ? line : line + " ".repeat(width - w);
    })
    .join("\n");
}

function indentLines(text: string, firstPrefix: string, restPrefix: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? firstPrefix : restPrefix) + l)
    .join("\n");
}

function completedLines(text: string): string {
  const lastNl = text.lastIndexOf("\n");
  return lastNl === -1 ? "" : text.slice(0, lastNl);
}

interface MessageItemProps {
  msg: Message;
  showThinking: boolean;
  cols: number;
  hiddenToolIds?: Set<string>;
  toolNames?: Map<string, string>;
}

export function MessageItem({
  msg,
  showThinking,
  cols,
  hiddenToolIds,
  toolNames,
}: MessageItemProps) {
  if (msg.role === "tool" && msg.tool_call_id && hiddenToolIds?.has(msg.tool_call_id)) {
    return null;
  }
  if (
    msg.role === "user" &&
    msg.content?.startsWith("<previous-conversation-summary>")
  ) {
    const summaryText = msg.content
      .replace(/^<previous-conversation-summary>\n?/, "")
      .replace(/\n?<\/previous-conversation-summary>\s*$/, "")
      .trim();
    const bar = "─".repeat(Math.max(0, cols - 6));
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>{"  " + bar}</Text>
        <Text dimColor bold>{"  ⎯ Context compacted · summary below ⎯"}</Text>
        <Text dimColor>{"  " + bar}</Text>
        <Text dimColor>{indentLines(summaryText, "     ", "     ")}</Text>
      </Box>
    );
  }
  const displayed = msg.content;
  const toolName =
    msg.role === "tool" && msg.tool_call_id
      ? toolNames?.get(msg.tool_call_id)
      : undefined;
  return (
    <Box flexDirection="column">
      {msg.reasoning_content && (
        <Thinking content={msg.reasoning_content} expanded={showThinking} />
      )}
      {displayed && msg.role !== "tool" && msg.role !== "system" && (
        <Box marginBottom={1}>
          {msg.role === "user" ? (
            <Text backgroundColor="#3a3a3a">
              {padLines(`> ${displayed}`, cols)}
            </Text>
          ) : (
            <Markdown content={displayed} firstPrefix="● " restPrefix="  " cols={cols} />
          )}
        </Box>
      )}
      {msg.role === "assistant" &&
        msg.tool_calls
          ?.filter((tc) => !hiddenToolIds?.has(tc.id))
          .map((tc) => <ToolCallLine key={tc.id} call={tc} cols={cols} />)}
      {msg.role === "tool" && msg.content && (
        <ToolResultLines content={msg.content} toolName={toolName} cols={cols} />
      )}
    </Box>
  );
}

interface StreamPreviewProps {
  thinking: string;
  response: string;
  isStreaming: boolean;
  showThinking: boolean;
  cols: number;
}

export function StreamPreview({
  thinking,
  response,
  isStreaming,
  showThinking,
  cols,
}: StreamPreviewProps) {
  if (!isStreaming) return null;
  const visibleResponse = completedLines(response);
  return (
    <>
      {thinking && (
        <Thinking
          content={thinking}
          expanded={showThinking}
          active={!response}
        />
      )}
      {visibleResponse && (
        <Box marginBottom={1}>
          <Markdown content={visibleResponse} firstPrefix="● " restPrefix="  " cols={cols} />
        </Box>
      )}
    </>
  );
}

function buildTranscriptLines(
  messages: Message[],
  cols: number,
  hiddenToolIds?: Set<string>,
  toolNames?: Map<string, string>,
): ReactNode[] {
  const lines: ReactNode[] = [];
  let key = 0;
  const blank = () => {
    lines.push(<Text key={`b${key++}`}> </Text>);
  };
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id && hiddenToolIds?.has(msg.tool_call_id)) {
      continue;
    }
    if (
      msg.role === "user" &&
      msg.content?.startsWith("<previous-conversation-summary>")
    ) {
      const summaryText = msg.content
        .replace(/^<previous-conversation-summary>\n?/, "")
        .replace(/\n?<\/previous-conversation-summary>\s*$/, "")
        .trim();
      const bar = "─".repeat(Math.max(0, cols - 4));
      lines.push(<Text key={`cs${key++}`} dimColor>{"  " + bar}</Text>);
      lines.push(
        <Text key={`cs${key++}`} dimColor bold>
          {"  ⎯ Context compacted · summary below ⎯"}
        </Text>,
      );
      lines.push(<Text key={`cs${key++}`} dimColor>{"  " + bar}</Text>);
      for (const l of summaryText.split("\n")) {
        lines.push(
          <Text key={`cs${key++}`} dimColor>
            {"     " + (l || "")}
          </Text>,
        );
      }
      blank();
      continue;
    }
    if (msg.reasoning_content) {
      lines.push(
        <Text key={`t${key++}`} color={theme.thinking} bold>
          ✓ thinking
        </Text>,
      );
      for (const l of msg.reasoning_content.split("\n")) {
        lines.push(
          <Text key={`tt${key++}`} color={theme.thinking} dimColor>
            {l || " "}
          </Text>,
        );
      }
      blank();
    }
    if (msg.content && msg.role !== "tool") {
      if (msg.role === "user") {
        const splitLines = msg.content.split("\n");
        splitLines.forEach((line) => {
          const fullLine = `> ${line}`;
          const pad = " ".repeat(Math.max(0, cols - stringWidth(fullLine)));
          lines.push(
            <Text key={`u${key++}`} backgroundColor="#3a3a3a">
              {fullLine + pad}
            </Text>,
          );
        });
      } else {
        lines.push(
          <Markdown key={`md${key++}`} content={msg.content} firstPrefix="● " restPrefix="  " cols={cols} />
        );
      }
      blank();
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (hiddenToolIds?.has(tc.id)) continue;
        const displayName = toolDisplayName(tc.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // ignore
        }
        const summary = truncate(
          summarizeArgs(tc.function.name, args),
          argsMax(cols),
        );
        lines.push(
          <Text key={`c${key++}`}>
            <Text>● </Text>
            <Text bold>{displayName}</Text>
            <Text>(</Text>
            <Text>{summary}</Text>
            <Text>)</Text>
          </Text>,
        );
        blank();
      }
    }
    if (msg.role === "tool" && msg.content) {
      const toolName =
        msg.tool_call_id ? toolNames?.get(msg.tool_call_id) : undefined;
      if (toolName === "edit_file" && msg.content.includes("```diff")) {
        const parsed = parseDiff(msg.content);
        if (parsed) {
          const parts: string[] = [];
          if (parsed.added > 0) parts.push(`Added ${parsed.added} lines`);
          if (parsed.removed > 0) parts.push(`removed ${parsed.removed} lines`);
          lines.push(
            <Text key={`r${key++}`} dimColor>
              {"  ⎿  "}{parts.join(", ")}
            </Text>,
          );
          const targetWidth = Math.max(1, cols - 5);
          const leftPad = "     ";
          const nw = parsed.numWidth;
          let oldLine = 0;
          let newLine = 0;

          function clipped(s: string, maxCols: number): string {
            if (maxCols <= 0) return "";
            let out = "";
            let w = 0;
            for (const ch of s) {
              const cw = stringWidth(ch);
              if (w + cw > maxCols) break;
              out += ch;
              w += cw;
            }
            return out;
          }

          for (const line of parsed.diffLines) {
            if (line.startsWith("@@")) {
              const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
              if (m) {
                oldLine = parseInt(m[1]!);
                newLine = parseInt(m[2]!);
              }
              continue;
            }
            if (line.startsWith("+++") || line.startsWith("---")) {
              continue;
            }
            const num = (line.startsWith("+") ? String(newLine) : line.startsWith("-") ? String(oldLine) : String(newLine)).padStart(nw);
            const lpw = stringWidth(leftPad);
            const prefix = ` ${num} `;
            const maxContent = Math.max(0, targetWidth - lpw - stringWidth(prefix));
            const visible = clipped(line, maxContent);
            const bgWidth = lpw + stringWidth(prefix) + stringWidth(visible);
            const pad = bgWidth < targetWidth ? " ".repeat(targetWidth - bgWidth) : "";
            if (line.startsWith("+")) {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}
                  <Text backgroundColor="#1a3a1a">
                    <Text color={theme.success}>{prefix}</Text>{visible}{pad}
                  </Text>
                </Text>,
              );
              newLine++;
            } else if (line.startsWith("-")) {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}
                  <Text backgroundColor="#3a1a1a">
                    <Text color={theme.error}>{prefix}</Text>{visible}{pad}
                  </Text>
                </Text>,
              );
              oldLine++;
            } else {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}{prefix}{visible}{pad}
                </Text>,
              );
              oldLine++;
              newLine++;
            }
          }
          blank();
          continue;
        }
      }
      // Default rendering for other tools
      const isError = msg.content.startsWith("Error:");
      const ls = msg.content.replace(/\n+$/, "").split("\n");
      ls.forEach((line, i) => {
        lines.push(
          <Text
            key={`r${key++}`}
            color={isError ? theme.error : undefined}
            dimColor={!isError}
          >
            {(i === 0 ? "  ⎿ " : "    ") + truncate(line, RESULT_LINE_MAX)}
          </Text>,
        );
      });
      blank();
    }
  }
  return lines;
}

interface TranscriptViewProps {
  messages: Message[];
  cols: number;
  rows: number;
  hiddenToolIds?: Set<string>;
  toolNames?: Map<string, string>;
}

export function TranscriptView({ messages, cols, rows, hiddenToolIds, toolNames }: TranscriptViewProps) {
  const allLines = buildTranscriptLines(messages, cols, hiddenToolIds, toolNames);
  const HEADER_ROWS = 1;
  const viewportRows = Math.max(1, rows - HEADER_ROWS);
  const maxOffset = Math.max(0, allLines.length - viewportRows);
  const [offset, setOffset] = useState(maxOffset);
  const clamped = Math.min(Math.max(0, offset), maxOffset);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setOffset((o) => Math.max(0, Math.min(o, maxOffset) - 1));
    } else if (key.downArrow || input === "j") {
      setOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.pageUp) {
      setOffset((o) => Math.max(0, Math.min(o, maxOffset) - viewportRows));
    } else if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + viewportRows));
    } else if (input === "g") {
      setOffset(0);
    } else if (input === "G") {
      setOffset(maxOffset);
    }
  });

  const visible = allLines.slice(clamped, clamped + viewportRows);
  const startLine = allLines.length === 0 ? 0 : clamped + 1;
  const endLine = Math.min(clamped + viewportRows, allLines.length);

  return (
    <Box flexDirection="column" height={rows} flexShrink={0} width={cols}>
      <Box paddingX={2}>
        <Text bold color={theme.accent}>Transcript</Text>
        <Text dimColor>
          {"  · "}
          {startLine}-{endLine} / {allLines.length}
          {"  · ↑↓/PgUp/PgDn/g/G  · esc to close"}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visible}
      </Box>
    </Box>
  );
}
