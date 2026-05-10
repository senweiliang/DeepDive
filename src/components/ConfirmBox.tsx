import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { summarizeArgs } from "../tools/format.js";

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  onApprove: () => void;
  onDeny: () => void;
}

const options = [
  { label: "Approve", action: "approve" as const },
  { label: "Deny", action: "deny" as const },
];

export function ConfirmBox({ toolName, args, onApprove, onDeny }: Props) {
  const summary = summarizeArgs(toolName, args);
  const col = process.stdout.columns || 80;
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(options.length - 1, s + 1));
      return;
    }
    if (key.return) {
      if (options[selected]!.action === "approve") onApprove();
      else onDeny();
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{"─".repeat(col)}</Text>
      <Box flexDirection="column" paddingX={1}>
        <Text color="yellow" bold>
          Approve tool execution?
        </Text>
        <Box marginTop={1}>
          <Text>
            <Text bold color="cyan">
              {toolName}
            </Text>
            <Text dimColor> {summary}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {options.map((opt, i) => {
            const active = i === selected;
            return (
              <Text key={opt.action} color={active ? "cyan" : undefined}>
                {active ? "> " : "  "}
                {opt.label}
              </Text>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

