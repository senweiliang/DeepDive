import type { Message } from "../types.js";
import type { BgTask } from "./store.js";

/** Marker so the notification can be recognised (kept hidden from transcript). */
export const TASK_NOTIFICATION_MARKER = "<task-notification>";

const MAX_RESULT_CHARS = 6_000;

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n… [truncated — call task_output to read the rest]`
  );
}

/**
 * Build the hidden `<task-notification>` reminder injected when a background
 * task finishes. Faithful to Claude Code's notification payload: task-id (to
 * correlate), kind, status, and the result inline so the model usually doesn't
 * need a second read. It's a `meta` user message — sent to the model, hidden
 * from the transcript, persisted like any other history entry.
 */
export function makeBgTaskNotification(task: BgTask): Message {
  const kindLabel = task.kind === "agent" ? "subagent" : "shell command";
  const result = truncateResult(task.result ?? task.output ?? "");
  const accounting =
    task.kind === "agent" && task.turns !== undefined
      ? `<usage>${task.turns} turns, ${task.toolCalls ?? 0} tool calls</usage>\n`
      : "";
  return {
    role: "user",
    meta: true,
    content:
      `<system-reminder>\n${TASK_NOTIFICATION_MARKER}\n` +
      `<task-id>${task.id}</task-id>\n` +
      `<kind>${task.kind}</kind>\n` +
      `<status>${task.status}</status>\n` +
      `<description>${task.description}</description>\n` +
      accounting +
      `<result>\n${result}\n</result>\n` +
      `</task-notification>\n` +
      `The background ${kindLabel} you launched (task ${task.id}) has ` +
      `${task.status}. Its result is above. Act on it now if it unblocks the ` +
      `user's request; otherwise acknowledge it briefly. Use ` +
      `task_output("${task.id}") to re-read the full output.\n` +
      `</system-reminder>`,
  };
}
