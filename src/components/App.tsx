import { useState } from "react";
import { Box, useInput } from "ink";
import type { Message, Usage } from "../types.js";
import type { Config } from "../config.js";
import { chat } from "../client.js";
import { Header } from "./Header.js";
import { Chat } from "./Chat.js";
import { InputBox } from "./InputBox.js";

interface Props {
  config: Config;
}

export function App({ config }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [thinking, setThinking] = useState("");
  const [response, setResponse] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [showThinking, setShowThinking] = useState(false);

  useInput((input, key) => {
    if (key.tab) {
      setShowThinking((prev) => !prev);
    }
  });

  async function handleSend(input: string) {
    setError("");
    setThinking("");
    setResponse("");
    setUsage(null);

    const userMsg: Message = { role: "user", content: input };
    const history = [...messages, userMsg];
    setMessages(history);
    setIsStreaming(true);

    try {
      let fullContent = "";
      let fullThinking = "";
      let lastUsage: Usage | null = null;

      for await (const chunk of chat(config, history)) {
        if (chunk.reasoning_content) {
          fullThinking += chunk.reasoning_content;
          setThinking(fullThinking);
        }
        if (chunk.content) {
          fullContent += chunk.content;
          setResponse(fullContent);
        }
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
      }

      setUsage(lastUsage);

      const assistantMsg: Message = {
        role: "assistant",
        content: fullContent,
        reasoning_content: fullThinking || undefined,
      };
      setMessages([...history, assistantMsg]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header model={config.model} usage={usage} />
      <Chat messages={messages} thinking={thinking} response={response} isStreaming={isStreaming} showThinking={showThinking} />
      <InputBox onSubmit={handleSend} disabled={isStreaming} error={error} />
    </Box>
  );
}
