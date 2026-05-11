import { Box, Text } from "ink";
import type { ApprovalMode, Usage } from "../types.js";

interface Props {
  model: string;
  usage: Usage | null;
  mode: ApprovalMode;
  hint?: string;
}

function modeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "yolo":
      return "YOLO";
    case "auto":
      return "Auto";
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
    case "auto":
      return "green";
    default:
      return "yellow";
  }
}

function formatTokens(n: number): string {
  return n > 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function Footer({ model, usage, mode, hint }: Props) {
  if (hint) {
    return (
      <Box paddingX={2}>
        <Text dimColor>{hint}</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={2} gap={2}>
      <Text bold color="cyan">DeepDive</Text>
      <Text dimColor>|</Text>
      <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>
      <Text dimColor>|</Text>
      <Text dimColor>{model}</Text>
      {usage && (
        <>
          <Text dimColor>|</Text>
          <Text dimColor>in: {formatTokens(usage.input_tokens)}</Text>
          <Text dimColor>out: {formatTokens(usage.output_tokens)}</Text>
          {usage.prompt_cache_hit_tokens != null &&
            usage.prompt_cache_miss_tokens != null && (
              <Text color="green">
                cache hit:{" "}
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
    </Box>
  );
}
