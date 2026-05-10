import { Box, Text } from "ink";
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

interface TranscriptViewProps {
  messages: Message[];
  cols: number;
}

export function TranscriptView({ messages, cols }: TranscriptViewProps) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Box paddingX={2} marginBottom={1}>
        <Text bold color="cyan">
          Transcript
        </Text>
        <Text dimColor>  ·  esc to close</Text>
      </Box>
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column">
          {msg.reasoning_content && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="yellow" bold>
                ✓ thinking
              </Text>
              <Text color="yellow" dimColor>
                {msg.reasoning_content}
              </Text>
            </Box>
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
      ))}
      <Text dimColor>{"─".repeat(cols)}</Text>
    </Box>
  );
}
