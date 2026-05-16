import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { summarizeArgs, toolDisplayName } from "../tools/format.js";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  warning?: string;
  /** null when no safe reusable pattern exists — hides "Allow always". */
  savePattern: string | null;
  onApprove: () => void;
  onAllowAlways: (pattern: string) => void;
  /** Switch to acceptEdits mode and approve (file-edit tools only). */
  onAcceptEdits: () => void;
  onDeny: () => void;
}

export function ConfirmBox({ toolName, args, warning, savePattern, onApprove, onAllowAlways, onAcceptEdits, onDeny }: Props) {
  const summary = summarizeArgs(toolName, args);
  const col = process.stdout.columns || 80;
  const [selected, setSelected] = useState(0);
  const isEdit = toolName === "write_file" || toolName === "edit_file";

  const options = [
    { label: "Allow once", action: "approve" as const },
    ...(isEdit
      ? [
          {
            label: "Allow all edits this session (shift+tab)",
            action: "accept-edits" as const,
          },
        ]
      : []),
    ...(savePattern && !isEdit
      ? [
          {
            label: `Allow always (${savePattern})`,
            action: "allow-always" as const,
          },
        ]
      : []),
    { label: "Deny", action: "deny" as const },
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
      if (opt.action === "approve") onApprove();
      else if (opt.action === "accept-edits") onAcceptEdits();
      else if (opt.action === "allow-always" && savePattern)
        onAllowAlways(savePattern);
      else onDeny();
    }
  });

  return (
    <Block>
      <Text dimColor>{"─".repeat(col)}</Text>
      {/* Intra-block layout: one column, one `gap`. No marginTop — sub-rows
          never own spacing (same rule as <Block>, applied internally). */}
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text color={theme.approval} bold>
            Approve tool execution?
          </Text>
          {warning && (
            <Text color={theme.error} bold>
              ⚠ {warning}
            </Text>
          )}
        </Box>
        <Text>
          <Text bold>
            {toolDisplayName(toolName)}
          </Text>
          <Text> {summary}</Text>
        </Text>
        <Box flexDirection="column">
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
    </Block>
  );
}
