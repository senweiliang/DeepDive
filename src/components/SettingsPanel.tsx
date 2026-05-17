import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { REASONING_EFFORTS } from "../config.js";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

interface Props {
  /** The effort tier currently in effect. */
  current: string;
  onSave: (effort: string) => void;
  onCancel: () => void;
}

const LABEL = "Reasoning effort";
const LABEL_COL = 44; // label column width before the value (official-ish)
// Fixed value column so the description always starts at the same x,
// regardless of which tier (high/max/none) is selected.
const VALUE_COL = Math.max(...REASONING_EFFORTS.map((e) => e.label.length));

export function SettingsPanel({ current, onSave, onCancel }: Props) {
  const col = process.stdout.columns || 80;
  const startIdx = Math.max(
    0,
    REASONING_EFFORTS.findIndex((e) => e.value === current),
  );
  // Pending (unsaved) selection — Enter commits, Esc discards.
  const [idx, setIdx] = useState(startIdx);
  const tier = REASONING_EFFORTS[idx]!;

  useInput((_input, key) => {
    if (key.leftArrow) {
      setIdx((i) => (i - 1 + REASONING_EFFORTS.length) % REASONING_EFFORTS.length);
      return;
    }
    if (key.rightArrow) {
      setIdx((i) => (i + 1) % REASONING_EFFORTS.length);
      return;
    }
    if (key.return) {
      onSave(tier.value);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  const pad = " ".repeat(Math.max(2, LABEL_COL - LABEL.length));

  return (
    <Block>
      <Text dimColor>{"─".repeat(col)}</Text>
      {/* Intra-block layout: one column, one `gap`. No marginTop — same rule
          as <Block>, applied internally (see ConfirmBox). */}
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text color={theme.accent} bold>
          Settings
        </Text>
        <Text>
          <Text color={theme.accent}>{"> " + LABEL}</Text>
          {pad}
          <Text color={theme.accent} bold>
            {tier.label}
          </Text>
          <Text dimColor>
            {" ".repeat(VALUE_COL - tier.label.length) + "   " + tier.description}
          </Text>
        </Text>
        <Text dimColor>←/→ 改值 · Enter 保存 · Esc 取消</Text>
      </Box>
    </Block>
  );
}
