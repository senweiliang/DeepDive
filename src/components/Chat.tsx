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

function ToolResultLines({ content }: { content: string }) {
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
}

export function MessageItem({ msg, showThinking, cols }: MessageItemProps) {
  return (
    <Box flexDirection="column">
      {msg.reasoning_content && (
        <Thinking content={msg.reasoning_content} expanded={showThinking} />
      )}
      {msg.content && msg.role !== "tool" && (
        <Box marginBottom={1}>
          {msg.role === "user" ? (
            <Text backgroundColor="#3a3a3a">
              {padLines(`> ${msg.content}`, cols)}
            </Text>
          ) : (
            <Text>{indentLines(msg.content, "● ", "  ")}</Text>
          )}
        </Box>
      )}
      {msg.role === "assistant" &&
        msg.tool_calls?.map((tc) => (
          <ToolCallLine key={tc.id} call={tc} />
        ))}
      {msg.role === "tool" && msg.content && (
        <ToolResultLines content={msg.content} />
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

function buildTranscriptLines(messages: Message[], cols: number): ReactNode[] {
  const lines: ReactNode[] = [];
  let key = 0;
  const blank = () => {
    lines.push(<Text key={`b${key++}`}> </Text>);
  };
  for (const msg of messages) {
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
}

export function TranscriptView({ messages, cols, rows }: TranscriptViewProps) {
  const allLines = buildTranscriptLines(messages, cols);
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
