import { Box, Text } from "ink";
import { TextInput } from "@inkjs/ui";

interface Props {
  onSubmit: (input: string) => void;
  disabled: boolean;
  error: string;
}

export function InputBox({ onSubmit, disabled, error }: Props) {
  function handleSubmit(input: string) {
    if (input.trim()) {
      onSubmit(input.trim());
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      {error && <Text color="red">{error}</Text>}
      {!disabled && (
        <TextInput
          placeholder="DeepDive >"
          onSubmit={handleSubmit}
        />
      )}
      {disabled && <Text dimColor>thinking...</Text>}
    </Box>
  );
}
