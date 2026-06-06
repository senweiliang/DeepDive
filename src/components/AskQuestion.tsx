import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

// Interactive multiple-choice prompt — DeepDive's port of Claude Code's
// AskUserQuestion tool. The model asks 1-4 questions (single- or multi-select);
// a free-form "Other" row is appended to every question automatically, so the
// model must never include its own "Other" option. The Other row doubles as an
// inline text field: move the cursor onto it and just type.
//
// A navigation bar across the top shows every question as a tab plus a trailing
// Submit tab — ←/→ switch tabs, ↑/↓ move within a question's options. Answered
// tabs turn green with a ☑; the focused tab is filled (blue background).

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

const OTHER_PLACEHOLDER = "输入文字";
const BOX_OFF = "☐";
const BOX_ON = "■";
const TICK = "✔";

/**
 * Parse and validate the raw `questions` arg the model produced into safe
 * items. Anything malformed (missing question text, fewer than 2 options) is
 * dropped rather than thrown — the caller treats an empty result as an error
 * tool-response so the model can retry.
 */
export function normalizeQuestions(raw: unknown): AskQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestionItem[] = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question.trim() : "";
    if (!question) continue;

    const rawOpts = Array.isArray(obj.options) ? obj.options : [];
    const options: AskOption[] = [];
    for (const o of rawOpts.slice(0, 4)) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      const label = typeof oo.label === "string" ? oo.label.trim() : "";
      if (!label) continue;
      const description =
        typeof oo.description === "string" ? oo.description : "";
      options.push({ label, description });
    }
    if (options.length < 2) continue;

    const header = typeof obj.header === "string" ? obj.header.slice(0, 12) : "";
    const multiSelect = obj.multiSelect === true;
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

const truncate = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";

/** Top navigation: one tab per question + a trailing Submit tab, framed by ←/→. */
function NavBar({
  questions,
  qIndex,
  answers,
  submitIndex,
}: {
  questions: AskQuestionItem[];
  qIndex: number;
  answers: Record<string, string>;
  submitIndex: number;
}) {
  return (
    <Box flexDirection="row">
      <Text dimColor={qIndex === 0}>← </Text>
      {questions.map((qq, i) => {
        const selected = i === qIndex;
        const answered = !!answers[qq.question];
        const box = answered ? BOX_ON : BOX_OFF;
        const label = qq.header || `Q${i + 1}`;
        if (selected) {
          return (
            <Text key={i} backgroundColor={theme.accent} color="black">
              {` ${box} ${label} `}
            </Text>
          );
        }
        return <Text key={i}>{` ${box} ${label} `}</Text>;
      })}
      {qIndex === submitIndex ? (
        <Text backgroundColor={theme.accent} color="black">
          {` ${TICK} Submit `}
        </Text>
      ) : (
        <Text>{` ${TICK} Submit `}</Text>
      )}
      <Text dimColor={qIndex === submitIndex}> →</Text>
    </Box>
  );
}

/** Submit tab body: a review of every question + answer, or a "go back" hint. */
function SubmitView({
  questions,
  answers,
  cols,
}: {
  questions: AskQuestionItem[];
  answers: Record<string, string>;
  cols: number;
}) {
  const max = Math.max(20, cols - 6);
  const missing = questions.filter((qq) => !answers[qq.question]).length;
  return (
    <Box flexDirection="column">
      {missing > 0 ? (
        <Text color={theme.approval}>还没回答所有问题</Text>
      ) : (
        <Text bold>所有问题已回答，按 Enter 提交：</Text>
      )}
      <Box flexDirection="column">
        {questions.map((qq, i) => {
          const a = answers[qq.question];
          return (
            <Box key={i} flexDirection="column">
              <Text dimColor>{truncate(`· ${qq.question}`, max)}</Text>
              <Text dimColor>
                {`    → ${truncate(a || "（未回答）", Math.max(10, max - 6))}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

interface Props {
  questions: AskQuestionItem[];
  /** Resolve with { questionText: answerText }; multi-select answers join with ", ". */
  onSubmit: (answers: Record<string, string>) => void;
}

export function AskQuestion({ questions, onSubmit }: Props) {
  const cols = process.stdout.columns || 80;
  const multi = questions.length > 1; // single question: no nav bar / Submit tab
  const submitIndex = questions.length; // nav index of the Submit tab
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState("");

  const onSubmitTab = qIndex === submitIndex;
  const q = onSubmitTab ? undefined : questions[qIndex]!;
  const otherRow = q ? q.options.length : 0;
  const rowCount = q ? q.options.length + 1 : 0;
  const onOther = !!q && cursor === otherRow;

  // Move to another tab, restoring that question's previously-recorded answer
  // into the editing state so revisiting it shows (and keeps) the prior choice.
  const goTo = (idx: number, current: Record<string, string>) => {
    const clamped = Math.max(0, Math.min(submitIndex, idx));
    setQIndex(clamped);
    const target = questions[clamped];
    const ans = target ? current[target.question] : undefined;
    if (!target || !ans) {
      setCursor(0);
      setChecked(new Set());
      setOtherText("");
      return;
    }
    if (target.multiSelect) {
      const labels = ans.split(", ");
      const set = new Set<number>();
      target.options.forEach((o, i) => {
        if (labels.includes(o.label)) set.add(i);
      });
      const others = labels.filter(
        (l) => !target.options.some((o) => o.label === l),
      );
      setChecked(set);
      setOtherText(others.join(", "));
      setCursor(0);
    } else {
      const i = target.options.findIndex((o) => o.label === ans);
      setChecked(new Set());
      // A single-select answer that matches no option was free-form "Other".
      setCursor(i >= 0 ? i : target.options.length);
      setOtherText(i >= 0 ? "" : ans);
    }
  };

  const recordAndAdvance = (answer: string) => {
    const next = { ...answers, [q!.question]: answer };
    setAnswers(next);
    // Single question: no Submit tab — selecting an option submits immediately.
    if (!multi) {
      onSubmit(next);
      return;
    }
    goTo(qIndex + 1, next);
  };

  useInput((input, key) => {
    if (key.escape) return; // App owns Esc (abort the turn)

    if (key.leftArrow) {
      if (multi) goTo(qIndex - 1, answers);
      return;
    }
    if (key.rightArrow) {
      if (multi) goTo(qIndex + 1, answers);
      return;
    }

    // Submit tab: Enter submits when complete, else jumps to first unanswered.
    if (onSubmitTab) {
      // Don't allow empty answers — if any question is unanswered, jump to the
      // first one instead of submitting.
      if (key.return) {
        const missing = questions.findIndex((qq) => !answers[qq.question]);
        if (missing === -1) onSubmit(answers);
        else goTo(missing, answers);
      }
      return;
    }

    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(rowCount - 1, c + 1));
      return;
    }
    if (key.return) {
      const other = otherText.trim();
      if (q!.multiSelect) {
        const labels = q!.options
          .filter((_, i) => checked.has(i))
          .map((o) => o.label);
        if (other) labels.push(other);
        if (labels.length === 0) return; // need at least one selection
        recordAndAdvance(labels.join(", "));
      } else if (onOther) {
        if (!other) return; // require non-empty custom text
        recordAndAdvance(other);
      } else {
        recordAndAdvance(q!.options[cursor]!.label);
      }
      return;
    }
    // The Other row is a live text field whenever the cursor sits on it.
    if (onOther) {
      if (key.backspace || key.delete) {
        setOtherText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setOtherText((t) => t + input);
      }
      return;
    }
    // Non-Other rows: Space toggles a checkbox in multi-select mode.
    if (q!.multiSelect && input === " ") {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
    }
  });

  const descIndent = (headLen: number) => " ".repeat(headLen);
  const headOf = (rowIndex: number) => {
    const caret = rowIndex === cursor ? "> " : "  ";
    return `${caret}${rowIndex + 1}. `;
  };

  const nav = multi ? " · ←→ 切换问题" : "";
  const hint = onSubmitTab
    ? `Enter 提交${nav} · Esc 中断`
    : onOther
      ? `输入文字 · Enter 确认${nav} · Esc 中断`
      : q!.multiSelect
        ? `↑↓ 移动 · Space 勾选 · Enter 确认${nav} · Esc 中断`
        : `↑↓ 选择 · Enter 确认${nav} · Esc 中断`;

  return (
    <Block>
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Box flexDirection="column" paddingX={1} gap={1}>
        {multi && (
          <NavBar
            questions={questions}
            qIndex={qIndex}
            answers={answers}
            submitIndex={submitIndex}
          />
        )}

        {q ? (
          <Box flexDirection="column" gap={1}>
            <Text bold>{q.question}</Text>
            <Box flexDirection="column">
              {q.options.map((opt, i) => {
                const active = i === cursor;
                const head = headOf(i);
                const ticked = q.multiSelect
                  ? checked.has(i)
                  : answers[q.question] === opt.label;
                return (
                  <Box key={i} flexDirection="column">
                    <Text>
                      <Text dimColor>{head}</Text>
                      <Text
                        color={
                          ticked
                            ? theme.success
                            : active
                              ? theme.accent
                              : undefined
                        }
                      >
                        {opt.label}
                      </Text>
                      {ticked ? <Text color={theme.success}> {TICK}</Text> : null}
                    </Text>
                    {opt.description ? (
                      <Text dimColor>
                        {descIndent(head.length)}
                        {truncate(
                          opt.description,
                          Math.max(10, cols - head.length - 2),
                        )}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}

              {/* Auto-appended free-form "Other" row — an inline text field. */}
              {(() => {
                const head = headOf(otherRow);
                const ticked = !onOther && otherText.trim().length > 0;
                return (
                  <Text>
                    <Text dimColor>{head}</Text>
                    {otherText ? (
                      <>
                        <Text color={ticked ? theme.success : undefined}>
                          {otherText}
                        </Text>
                        {onOther ? (
                          <Text backgroundColor="white" color="black"> </Text>
                        ) : null}
                      </>
                    ) : onOther ? (
                      <>
                        <Text backgroundColor="white" color="black">
                          {OTHER_PLACEHOLDER.slice(0, 1)}
                        </Text>
                        <Text dimColor>{OTHER_PLACEHOLDER.slice(1)}</Text>
                      </>
                    ) : (
                      <Text dimColor>{OTHER_PLACEHOLDER}</Text>
                    )}
                    {ticked ? <Text color={theme.success}> {TICK}</Text> : null}
                  </Text>
                );
              })()}
            </Box>
          </Box>
        ) : (
          <SubmitView questions={questions} answers={answers} cols={cols} />
        )}

        <Text dimColor>{hint}</Text>
      </Box>
    </Block>
  );
}
