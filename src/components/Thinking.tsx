import { useEffect, useState } from "react";
import { Box, Text } from "ink";

interface Props {
  content: string;
  expanded: boolean;
  active?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame]!;
}

export function Thinking({ content, expanded, active = false }: Props) {
  const spinner = useSpinner(active);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow" dimColor={!expanded}>
        {active ? `${spinner} ` : "✓ "}
        {expanded ? "thinking" : "thinking (ctrl+o to view)"} (
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
