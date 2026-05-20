import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

export interface ModelOption {
  value: string;
  label: string;
  description: string;
}

interface Props {
  options: ReadonlyArray<ModelOption>;
  current: string;
  onSave: (model: string) => void;
  onCancel: () => void;
}

export function ModelPanel({ options, current, onSave, onCancel }: Props) {
  const col = process.stdout.columns || 80;
  const [row, setRow] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === current),
    ),
  );

  useInput((input, key) => {
    if (key.upArrow) {
      setRow((r) => (r - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setRow((r) => (r + 1) % options.length);
      return;
    }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      setRow(n - 1);
      return;
    }
    if (key.return) {
      onSave(options[row]!.value);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Block>
      <Text dimColor>{"─".repeat(col)}</Text>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text color={theme.accent} bold>
          Model
        </Text>
        <Box flexDirection="column">
          {options.map((option, i) => {
            const active = i === row;
            const currentMark = option.value === current ? " current" : "";
            return (
              <Text key={option.value}>
                <Text
                  color={active ? theme.accent : undefined}
                  dimColor={!active}
                >
                  {active ? "> " : "  "}
                  {i + 1}. {option.label}
                </Text>
                <Text dimColor>{`   ${option.description}${currentMark}`}</Text>
              </Text>
            );
          })}
        </Box>
        <Text dimColor>{"↑/↓ 或数字选择 · Enter 保存 · Esc 取消"}</Text>
      </Box>
    </Block>
  );
}
