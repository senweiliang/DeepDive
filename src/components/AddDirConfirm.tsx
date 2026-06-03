import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

interface Props {
  dir: string;
  onSession: () => void;
  onPersist: () => void;
  onDeny: () => void;
}

export function AddDirConfirm({ dir, onSession, onPersist, onDeny }: Props) {
  const col = process.stdout.columns || 80;
  const [selected, setSelected] = useState(0);

  const options = [
    { label: "当前会话", action: "session" as const },
    { label: "当前工作区所有会话", action: "persist" as const },
    { label: "拒绝", action: "deny" as const },
  ];

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
      const opt = options[selected]!;
      if (opt.action === "session") onSession();
      else if (opt.action === "persist") onPersist();
      else onDeny();
    }
    if (key.escape) {
      onDeny();
    }
  });

  return (
    <Block>
      <Text dimColor>{"─".repeat(col)}</Text>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text color={theme.approval} bold>
            Add workspace directory?
          </Text>
        </Box>
        <Text>
          <Text bold>{dir}</Text>
        </Text>
        <Box flexDirection="column">
          {options.map((opt, i) => {
            const active = i === selected;
            return (
              <Text key={opt.action} color={active ? theme.action : undefined}>
                {active ? "> " : "  "}
                {i + 1}. {opt.label}
              </Text>
            );
          })}
        </Box>
      </Box>
    </Block>
  );
}
