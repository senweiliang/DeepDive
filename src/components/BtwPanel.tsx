import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";
import { theme } from "../theme.js";
import { Block } from "./Block.js";
import { Markdown } from "./Markdown.js";

export interface BtwExchange {
  question: string;
  /** null while loading (unless `error` is set). */
  response: string | null;
  error: string | null;
}

interface Props {
  exchanges: BtwExchange[];
  /** Blink state for the "Answering..." dot — shares App's runningBash/
   *  runningSubagent blink interval instead of its own timer. */
  dotVisible: boolean;
  cols: number;
  onSubmit: (question: string) => void;
  onDismiss: () => void;
}

export function BtwPanel({ exchanges, dotVisible, cols, onSubmit, onDismiss }: Props) {
  const last = exchanges[exchanges.length - 1];
  const loading = !!last && last.response == null && last.error == null;

  return (
    <Block>
      <Text dimColor>{"─".repeat(cols)}</Text>
      {exchanges.map((ex, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Box>
            {i === 0 ? (
              <Text color={theme.approval} bold>
                /btw{" "}
              </Text>
            ) : (
              <Text dimColor>{"> "}</Text>
            )}
            <Text dimColor>{ex.question}</Text>
          </Box>
          <Box marginTop={1} marginLeft={2} flexDirection="column">
            {ex.error ? (
              <Text color={theme.error}>{ex.error}</Text>
            ) : ex.response ? (
              <Markdown content={ex.response} firstPrefix="" restPrefix="" cols={cols} />
            ) : (
              <Box>
                <Text>{dotVisible ? "● " : "  "}</Text>
                <Text color={theme.approval}>Answering...</Text>
              </Box>
            )}
          </Box>
        </Box>
      ))}
      {!loading && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{"> "}</Text>
            {/* Remounted per exchange (key) so the uncontrolled buffer starts
                empty for each new follow-up instead of keeping stale text. */}
            <TextInput
              key={exchanges.length}
              placeholder="追问，或 Esc 关闭"
              onSubmit={(text) => {
                const q = text.trim();
                if (q) onSubmit(q);
                else onDismiss();
              }}
            />
          </Box>
          <Text dimColor>Enter 发送 · Esc 关闭</Text>
        </Box>
      )}
    </Block>
  );
}
