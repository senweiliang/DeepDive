import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import type { Message, ToolCall } from "../types.js";
import { Thinking } from "./Thinking.js";
import { summarizeArgs, truncate } from "../tools/format.js";

const RESULT_PREVIEW_LINES = 3;
const RESULT_LINE_MAX = 120;
const ARGS_SUMMARY_MAX = 80;

function ToolCallLine({ call }: { call: ToolCall }) {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    // keep args empty if streaming was incomplete
  }
  const summary = truncate(summarizeArgs(call.function.name, args), ARGS_SUMMARY_MAX);
  return (
    <Box marginBottom={1}>
      <Text>
        <Text color="green">● </Text>
        <Text bold color="cyan">{call.function.name}</Text>
        <Text>(</Text>
        <Text dimColor>{summary}</Text>
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

function DiffView({ content }: { content: string }) {
  const parsed = parseDiff(content);
  if (!parsed) {
    const lines = content.split("\n");
    const preview = lines.slice(0, RESULT_PREVIEW_LINES);
    const more = lines.length - preview.length;
    return (
      <Box flexDirection="column" marginBottom={1} marginLeft={2}>
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
      ⎿  {parts.join(", ")}
    </Text>,
  );

  const leftPad = "    ";
  let oldLine = 0;
  let newLine = 0;

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
      // Skip file headers in display
      continue;
    } else if (line.startsWith("+")) {
      const num = String(newLine).padStart(numWidth);
      lines.push(
        <Text key={`a${lines.length}`} backgroundColor="#1a3a1a">
          {leftPad}<Text color="green">{num}</Text> {line}
        </Text>,
      );
      newLine++;
    } else if (line.startsWith("-")) {
      const num = String(oldLine).padStart(numWidth);
      lines.push(
        <Text key={`r${lines.length}`} backgroundColor="#3a1a1a">
          {leftPad}<Text color="red">{num}</Text> {line}
        </Text>,
      );
      oldLine++;
    } else {
      // Context line (starts with ' ')
      const num = String(newLine).padStart(numWidth);
      lines.push(
        <Text key={`c${lines.length}`}>
          {leftPad}{num} {line}
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
}: {
  content: string;
  toolName?: string;
}) {
  if (toolName === "edit_file" && content.includes("```diff")) {
    return <DiffView content={content} />;
  }

  const isError = content.startsWith("Error:");
  const lines = content.split("\n");
  const preview = lines.slice(0, RESULT_PREVIEW_LINES);
  const more = lines.length - preview.length;
  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      {preview.map((line, i) => (
        <Text key={i} color={isError ? "red" : undefined} dimColor={!isError}>
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
  // User messages: show compact display_content if available, otherwise full content
  const displayed = msg.role === "user" ? (msg.display_content ?? msg.content) : msg.content;
  const toolName =
    msg.role === "tool" && msg.tool_call_id
      ? toolNames?.get(msg.tool_call_id)
      : undefined;
  return (
    <Box flexDirection="column">
      {msg.reasoning_content && (
        <Thinking content={msg.reasoning_content} expanded={showThinking} />
      )}
      {displayed && msg.role !== "tool" && (
        <Box marginBottom={1}>
          {msg.role === "user" ? (
            <Text backgroundColor="#3a3a3a">
              {padLines(`> ${displayed}`, cols)}
            </Text>
          ) : (
            <Text>{indentLines(displayed, "● ", "  ")}</Text>
          )}
        </Box>
      )}
      {msg.role === "assistant" &&
        msg.tool_calls
          ?.filter((tc) => !hiddenToolIds?.has(tc.id))
          .map((tc) => <ToolCallLine key={tc.id} call={tc} />)}
      {msg.role === "tool" && msg.content && (
        <ToolResultLines content={msg.content} toolName={toolName} />
      )}
    </Box>
  );
}

interface StreamPreviewProps {
  thinking: string;
  response: string;
  isStreaming: boolean;
  showThinking: boolean;
}

export function StreamPreview({
  thinking,
  response,
  isStreaming,
  showThinking,
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
          <Text>{indentLines(visibleResponse, "● ", "  ")}</Text>
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
    if (msg.reasoning_content) {
      lines.push(
        <Text key={`t${key++}`} color="yellow" bold>
          ✓ thinking
        </Text>,
      );
      for (const l of msg.reasoning_content.split("\n")) {
        lines.push(
          <Text key={`tt${key++}`} color="yellow" dimColor>
            {l || " "}
          </Text>,
        );
      }
      blank();
    }
    if (msg.content && msg.role !== "tool") {
      // Transcript always shows the real content, never display_content
      const splitLines = (msg.role === "user" ? `> ${msg.content}` : msg.content).split("\n");
      splitLines.forEach((line, i) => {
        if (msg.role === "user") {
          const pad = " ".repeat(Math.max(0, cols - stringWidth(line)));
          lines.push(
            <Text key={`u${key++}`} backgroundColor="#3a3a3a">
              {line + pad}
            </Text>,
          );
        } else {
          const prefix = i === 0 ? "● " : "  ";
          lines.push(<Text key={`a${key++}`}>{prefix + (line || "")}</Text>);
        }
      });
      blank();
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (hiddenToolIds?.has(tc.id)) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // ignore
        }
        const summary = truncate(
          summarizeArgs(tc.function.name, args),
          ARGS_SUMMARY_MAX,
        );
        lines.push(
          <Text key={`c${key++}`}>
            <Text color="green">● </Text>
            <Text bold color="cyan">{tc.function.name}</Text>
            <Text>(</Text>
            <Text dimColor>{summary}</Text>
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
          const leftPad = "    ";
          const nw = parsed.numWidth;
          let oldLine = 0;
          let newLine = 0;
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
            } else if (line.startsWith("+")) {
              const num = String(newLine).padStart(nw);
              lines.push(
                <Text key={`t${key++}`} backgroundColor="#1a3a1a">
                  {leftPad}<Text color="green">{num}</Text> {line}
                </Text>,
              );
              newLine++;
            } else if (line.startsWith("-")) {
              const num = String(oldLine).padStart(nw);
              lines.push(
                <Text key={`t${key++}`} backgroundColor="#3a1a1a">
                  {leftPad}<Text color="red">{num}</Text> {line}
                </Text>,
              );
              oldLine++;
            } else {
              const num = String(newLine).padStart(nw);
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}{num} {line}
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
      const ls = msg.content.split("\n");
      ls.forEach((line, i) => {
        lines.push(
          <Text
            key={`r${key++}`}
            color={isError ? "red" : undefined}
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
        <Text bold color="cyan">Transcript</Text>
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
