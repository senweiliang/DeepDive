import { Box, Text } from "ink";
import type { ApprovalMode, Usage } from "../types.js";
import type { Balance } from "../balance.js";
import { theme } from "../theme.js";

interface Props {
  model: string;
  usage: Usage | null;
  mode: ApprovalMode;
  hint?: string;
  balance?: Balance | null;
  contextWindow?: number;
  compacting?: boolean;
}

function modeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "acceptEdits":
      return "Accept Edits";
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
      return theme.action;
    case "acceptEdits":
      return theme.cost;
    case "yolo":
      return theme.error;
    case "auto":
      return theme.success;
    default:
      return theme.approval;
  }
}

function formatTokens(n: number): string {
  return n > 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function ctxColor(pct: number): string | undefined {
  if (pct >= 80) return theme.error;
  if (pct >= 60) return theme.approval;
  return undefined;
}

export function Footer({
  model,
  usage,
  mode,
  hint,
  balance,
  contextWindow,
  compacting,
}: Props) {
  if (hint) {
    return (
      <Box paddingX={2}>
        <Text dimColor>{hint}</Text>
      </Box>
    );
  }
  const pct =
    usage && contextWindow && contextWindow > 0
      ? Math.round((usage.input_tokens / contextWindow) * 100)
      : null;
  return (
    <Box paddingX={2} gap={2}>
      <Text bold color={theme.accent}>DeepDive</Text>
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
              <Text color={theme.success}>
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
      {pct !== null && contextWindow && (
        <>
          <Text dimColor>|</Text>
          <Text color={ctxColor(pct)}>
            ctx: {formatTokens(usage!.input_tokens)}/{formatTokens(contextWindow)} ({pct}%)
          </Text>
        </>
      )}
      {compacting && (
        <>
          <Text dimColor>|</Text>
          <Text color={theme.cost}>⏳ compacting…</Text>
        </>
      )}
      {balance && (
        <>
          <Text dimColor>|</Text>
          <Text color={theme.cost}>¥{balance.totalBalance}</Text>
        </>
      )}
    </Box>
  );
}
