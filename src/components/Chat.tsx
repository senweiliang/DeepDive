import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { Message } from "../types.js";
import { Thinking } from "./Thinking.js";

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

interface Props {
  messages: Message[];
  thinking: string;
  response: string;
  isStreaming: boolean;
  showThinking: boolean;
}

export function Chat({ messages, thinking, response, isStreaming, showThinking }: Props) {
  const col = process.stdout.columns || 80;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {msg.reasoning_content && (
            <Thinking content={msg.reasoning_content} expanded={showThinking} />
          )}
          {msg.content && (
            <Box marginTop={msg.reasoning_content ? 1 : 0}>
              {msg.role === "user" ? (
                <Text backgroundColor="#3a3a3a">
                  {padLines(`> ${msg.content}`, col)}
                </Text>
              ) : (
                <Text>{indentLines(msg.content, "● ", "  ")}</Text>
              )}
            </Box>
          )}
        </Box>
      ))}

      {isStreaming && thinking && (
        <Thinking
          content={thinking}
          expanded={showThinking}
          active={!response}
        />
      )}
      {isStreaming && response && completedLines(response) && (
        <Box marginTop={thinking ? 1 : 0}>
          <Text>{indentLines(completedLines(response), "● ", "  ")}</Text>
        </Box>
      )}
    </Box>
  );
}
