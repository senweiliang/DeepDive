import { Box, Text } from "ink";

interface Props {
  content: string;
  expanded: boolean;
}

export function Thinking({ content, expanded }: Props) {
  return (
    <Box flexDirection="column">
      <Text color="yellow" dimColor={!expanded}>
        {expanded ? "▼ thinking" : "▶ thinking (Tab to toggle)"} (
        {content.length > 1000
          ? `${(content.length / 1000).toFixed(1)}K chars`
          : `${content.length} chars`}
        )
      </Text>
      {expanded && (
        <Text color="yellow" dimColor>
          {content}
        </Text>
      )}
    </Box>
  );
}
