import { useState, useEffect, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import type { Message, ToolCall, SubagentRun } from "../types.js";
import { Thinking } from "./Thinking.js";
import { Block } from "./Block.js";
import { ToolResult, RESULT_PREVIEW_LINES, RESULT_LINE_MAX, MARKER, MARKER_CONT } from "./ToolResult.js";
import { Markdown } from "./Markdown.js";
import { summarizeArgs, toolDisplayName, truncate } from "../tools/format.js";
import { theme } from "../theme.js";
import { DOT_BLINK_MS } from "./Running.js";

const ARGS_SUMMARY_MAX = 80;

// write_file overwrites whole files, so its diff can be arbitrarily long.
// Cap the rendered body (edit_file stays uncapped — its diffs are scoped to a
// ±3-line hunk). Sits between the generic 3-line ToolResult preview and
// edit_file's full diff.
const WRITE_DIFF_MAX_LINES = 20;

// Cap the subagent step list in the live transcript so a long run (dozens of
// tool calls) can't flood the scrollback. The Ctrl+O full transcript shows
// every step. The `done · …` footer always renders regardless of the cap.
const SUBAGENT_STEP_PREVIEW = 3;

// 命令参数最多占终端宽度的 80%，剩余留给工具名/括号与右侧呼吸空间。
function argsMax(cols: number): number {
  return Math.max(ARGS_SUMMARY_MAX, Math.floor(cols * 0.8));
}

function ToolCallLine({
  call,
  cols,
  running = false,
  done = false,
  error = false,
  declined = false,
}: {
  call: ToolCall;
  cols: number;
  running?: boolean;
  done?: boolean;
  error?: boolean;
  declined?: boolean;
}) {
  const [dotVisible, setDotVisible] = useState(true);

  useEffect(() => {
    if (!running) {
      setDotVisible(true);
      return;
    }
    const timer = setInterval(() => {
      setDotVisible((v) => !v);
    }, DOT_BLINK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const displayName = toolDisplayName(call.function.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    // keep args empty if streaming was incomplete
  }
  const summary = truncate(
    summarizeArgs(call.function.name, args),
    argsMax(cols),
  );
  const dot = error ? (
    <Text color={theme.error}>● </Text>
  ) : done ? (
    <Text color={theme.success}>● </Text>
  ) : running ? (
    <Text>{dotVisible ? "● " : "  "}</Text>
  ) : (
    <Text>● </Text>
  );
  // ask_user_question renders as a friendly "answered" header (no args
  // parens) — its body is the · Q → A list rendered by <AnswerLines>.
  if (call.function.name === "ask_user_question") {
    // Declined isn't a "success" — use a default-colored dot, not the green one.
    const askDot = declined ? <Text>● </Text> : dot;
    return (
      <Box>
        <Text>
          {askDot}
          <Text bold>
            {declined ? "User declined to answer questions" : "用户已回答："}
          </Text>
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>
        {dot}
        <Text bold>{displayName}</Text>
        <Text>(</Text>
        <Text>{summary}</Text>
        <Text>)</Text>
      </Text>
    </Box>
  );
}

/**
 * Parse an ask_user_question tool result ({"answers":{Q:A}}) into [Q, A] pairs.
 * Returns [] for the declined/malformed case so callers fall back accordingly.
 */
function parseAnswers(content: string): [string, string][] {
  try {
    const obj = JSON.parse(content) as { answers?: Record<string, unknown> };
    if (obj && obj.answers && typeof obj.answers === "object") {
      return Object.entries(obj.answers).map(([k, v]) => [k, String(v)]);
    }
  } catch {
    // not the expected JSON shape — handled by the caller
  }
  return [];
}

/**
 * Parse a declined ask_user_question result ({"declined":[Q,…]}) into the list
 * of questions the user refused to answer. Returns null when not a declined result.
 */
function parseDeclined(content: string): string[] | null {
  try {
    const obj = JSON.parse(content) as { declined?: unknown };
    if (obj && Array.isArray(obj.declined)) return obj.declined.map(String);
  } catch {
    // not the expected JSON shape
  }
  return null;
}

/** Render an ask_user_question result as `⎿ · …` lines (live view): answers as
 *  `· Q → A`, or — when declined — the list of questions left unanswered. */
function AnswerLines({ content, cols }: { content: string; cols: number }) {
  const max = Math.max(20, cols - 5);
  const declined = parseDeclined(content);
  if (declined) {
    return (
      <Box flexDirection="column">
        {declined.map((q, i) => (
          <Text key={i} dimColor>
            {i === 0 ? MARKER : MARKER_CONT}
            {truncate(`· ${q}`, max)}
          </Text>
        ))}
      </Box>
    );
  }
  const entries = parseAnswers(content);
  if (entries.length === 0) {
    // Unexpected shape — show as plain text.
    return <ToolResult content={content} cols={cols} maxLines={Infinity} />;
  }
  return (
    <Box flexDirection="column">
      {entries.map(([qText, aText], i) => (
        <Text key={i} dimColor>
          {i === 0 ? MARKER : MARKER_CONT}
          {truncate(`· ${qText} → ${aText}`, max)}
        </Text>
      ))}
    </Box>
  );
}

function parseDiff(content: string): {
  diffLines: string[];
  added: number;
  removed: number;
  numWidth: number;
} | null {
  const fenceIdx = content.indexOf("```diff");
  if (fenceIdx === -1) return null;
  const diffStart = content.indexOf("\n", fenceIdx) + 1;
  const diffEnd = content.lastIndexOf("\n```");
  const diffText =
    diffEnd !== -1 ? content.slice(diffStart, diffEnd) : content.slice(diffStart);
  const lines = diffText.split("\n");
  let added = 0;
  let removed = 0;
  let maxNum = 0;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
      if (m) {
        oldLine = parseInt(m[1]!);
        newLine = parseInt(m[2]!);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      maxNum = Math.max(maxNum, newLine);
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
      maxNum = Math.max(maxNum, oldLine);
      oldLine++;
    } else if (!line.startsWith("---") && !line.startsWith("+++")) {
      maxNum = Math.max(maxNum, newLine);
      oldLine++;
      newLine++;
    }
  }
  return { diffLines: lines, added, removed, numWidth: Math.max(1, String(maxNum).length) };
}

function DiffView({
  content,
  cols,
  maxLines,
}: {
  content: string;
  cols: number;
  maxLines?: number;
}) {
  const parsed = parseDiff(content);
  if (!parsed) {
    const lines = content.split("\n");
    const preview = lines.slice(0, RESULT_PREVIEW_LINES);
    const more = lines.length - preview.length;
    return (
      <Box flexDirection="column">
        {preview.map((line, i) => (
          <Text key={i} dimColor>
            {i === 0 ? MARKER : MARKER_CONT}
            {truncate(line, RESULT_LINE_MAX)}
          </Text>
        ))}
        {more > 0 && <Text dimColor>{MARKER_CONT}… +{more} lines</Text>}
      </Box>
    );
  }

  const { diffLines, added, removed, numWidth } = parsed;
  const lines: ReactNode[] = [];
  const body: ReactNode[] = [];

  // Stats on the ⎿ line
  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${added} lines`);
  if (removed > 0) parts.push(`removed ${removed} lines`);
  lines.push(
    <Text key="stats" dimColor>
      {MARKER}{parts.join(", ")}
    </Text>,
  );

  // Background ends at cols-5, leaving the rightmost 5 cols unstyled
  const targetWidth = Math.max(1, cols - 5);
  const leftPad = "    ";
  let oldLine = 0;
  let newLine = 0;

  function clipped(s: string, maxCols: number): string {
    if (maxCols <= 0) return "";
    let out = "";
    let w = 0;
    for (const ch of s) {
      const cw = stringWidth(ch);
      if (w + cw > maxCols) break;
      out += ch;
      w += cw;
    }
    return out;
  }

  for (const line of diffLines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
      if (m) {
        oldLine = parseInt(m[1]!);
        newLine = parseInt(m[2]!);
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    const num = (line.startsWith("+") ? String(newLine) : line.startsWith("-") ? String(oldLine) : String(newLine)).padStart(numWidth);
    const lpw = stringWidth(leftPad);
    const prefix = ` ${num} `;
    const maxContent = Math.max(0, targetWidth - lpw - stringWidth(prefix));
    const visible = clipped(line, maxContent);
    const bgWidth = lpw + stringWidth(prefix) + stringWidth(visible);
    const pad = bgWidth < targetWidth ? " ".repeat(targetWidth - bgWidth) : "";

    if (line.startsWith("+")) {
      body.push(
        <Text key={`a${body.length}`}>
          {leftPad}
          <Text backgroundColor="#1a3a1a">
            <Text color={theme.success}>{prefix}</Text>{visible}{pad}
          </Text>
        </Text>,
      );
      newLine++;
    } else if (line.startsWith("-")) {
      body.push(
        <Text key={`r${body.length}`}>
          {leftPad}
          <Text backgroundColor="#3a1a1a">
            <Text color={theme.error}>{prefix}</Text>{visible}{pad}
          </Text>
        </Text>,
      );
      oldLine++;
    } else {
      body.push(
        <Text key={`c${body.length}`}>
          {leftPad}{prefix}{visible}{pad}
        </Text>,
      );
      oldLine++;
      newLine++;
    }
  }

  // Cap the rendered diff body when a limit is given (write_file). edit_file
  // passes no maxLines and keeps full-diff rendering. The stats line is never
  // counted toward the cap.
  const shown =
    maxLines != null && body.length > maxLines ? body.slice(0, maxLines) : body;
  const more = body.length - shown.length;

  // No vertical margin: the enclosing MessageItem <Block> owns the gap.
  return (
    <Box flexDirection="column">
      {lines}
      {shown}
      {more > 0 && (
        <Text key="more" dimColor>
          {leftPad}… +{more} lines
        </Text>
      )}
    </Box>
  );
}

function ToolResultLines({
  content,
  toolName,
  cols,
  maxLines,
}: {
  content: string;
  toolName?: string;
  cols: number;
  maxLines?: number;
}) {
  if (toolName === "edit_file" && content.includes("```diff")) {
    return <DiffView content={content} cols={cols} />;
  }
  if (toolName === "write_file" && content.includes("```diff")) {
    return <DiffView content={content} cols={cols} maxLines={WRITE_DIFF_MAX_LINES} />;
  }
  return (
    <ToolResult
      content={content}
      cols={cols}
      tone={content.startsWith("Error:") ? "error" : "muted"}
      maxLines={maxLines}
    />
  );
}

/**
 * The lines shown indented under a `● Agent(…)` line: one `⎿` per intermediate
 * tool call the subagent made (formatted like the parent's own tool calls,
 * e.g. `Read(src/auth.ts)`), then a `done · N turns · M tool calls` footer.
 * Shared by the live transcript (<SubagentSteps>) and the full-scroll builder
 * so the two renderings never drift.
 */
function subagentStepLabels(
  run: SubagentRun,
  cols: number,
  maxSteps?: number,
): string[] {
  const stepLabels = run.steps.map((s) => {
    const head = s.summary
      ? `${toolDisplayName(s.name)}(${truncate(s.summary, argsMax(cols))})`
      : toolDisplayName(s.name);
    return s.result ? `${head} → ${s.result}` : head;
  });
  const shown =
    maxSteps !== undefined && stepLabels.length > maxSteps
      ? [
          ...stepLabels.slice(0, maxSteps),
          `… +${stepLabels.length - maxSteps} more tool calls`,
        ]
      : stepLabels;
  return [...shown, `done · ${run.turns} turns · ${run.toolCalls} tool calls`];
}

/** Live-transcript render of a subagent's steps: each on its own `⎿` line. */
function SubagentSteps({ run, cols }: { run: SubagentRun; cols: number }) {
  const max = Math.max(20, cols - 5);
  return (
    <Box flexDirection="column">
      {run.prompt && <ToolResult content={run.prompt} cols={cols} />}
      {subagentStepLabels(run, cols, SUBAGENT_STEP_PREVIEW).map((label, i) => (
        <Text key={i} dimColor>
          {MARKER}
          {truncate(label, max)}
        </Text>
      ))}
    </Box>
  );
}

export function padLines(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      const w = stringWidth(line);
      return w >= width ? line : line + " ".repeat(width - w);
    })
    .join("\n");
}

function indentLines(text: string, firstPrefix: string, restPrefix: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 ? firstPrefix : restPrefix) + l)
    .join("\n");
}

function completedLines(text: string): string {
  const lastNl = text.lastIndexOf("\n");
  return lastNl === -1 ? "" : text.slice(0, lastNl);
}

interface MessageItemProps {
  msg: Message;
  showThinking: boolean;
  cols: number;
  hiddenToolIds?: Set<string>;
  toolNames?: Map<string, string>;
  toolCalls?: Map<string, ToolCall>;
}

export function MessageItem({
  msg,
  showThinking,
  cols,
  hiddenToolIds,
  toolNames,
  toolCalls,
}: MessageItemProps) {
  // Injected session-state reminders (date rollover, language change) go to
  // the model and persist, but the user never typed them — never render.
  if (msg.meta) return null;
  if (
    msg.role === "user" &&
    msg.content?.startsWith("<previous-conversation-summary>")
  ) {
    const summaryText = msg.content
      .replace(/^<previous-conversation-summary>\n?/, "")
      .replace(/\n?<\/previous-conversation-summary>\s*$/, "")
      .trim();
    const bar = "─".repeat(Math.max(0, cols - 6));
    return (
      <Block>
        <Text dimColor>{"  " + bar}</Text>
        <Text dimColor bold>{"  ⎯ Context compacted · summary below ⎯"}</Text>
        <Text dimColor>{"  " + bar}</Text>
        <Text dimColor>{indentLines(summaryText, "     ", "     ")}</Text>
      </Block>
    );
  }
  const displayed = msg.content;
  const toolName =
    msg.role === "tool" && msg.tool_call_id
      ? toolNames?.get(msg.tool_call_id)
      : undefined;
  // Pair the originating tool call with its result so a turn's multiple tool
  // calls render as cmd→output→cmd→output instead of all cmds then all output.
  const originatingCall =
    msg.role === "tool" && msg.tool_call_id
      ? toolCalls?.get(msg.tool_call_id)
      : undefined;
  // Hidden tools (e.g. read_file) still show their command line, but their
  // result body is suppressed to keep the transcript from flooding.
  const resultHidden =
    msg.role === "tool" &&
    !!msg.tool_call_id &&
    !!hiddenToolIds?.has(msg.tool_call_id);
  const isToolError =
    msg.role === "tool" &&
    (!!msg.content?.startsWith("Error:") || msg.content === "Aborted by user.");
  // MessageItem is a grouping container, NOT a block: a single message can
  // contain several blocks (thinking / answer / tool group). Each piece owns
  // its own <Block>; the container has no spacing of its own. Wrapping the
  // whole thing in a <Block> would nest with the inner ones (e.g. a
  // thinking-only message = Block > Thinking-Block) and sum to a 2-line gap.
  return (
    <Box flexDirection="column">
      {msg.reasoning_content && (
        <Thinking
          content={msg.reasoning_content}
          expanded={showThinking}
          flush={!!msg.interrupted && !displayed}
        />
      )}
      {(displayed || msg.interrupted) &&
        msg.role !== "tool" &&
        msg.role !== "system" && (
          <Block>
            {msg.role === "user" ? (
              <>
                <Text backgroundColor="#3a3a3a">
                  {padLines(`${msg.bash ? "!" : ">"} ${displayed}`, cols)}
                </Text>
                {msg.bash && msg.bashOutput && (
                  <ToolResult
                    content={msg.bashOutput}
                    cols={cols}
                    tone={msg.bashOutput.startsWith("Error:") ? "error" : "muted"}
                    maxLines={Infinity}
                  />
                )}
              </>
            ) : (
              <>
                {displayed && (
                  <Markdown
                    content={displayed}
                    firstPrefix="● "
                    restPrefix="  "
                    cols={cols}
                  />
                )}
                {msg.interrupted && (
                  <ToolResult content="Interrupted by user" cols={cols} maxLines={Infinity} />
                )}
              </>
            )}
          </Block>
        )}
      {msg.role === "tool" && (
        <Block>
          {originatingCall && (
            <ToolCallLine
              call={originatingCall}
              cols={cols}
              running={false}
              done={!isToolError}
              error={isToolError}
              declined={
                toolName === "ask_user_question" &&
                parseDeclined(msg.content ?? "") !== null
              }
            />
          )}
          {msg.subagent && <SubagentSteps run={msg.subagent} cols={cols} />}
          {msg.content && !resultHidden &&
            (toolName === "ask_user_question" ? (
              <AnswerLines content={msg.content} cols={cols} />
            ) : (
              <ToolResultLines
                content={msg.content}
                toolName={toolName}
                cols={cols}
                maxLines={!toolName ? Infinity : undefined}
              />
            ))}
        </Block>
      )}
    </Box>
  );
}

interface StreamPreviewProps {
  thinking: string;
  response: string;
  isStreaming: boolean;
  showThinking: boolean;
  cols: number;
  /** Cap the live response to its last N rendered rows. Keeps the dynamic
   *  region under the viewport so Ink never wipes scrollback mid-stream
   *  (see Markdown's maxRows). The full text lands in <Static> at turn end. */
  maxResponseRows?: number;
}

export function StreamPreview({
  thinking,
  response,
  isStreaming,
  showThinking,
  cols,
  maxResponseRows,
}: StreamPreviewProps) {
  if (!isStreaming) return null;
  const visibleResponse = completedLines(response);
  return (
    <>
      {thinking && (
        <Thinking
          content={thinking}
          expanded={showThinking}
          active={!response}
        />
      )}
      {visibleResponse && (
        <Block>
          <Markdown
            content={visibleResponse}
            firstPrefix="● "
            restPrefix="  "
            cols={cols}
            maxRows={maxResponseRows}
          />
        </Block>
      )}
    </>
  );
}

function buildTranscriptLines(
  messages: Message[],
  cols: number,
  hiddenToolIds?: Set<string>,
  toolNames?: Map<string, string>,
  toolCalls?: Map<string, ToolCall>,
): ReactNode[] {
  const lines: ReactNode[] = [];
  let key = 0;
  const blank = () => {
    lines.push(<Text key={`b${key++}`}> </Text>);
  };
  for (const msg of messages) {
    if (msg.meta) continue; // injected reminders — never shown
    // Client-only error notice: red ● bullet + default-colored error text,
    // laid out like an assistant response. Continuation lines hang under the
    // text (2-space indent), matching Markdown's restPrefix.
    if (msg.error) {
      const errLines = (msg.content || "").split("\n");
      errLines.forEach((line, idx) => {
        lines.push(
          <Text key={`err${key++}`}>
            <Text color={theme.error}>{idx === 0 ? "● " : "  "}</Text>
            <Text>{line || " "}</Text>
          </Text>,
        );
      });
      blank();
      continue;
    }
    if (
      msg.role === "user" &&
      msg.content?.startsWith("<previous-conversation-summary>")
    ) {
      const summaryText = msg.content
        .replace(/^<previous-conversation-summary>\n?/, "")
        .replace(/\n?<\/previous-conversation-summary>\s*$/, "")
        .trim();
      const bar = "─".repeat(Math.max(0, cols - 4));
      lines.push(<Text key={`cs${key++}`} dimColor>{"  " + bar}</Text>);
      lines.push(
        <Text key={`cs${key++}`} dimColor bold>
          {"  ⎯ Context compacted · summary below ⎯"}
        </Text>,
      );
      lines.push(<Text key={`cs${key++}`} dimColor>{"  " + bar}</Text>);
      for (const l of summaryText.split("\n")) {
        lines.push(
          <Text key={`cs${key++}`} dimColor>
            {"     " + (l || "")}
          </Text>,
        );
      }
      blank();
      continue;
    }
    if (msg.reasoning_content) {
      lines.push(
        <Text key={`t${key++}`} color={theme.thinking} bold>
          ✓ thinking
        </Text>,
      );
      for (const l of msg.reasoning_content.split("\n")) {
        lines.push(
          <Text key={`tt${key++}`} dimColor>
            {l || " "}
          </Text>,
        );
      }
      // Interrupted-during-thinking (no content): keep the marker hugging
      // the thinking block instead of separated by a blank line.
      if (!(msg.interrupted && !msg.content)) blank();
    }
    if ((msg.content || msg.interrupted) && msg.role !== "tool") {
      if (msg.role === "user") {
        const splitLines = msg.content.split("\n");
        splitLines.forEach((line) => {
          const fullLine = `${msg.bash ? "!" : ">"} ${line}`;
          const pad = " ".repeat(Math.max(0, cols - stringWidth(fullLine)));
          lines.push(
            <Text key={`u${key++}`} backgroundColor="#3a3a3a">
              {fullLine + pad}
            </Text>,
          );
        });
        if (msg.bash && msg.bashOutput) {
          const ls = msg.bashOutput.replace(/\n+$/, "").split("\n");
          const isError = msg.bashOutput.startsWith("Error:");
          ls.forEach((line, i) => {
            lines.push(
              <Text key={`r${key++}`}>
                <Text dimColor>{i === 0 ? MARKER : MARKER_CONT}</Text>
                <Text color={isError ? theme.error : undefined} dimColor={!isError}>
                  {truncate(line, RESULT_LINE_MAX)}
                </Text>
              </Text>,
            );
          });
          blank();
        }
      } else {
        if (msg.content) {
          lines.push(
            <Markdown key={`md${key++}`} content={msg.content} firstPrefix="● " restPrefix="  " cols={cols} />
          );
        }
        if (msg.interrupted) {
          lines.push(
            <ToolResult key={`int${key++}`} content="Interrupted by user" cols={cols} maxLines={Infinity} />
          );
        }
      }
      blank();
    }
    if (msg.role === "tool" && msg.content) {
      const toolName =
        msg.tool_call_id ? toolNames?.get(msg.tool_call_id) : undefined;
      // Emit the originating tool call right before its result so a turn's
      // multiple tool calls render interleaved (cmd→output→cmd→output).
      const originatingCall =
        msg.tool_call_id ? toolCalls?.get(msg.tool_call_id) : undefined;
      if (originatingCall) {
        const displayName = toolDisplayName(originatingCall.function.name);
        let cArgs: Record<string, unknown> = {};
        try {
          cArgs = JSON.parse(originatingCall.function.arguments || "{}");
        } catch {
          // ignore
        }
        const summary = truncate(
          summarizeArgs(originatingCall.function.name, cArgs),
          argsMax(cols),
        );
        const isError = msg.content.startsWith("Error:") || msg.content === "Aborted by user.";
        if (originatingCall.function.name === "ask_user_question") {
          const declined = parseDeclined(msg.content) !== null;
          lines.push(
            <Text key={`c${key++}`}>
              <Text color={declined ? undefined : isError ? theme.error : theme.success}>● </Text>
              <Text bold>
                {declined ? "User declined to answer questions" : "用户已回答："}
              </Text>
            </Text>,
          );
        } else {
          lines.push(
            <Text key={`c${key++}`}>
              <Text color={isError ? theme.error : theme.success}>● </Text>
              <Text bold>{displayName}</Text>
              <Text>(</Text>
              <Text>{summary}</Text>
              <Text>)</Text>
            </Text>,
          );
        }
        if (msg.subagent) {
          const stepMax = Math.max(20, cols - 5);
          if (msg.subagent.prompt) {
            msg.subagent.prompt
              .replace(/\n+$/, "")
              .split("\n")
              .forEach((line, i) => {
                lines.push(
                  <Text key={`p${key++}`} dimColor>
                    {i === 0 ? MARKER : MARKER_CONT}
                    {truncate(line, stepMax)}
                  </Text>,
                );
              });
          }
          subagentStepLabels(msg.subagent, cols).forEach((label) => {
            lines.push(
              <Text key={`s${key++}`} dimColor>
                {MARKER}{truncate(label, stepMax)}
              </Text>,
            );
          });
        }
        blank();
      }
      // Hidden tools (e.g. read_file) show the command line above but their
      // result body is suppressed to keep the transcript readable.
      if (msg.tool_call_id && hiddenToolIds?.has(msg.tool_call_id)) {
        continue;
      }
      // ask_user_question: render answers as · Q → A (matches the live view).
      if (toolName === "ask_user_question") {
        const max = Math.max(20, cols - 5);
        const declined = parseDeclined(msg.content);
        if (declined) {
          declined.forEach((q, i) => {
            lines.push(
              <Text key={`r${key++}`} dimColor>
                {i === 0 ? MARKER : MARKER_CONT}
                {truncate(`· ${q}`, max)}
              </Text>,
            );
          });
        } else {
          const entries = parseAnswers(msg.content);
          if (entries.length === 0) {
            const ls = msg.content.replace(/\n+$/, "").split("\n");
            ls.forEach((line, i) => {
              lines.push(
                <Text key={`r${key++}`} dimColor>
                  {i === 0 ? MARKER : MARKER_CONT}
                  {truncate(line, RESULT_LINE_MAX)}
                </Text>,
              );
            });
          } else {
            entries.forEach(([qText, aText], i) => {
              lines.push(
                <Text key={`r${key++}`} dimColor>
                  {i === 0 ? MARKER : MARKER_CONT}
                  {truncate(`· ${qText} → ${aText}`, max)}
                </Text>,
              );
            });
          }
        }
        blank();
        continue;
      }
      // Transcript (full-scroll) view renders write_file's diff in full like
      // edit_file — the 20-line cap only applies to the space-constrained
      // inline DiffView, not the expanded scrollback.
      if (
        (toolName === "edit_file" || toolName === "write_file") &&
        msg.content.includes("```diff")
      ) {
        const parsed = parseDiff(msg.content);
        if (parsed) {
          const parts: string[] = [];
          if (parsed.added > 0) parts.push(`Added ${parsed.added} lines`);
          if (parsed.removed > 0) parts.push(`removed ${parsed.removed} lines`);
          lines.push(
            <Text key={`r${key++}`} dimColor>
              {MARKER}{parts.join(", ")}
            </Text>,
          );
          const targetWidth = Math.max(1, cols - 5);
          const leftPad = "    ";
          const nw = parsed.numWidth;
          let oldLine = 0;
          let newLine = 0;

          function clipped(s: string, maxCols: number): string {
            if (maxCols <= 0) return "";
            let out = "";
            let w = 0;
            for (const ch of s) {
              const cw = stringWidth(ch);
              if (w + cw > maxCols) break;
              out += ch;
              w += cw;
            }
            return out;
          }

          for (const line of parsed.diffLines) {
            if (line.startsWith("@@")) {
              const m = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
              if (m) {
                oldLine = parseInt(m[1]!);
                newLine = parseInt(m[2]!);
              }
              continue;
            }
            if (line.startsWith("+++") || line.startsWith("---")) {
              continue;
            }
            const num = (line.startsWith("+") ? String(newLine) : line.startsWith("-") ? String(oldLine) : String(newLine)).padStart(nw);
            const lpw = stringWidth(leftPad);
            const prefix = ` ${num} `;
            const maxContent = Math.max(0, targetWidth - lpw - stringWidth(prefix));
            const visible = clipped(line, maxContent);
            const bgWidth = lpw + stringWidth(prefix) + stringWidth(visible);
            const pad = bgWidth < targetWidth ? " ".repeat(targetWidth - bgWidth) : "";
            if (line.startsWith("+")) {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}
                  <Text backgroundColor="#1a3a1a">
                    <Text color={theme.success}>{prefix}</Text>{visible}{pad}
                  </Text>
                </Text>,
              );
              newLine++;
            } else if (line.startsWith("-")) {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}
                  <Text backgroundColor="#3a1a1a">
                    <Text color={theme.error}>{prefix}</Text>{visible}{pad}
                  </Text>
                </Text>,
              );
              oldLine++;
            } else {
              lines.push(
                <Text key={`t${key++}`}>
                  {leftPad}{prefix}{visible}{pad}
                </Text>,
              );
              oldLine++;
              newLine++;
            }
          }
          blank();
          continue;
        }
      }
      // Default rendering for other tools
      const isError = msg.content.startsWith("Error:");
      const ls = msg.content.replace(/\n+$/, "").split("\n");
      ls.forEach((line, i) => {
        lines.push(
          <Text key={`r${key++}`}>
            <Text dimColor>{i === 0 ? MARKER : MARKER_CONT}</Text>
            <Text color={isError ? theme.error : undefined} dimColor={!isError}>
              {truncate(line, RESULT_LINE_MAX)}
            </Text>
          </Text>,
        );
      });
      blank();
    }
  }
  return lines;
}

interface TranscriptViewProps {
  messages: Message[];
  cols: number;
  rows: number;
  hiddenToolIds?: Set<string>;
  toolNames?: Map<string, string>;
  toolCalls?: Map<string, ToolCall>;
}

export function TranscriptView({ messages, cols, rows, hiddenToolIds, toolNames, toolCalls }: TranscriptViewProps) {
  const allLines = buildTranscriptLines(messages, cols, hiddenToolIds, toolNames, toolCalls);
  const HEADER_ROWS = 1;
  const viewportRows = Math.max(1, rows - HEADER_ROWS);
  const maxOffset = Math.max(0, allLines.length - viewportRows);
  const [offset, setOffset] = useState(maxOffset);
  const clamped = Math.min(Math.max(0, offset), maxOffset);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setOffset((o) => Math.max(0, Math.min(o, maxOffset) - 1));
    } else if (key.downArrow || input === "j") {
      setOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.pageUp) {
      setOffset((o) => Math.max(0, Math.min(o, maxOffset) - viewportRows));
    } else if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + viewportRows));
    } else if (input === "g") {
      setOffset(0);
    } else if (input === "G") {
      setOffset(maxOffset);
    }
  });

  const visible = allLines.slice(clamped, clamped + viewportRows);
  const startLine = allLines.length === 0 ? 0 : clamped + 1;
  const endLine = Math.min(clamped + viewportRows, allLines.length);

  return (
    <Box flexDirection="column" height={rows} flexShrink={0} width={cols}>
      <Box paddingX={2}>
        <Text bold color={theme.accent}>Transcript</Text>
        <Text dimColor>
          {"  · "}
          {startLine}-{endLine} / {allLines.length}
          {"  · ↑↓/PgUp/PgDn/g/G  · esc to close"}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visible}
      </Box>
    </Box>
  );
}
