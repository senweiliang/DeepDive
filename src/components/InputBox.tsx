import { useState } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";

interface Props {
  onSubmit: (input: string) => void;
  disabled: boolean;
  error: string;
}

export function InputBox({ onSubmit, disabled, error }: Props) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (disabled) return;

    // Paste with embedded newlines — insert text, don't submit.
    // Normalize \r\n → \n so Windows pastes work.
    if (input && (input.includes("\n") || input.includes("\r"))) {
      setValue((prev) => prev + input.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      return;
    }

    if (key.ctrl && (input === "j" || input === "m")) {
      setValue((prev) => prev + "\n");
      return;
    }

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue("");
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
      setValue((prev) => prev + input);
    }
  });

  const prompt = "> ";
  const indent = "  ";
  const col = process.stdout.columns || 80;

  // Split by newlines, then chunk each line by terminal column width.
  const logicalLines = value.split("\n");

  interface VisualLine {
    text: string;
  }

  const visualLines: VisualLine[] = [];
  for (let i = 0; i < logicalLines.length; i++) {
    const prefix = i === 0 ? prompt : indent;
    const maxCols = col - prefix.length;
    const line = logicalLines[i]!;

    if (line.length === 0) {
      visualLines.push({ text: "" });
      continue;
    }

    let chunk = "";
    let chunkCols = 0;
    for (const ch of line) {
      const chW = stringWidth(ch);
      if (chunkCols + chW > maxCols) {
        visualLines.push({ text: chunk });
        chunk = "";
        chunkCols = 0;
      }
      chunk += ch;
      chunkCols += chW;
    }
    if (chunk) visualLines.push({ text: chunk });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{"─".repeat(col)}</Text>
      {error && <Text color="red">{error}</Text>}
      {!disabled && (
        <Box flexDirection="column">
          {value === "" ? (
            <Text>
              {prompt}
              <Text color="white">█</Text>
            </Text>
          ) : (
            visualLines.map((vl, i) => {
              const isFirst = i === 0;
              const isLast = i === visualLines.length - 1;
              return (
                <Text key={i}>
                  {isFirst ? prompt : indent}
                  {vl.text}
                  {isLast ? <Text color="white">█</Text> : ""}
                </Text>
              );
            })
          )}
        </Box>
      )}
      {disabled && <Text dimColor>thinking...</Text>}
    </Box>
  );
}
