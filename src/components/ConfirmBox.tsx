import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { summarizeArgs, toolDisplayName } from "../tools/format.js";
import { theme } from "../theme.js";

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  warning?: string;
  onApprove: () => void;
  onDeny: () => void;
}

const options = [
  { label: "Approve", action: "approve" as const },
  { label: "Deny", action: "deny" as const },
];

export function ConfirmBox({ toolName, args, warning, onApprove, onDeny }: Props) {
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
        <Text color={theme.approval} bold>
          Approve tool execution?
        </Text>
        {warning && (
          <Text color={theme.error} bold>
            ⚠ {warning}
          </Text>
        )}
        <Box marginTop={1}>
          <Text>
            <Text bold>
              {toolDisplayName(toolName)}
            </Text>
            <Text> {summary}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {options.map((opt, i) => {
            const active = i === selected;
            return (
              <Text key={opt.action} color={active ? theme.action : undefined}>
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
