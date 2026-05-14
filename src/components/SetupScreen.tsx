import { useState } from "react";
import { Box, Text, useApp, useInput, usePaste } from "ink";
import { theme } from "../theme.js";

interface Props {
  onSave: (key: string) => void;
}

export function SetupScreen({ onSave }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const { exit } = useApp();

  usePaste((text) => {
    setValue((v) => v + text.replace(/\s+/g, ""));
    setError("");
  });

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      exit();
      process.exit(0);
    }
    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) {
        setError("Key is empty.");
        return;
      }
      onSave(trimmed);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setError("");
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
      setError("");
    }
  });

  const display =
    value.length === 0
      ? ""
      : value.length <= 8
        ? "•".repeat(value.length)
        : value.slice(0, 3) + "•".repeat(value.length - 6) + value.slice(-3);

  const placeholder = "(paste or type, then Enter)";
  const keyLine = `DEEPSEEK_API_KEY: ${display || placeholder}`;
  const hint = error || "Saved to ~/.deepdive/settings.json · Esc to quit";

  return (
    <Box flexDirection="column" paddingX={1} height={5}>
      <Text bold color={theme.accent}>Welcome to DeepDive</Text>
      <Text dimColor>Get your API key at https://platform.deepseek.com/api_keys</Text>
      <Text> </Text>
      <Text>{keyLine}</Text>
      <Text color={error ? theme.error : undefined} dimColor={!error}>{hint}</Text>
    </Box>
  );
}
