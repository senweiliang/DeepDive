import { Box, Text } from "ink";
import type { Message } from "../types.js";
import { Thinking } from "./Thinking.js";

interface Props {
  messages: Message[];
  thinking: string;
  response: string;
  isStreaming: boolean;
  showThinking: boolean;
}

export function Chat({ messages, thinking, response, isStreaming, showThinking }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text color={msg.role === "user" ? "blue" : "white"}>
            {msg.role === "user" ? "> " : ""}{" "}
          </Text>
          {msg.reasoning_content && (
            <Thinking content={msg.reasoning_content} expanded={showThinking} />
          )}
          {msg.content && <Text>{msg.content}</Text>}
        </Box>
      ))}

      {isStreaming && thinking && (
        <Thinking content={thinking} expanded={true} />
      )}
      {isStreaming && response && (
        <Text>{response}</Text>
      )}
    </Box>
  );
}
