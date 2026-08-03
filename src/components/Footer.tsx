import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ApprovalMode, Usage } from "../types.js";
import type { Balance } from "../balance.js";
import { theme } from "../theme.js";

interface Props {
  model: string;
  /** The resolved model when config.model is "auto" — e.g. "deepseek-v4-pro". */
  activeModel?: string;
  usage: Usage | null;
  cumulativeTokens: { in: number; out: number };
  /** Per-turn cache-hit % (latest request only), shown as a "(turn x%)"
   *  suffix on the session-cumulative rate — a cold first turn otherwise
   *  hides a warm cache (see footer unit nav). */
  turnCacheHitPct?: number | null;
  mode: ApprovalMode;
  /** Current reasoning tier (`none`…`xhigh`), set in `/settings`. */
  reasoningEffort?: string;
  hint?: string;
  balance?: Balance | null;
  contextWindow?: number;
  compacting?: boolean;
  /** Number of background tasks (subagents / shells) currently running. */
  bgRunning?: number;
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
  activeModel,
  usage,
  cumulativeTokens,
  turnCacheHitPct,
  mode,
  reasoningEffort,
  hint,
  balance,
  contextWindow,
  compacting,
  bgRunning,
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
  const displayModel = model === "auto" && activeModel
    ? `Auto(${activeModel})`
    : model;
  segments.push(
    <Box key="model-mode" gap={1} marginRight={2}>
      <Text bold color={theme.accent}>{displayModel}</Text>
      <Text dimColor>|</Text>
      <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>
      {reasoningEffort ? (
        <>
          <Text dimColor>|</Text>
          <Text color={theme.thinking}>think: {reasoningEffort}</Text>
        </>
      ) : null}
    </Box>,
  );

  // in / out (session-cumulative)
  segments.push(
    <Box key="io" gap={1} marginRight={2}>
      <Text dimColor>in: {formatTokens(cumulativeTokens.in)}</Text>
      <Text dimColor>out: {formatTokens(cumulativeTokens.out)}</Text>
    </Box>,
  );

  // cache hit (session-cumulative %; per-turn % as a "(turn x%)" suffix)
  const turnSuffix = turnCacheHitPct != null ? ` (turn ${turnCacheHitPct}%)` : "";
  segments.push(
    <Box key="cache" marginRight={2}>
      <Text color={cacheHitPct !== null ? theme.success : undefined} dimColor={cacheHitPct === null}>
        cache hit: {cacheHitPct !== null ? `${cacheHitPct}%` : "—"}{turnSuffix}
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

  // background tasks
  if (bgRunning && bgRunning > 0) {
    segments.push(
      <Box key="bg" marginRight={2}>
        <Text color={theme.action}>
          ⚙ {bgRunning} bg{bgRunning > 1 ? " tasks" : " task"}
        </Text>
      </Box>,
    );
  }

  return (
    <Box paddingX={2} flexWrap="wrap">
      {segments}
    </Box>
  );
}
