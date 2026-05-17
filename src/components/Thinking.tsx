import { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

interface Props {
  content: string;
  expanded: boolean;
  active?: boolean;
  /** Drop the trailing gap so a follow-on block (e.g. an interrupted
   *  marker) hugs the thinking line as one visual unit. */
  flush?: boolean;
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

export function Thinking({ content, expanded, active = false, flush = false }: Props) {
  const spinner = useSpinner(active);
  return (
    <Block flush={flush}>
      <Text color={!expanded && !active ? theme.thinkingFolded : theme.thinking}>
        {active ? `${spinner} ` : "✓ "}
        {expanded ? "thinking" : "thinking (ctrl+o to view)"} (
        {content.length > 1000
          ? `${(content.length / 1000).toFixed(1)}K chars`
          : `${content.length} chars`}
        )
      </Text>
      {expanded && (
        <Text color={theme.thinkingBody}>
          {content}
        </Text>
      )}
    </Block>
  );
}
