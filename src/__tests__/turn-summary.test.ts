import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  applyTurnSummaries,
  buildTurnSummaryRequest,
  makeTurnSummaryMessage,
  previousTurnMessages,
  previousTurnSummaryBlocks,
  shouldSummarizePreviousTurn,
} from "../turn-summary.js";

const toolCall = (id: string, name = "read_file") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

describe("turn summary", () => {
  it("builds summary requests as a single JSON-text user message", () => {
    const request = buildTurnSummaryRequest([
      { role: "user", content: "show sample 500" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect the file.",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ]);

    expect(request).toHaveLength(1);
    expect(request[0]).toMatchObject({ role: "user" });
    expect(request[0]!.tool_calls).toBeUndefined();
    expect(request[0]!.content).toContain('"reasoning_content": "I should inspect the file."');
    expect(request[0]!.content).toContain('"tool_calls"');
    expect(request[0]!.content).toContain('"tool_call_id": "call_1"');
    expect(request[0]!.content).toContain('"content": "file content"');
    expect(request[0]!.content).not.toContain('"content": ""');
    expect(request[0]!.content).not.toContain('"usage"');
    expect(request[0]!.content).not.toContain('"bashOutput"');
  });

  it("is disabled by default strategy", () => {
    const history: Message[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect the file.",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ];

    expect(shouldSummarizePreviousTurn(history, "off")).toBe(false);
    expect(applyTurnSummaries(history, "off")).toEqual(history);
    expect(
      applyTurnSummaries(
        [...history, makeTurnSummaryMessage("old summary", "tool_only")],
        "off",
      ),
    ).toEqual(history);
  });

  it("requires at least two pure tool blocks for tool_only", () => {
    const history: Message[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect the file.",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      { role: "assistant", content: "Found it." },
    ];

    expect(shouldSummarizePreviousTurn(history, "whole_turn")).toBe(true);
    expect(previousTurnSummaryBlocks(history, "whole_turn")).toHaveLength(1);
    expect(shouldSummarizePreviousTurn(history, "tool_only")).toBe(false);
    expect(previousTurnSummaryBlocks(history, "tool_only")).toEqual([]);
  });

  it("groups consecutive pure tool blocks into one tool_only summary run", () => {
    const history: Message[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect the file.",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should run typecheck.",
        tool_calls: [toolCall("call_2", "bash")],
      },
      { role: "tool", tool_call_id: "call_2", content: "ok" },
    ];

    expect(shouldSummarizePreviousTurn(history, "tool_only")).toBe(true);
    expect(previousTurnSummaryBlocks(history, "tool_only")).toEqual([
      {
        strategy: "tool_only",
        messages: [
          {
            role: "assistant",
            content: "",
            reasoning_content: "I should inspect the file.",
            tool_calls: [toolCall("call_1")],
          },
          { role: "tool", tool_call_id: "call_1", content: "file content" },
          {
            role: "assistant",
            content: "",
            reasoning_content: "I should run typecheck.",
            tool_calls: [toolCall("call_2", "bash")],
          },
          { role: "tool", tool_call_id: "call_2", content: "ok" },
        ],
      },
    ]);
  });

  it("returns only non-meta messages from the previous user turn", () => {
    const history: Message[] = [
      { role: "user", content: "older" },
      { role: "assistant", content: "done" },
      { role: "user", content: "fix it" },
      { role: "user", meta: true, content: "<system-reminder>date</system-reminder>" },
      {
        role: "assistant",
        content: "",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ];

    expect(previousTurnMessages(history)).toEqual([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ]);
  });

  it("whole_turn keeps user messages and replaces assistant/tool history", () => {
    const summary = makeTurnSummaryMessage(
      "Found a Static rendering bug.",
      "whole_turn",
    );
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "raw reasoning",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      { role: "assistant", content: "Found it." },
      summary,
      { role: "user", content: "好的" },
    ];

    expect(applyTurnSummaries(messages, "whole_turn")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "fix it" },
      summary,
      { role: "user", content: "好的" },
    ]);
  });

  it("tool_only keeps a single pure tool block even if an old summary exists", () => {
    const summary = makeTurnSummaryMessage("Read file and found the bug.", "tool_only");
    const finalAnswer: Message = { role: "assistant", content: "Found it." };
    const messages: Message[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "raw reasoning",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      finalAnswer,
      summary,
      { role: "user", content: "好的" },
    ];

    expect(applyTurnSummaries(messages, "tool_only")).toEqual([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "raw reasoning",
        tool_calls: [toolCall("call_1")],
      },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      finalAnswer,
      { role: "user", content: "好的" },
    ]);
  });

  it("tool_only keeps assistant content with tool calls and its tool results", () => {
    const summary = makeTurnSummaryMessage("No block should be replaced.", "tool_only");
    const visibleToolAssistant: Message = {
      role: "assistant",
      content: "确实有乱码。加个 UTF-8 BOM 就能解决：",
      reasoning_content: "raw reasoning that must stay with tool_calls",
      tool_calls: [toolCall("call_1", "bash")],
    };
    const toolResult: Message = {
      role: "tool",
      tool_call_id: "call_1",
      content: "done",
    };
    const messages: Message[] = [
      { role: "user", content: "怎么有乱码呢" },
      visibleToolAssistant,
      toolResult,
      { role: "assistant", content: "已修复。" },
      summary,
      { role: "user", content: "好的" },
    ];

    expect(previousTurnSummaryBlocks(messages.slice(0, -2), "tool_only")).toEqual([]);
    expect(applyTurnSummaries(messages, "tool_only")).toEqual([
      { role: "user", content: "怎么有乱码呢" },
      visibleToolAssistant,
      toolResult,
      { role: "assistant", content: "已修复。" },
      { role: "user", content: "好的" },
    ]);
  });

  it("tool_only replaces one consecutive run with one summary", () => {
    const summary = makeTurnSummaryMessage("Read file and ran typecheck.", "tool_only");
    const messages: Message[] = [
      { role: "user", content: "fix it" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_1")] },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_2", "bash")] },
      { role: "tool", tool_call_id: "call_2", content: "typecheck ok" },
      summary,
      { role: "user", content: "继续" },
    ];

    expect(applyTurnSummaries(messages, "tool_only")).toEqual([
      { role: "user", content: "fix it" },
      summary,
      { role: "user", content: "继续" },
    ]);
  });

  it("tool_only starts a new run after visible assistant content", () => {
    const summary1 = makeTurnSummaryMessage("First search run.", "tool_only");
    const summary2 = makeTurnSummaryMessage("Second verification run.", "tool_only");
    const middle: Message = { role: "assistant", content: "Need one more check." };
    const messages: Message[] = [
      { role: "user", content: "fix it" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_1")] },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_2", "grep")] },
      { role: "tool", tool_call_id: "call_2", content: "grep result" },
      middle,
      { role: "assistant", content: "", tool_calls: [toolCall("call_3", "bash")] },
      { role: "tool", tool_call_id: "call_3", content: "typecheck ok" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_4", "read_file")] },
      { role: "tool", tool_call_id: "call_4", content: "file content" },
      summary1,
      summary2,
      { role: "user", content: "继续" },
    ];

    expect(applyTurnSummaries(messages, "tool_only")).toEqual([
      { role: "user", content: "fix it" },
      summary1,
      middle,
      summary2,
      { role: "user", content: "继续" },
    ]);
  });
});
