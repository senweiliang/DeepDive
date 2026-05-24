import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ApprovalMode, Usage } from "../types.js";
import type { Balance } from "../balance.js";
import { theme } from "../theme.js";

interface Props {
  model: string;
  usage: Usage | null;
  cumulativeTokens: { in: number; out: number };
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
  cumulativeTokens,
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
  const inTokens = usage?.input_tokens ?? 0;
  const outTokens = usage?.output_tokens ?? 0;
  const hasCache =
    usage?.prompt_cache_hit_tokens != null &&
    usage?.prompt_cache_miss_tokens != null &&
    usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens > 0;
  const cacheHitPct = hasCache
    ? Math.round(
        (usage!.prompt_cache_hit_tokens! /
          (usage!.prompt_cache_hit_tokens! +
            usage!.prompt_cache_miss_tokens!)) *
          100,
      )
    : null;
  const pct =
    contextWindow && contextWindow > 0
      ? Math.round((inTokens / contextWindow) * 100)
      : null;
  const segments: ReactNode[] = [];

  // model | mode
  segments.push(
    <Box key="model-mode" gap={1} marginRight={2}>
      <Text bold color={theme.accent}>{model}</Text>
      <Text dimColor>|</Text>
      <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>
    </Box>,
  );

  // in / out (session-cumulative)
  segments.push(
    <Box key="io" gap={1} marginRight={2}>
      <Text dimColor>in: {formatTokens(cumulativeTokens.in)}</Text>
      <Text dimColor>out: {formatTokens(cumulativeTokens.out)}</Text>
    </Box>,
  );

  // cache hit
  segments.push(
    <Box key="cache" marginRight={2}>
      <Text color={cacheHitPct !== null ? theme.success : undefined} dimColor={cacheHitPct === null}>
        cache hit: {cacheHitPct !== null ? `${cacheHitPct}%` : "—"}
      </Text>
    </Box>,
  );

  // ctx
  if (pct !== null && contextWindow) {
    segments.push(
      <Box key="ctx" marginRight={2}>
        <Text color={ctxColor(pct)}>
          ctx: {formatTokens(inTokens)}/{formatTokens(contextWindow)} ({pct}%)
        </Text>
      </Box>,
    );
  }

  // balance
  if (balance) {
    segments.push(
      <Box key="balance" marginRight={2}>
        <Text color={theme.cost}>¥{balance.totalBalance}</Text>
      </Box>,
    );
  }

  return (
    <Box paddingX={2} flexWrap="wrap">
      {segments}
    </Box>
  );
}
