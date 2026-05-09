import { Box, Text } from "ink";
import type { ApprovalMode, Usage } from "../types.js";

interface Props {
  model: string;
  usage: Usage | null;
  mode: ApprovalMode;
}

function modeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "yolo":
      return "YOLO";
    default:
      return "Default";
  }
}

function modeColor(mode: ApprovalMode): string {
  switch (mode) {
    case "plan":
      return "blue";
    case "yolo":
      return "red";
    default:
      return "yellow";
  }
}

export function Header({ model, usage, mode }: Props) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
      <Box gap={2}>
        <Text bold color="cyan">DeepDive</Text>
        <Text dimColor>|</Text>
        <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{model}</Text>
        {usage && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>
              in:{" "}
              {usage.input_tokens > 1000
                ? `${(usage.input_tokens / 1000).toFixed(1)}K`
                : usage.input_tokens}
            </Text>
            <Text dimColor>
              out:{" "}
              {usage.output_tokens > 1000
                ? `${(usage.output_tokens / 1000).toFixed(1)}K`
                : usage.output_tokens}
            </Text>
            {usage.prompt_cache_hit_tokens != null &&
              usage.prompt_cache_miss_tokens != null && (
                <Text color="green">
                  cache:{" "}
                  {Math.round(
                    (usage.prompt_cache_hit_tokens /
                      (usage.prompt_cache_hit_tokens +
                        usage.prompt_cache_miss_tokens)) *
                      100,
                  )}
                  %
                </Text>
              )}
          </>
        )}
        <Text dimColor>| Shift+Tab switch</Text>
      </Box>
    </Box>
  );
}
