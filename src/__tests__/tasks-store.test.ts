import { describe, it, expect } from "vitest";
import {
  registerBgTask,
  appendBgOutput,
  finishBgTask,
  markBgNotified,
  getBgTask,
  getBgTasksSnapshot,
  runningBgCount,
  generateBgTaskId,
  isTerminalBgStatus,
  abortAllBgTasks,
} from "../tasks/store.js";

describe("background task store", () => {
  it("generateBgTaskId uses a per-kind prefix and is unique", () => {
    const a1 = generateBgTaskId("agent");
    const a2 = generateBgTaskId("agent");
    const b1 = generateBgTaskId("bash");
    expect(a1.startsWith("a")).toBe(true);
    expect(b1.startsWith("b")).toBe(true);
    expect(a1).not.toBe(a2);
  });

  it("isTerminalBgStatus only treats non-running as terminal", () => {
    expect(isTerminalBgStatus("running")).toBe(false);
    expect(isTerminalBgStatus("completed")).toBe(true);
    expect(isTerminalBgStatus("failed")).toBe(true);
    expect(isTerminalBgStatus("killed")).toBe(true);
  });

  it("registers a task as running and exposes it in the snapshot", () => {
    const id = generateBgTaskId("bash");
    const before = runningBgCount();
    registerBgTask({
      id,
      kind: "bash",
      description: "echo hi",
      command: "echo hi",
      abort: () => {},
    });
    const task = getBgTask(id);
    expect(task?.status).toBe("running");
    expect(task?.notified).toBe(false);
    expect(runningBgCount()).toBe(before + 1);
    expect(getBgTasksSnapshot().some((t) => t.id === id)).toBe(true);
    // cleanup so the global running count doesn't leak into other tests
    finishBgTask(id, { status: "completed", result: "hi" });
  });

  it("buffers output and finalises with a terminal result", () => {
    const id = generateBgTaskId("agent");
    registerBgTask({
      id,
      kind: "agent",
      description: "research",
      agentType: "general-purpose",
      abort: () => {},
    });
    appendBgOutput(id, "step one\n");
    appendBgOutput(id, "step two\n");
    expect(getBgTask(id)?.output).toBe("step one\nstep two\n");

    finishBgTask(id, {
      status: "completed",
      result: "done",
      turns: 3,
      toolCalls: 5,
    });
    const task = getBgTask(id);
    expect(task?.status).toBe("completed");
    expect(task?.result).toBe("done");
    expect(task?.turns).toBe(3);
    expect(task?.endedAt).toBeGreaterThan(0);

    // first terminal transition wins — a second finish is a no-op
    finishBgTask(id, { status: "failed", result: "nope" });
    expect(getBgTask(id)?.status).toBe("completed");
    expect(getBgTask(id)?.result).toBe("done");
  });

  it("markBgNotified flips the dedup flag once", () => {
    const id = generateBgTaskId("bash");
    registerBgTask({
      id,
      kind: "bash",
      description: "ls",
      command: "ls",
      abort: () => {},
    });
    finishBgTask(id, { status: "completed", result: "" });
    expect(getBgTask(id)?.notified).toBe(false);
    markBgNotified(id);
    expect(getBgTask(id)?.notified).toBe(true);
  });

  it("abortAllBgTasks calls abort only on still-running tasks", () => {
    let runningAborted = false;
    let doneAborted = false;
    const runId = generateBgTaskId("bash");
    const doneId = generateBgTaskId("bash");
    registerBgTask({
      id: runId,
      kind: "bash",
      description: "sleep",
      command: "sleep 100",
      abort: () => {
        runningAborted = true;
      },
    });
    registerBgTask({
      id: doneId,
      kind: "bash",
      description: "true",
      command: "true",
      abort: () => {
        doneAborted = true;
      },
    });
    finishBgTask(doneId, { status: "completed", result: "" });

    abortAllBgTasks();
    expect(runningAborted).toBe(true);
    expect(doneAborted).toBe(false);
    // leave no running task behind
    finishBgTask(runId, { status: "killed", result: "" });
  });
});
