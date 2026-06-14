/**
 * In-process store for BACKGROUND tasks — subagents and shell commands the
 * model launched with `run_in_background`. This is the DeepDive analogue of
 * Claude Code's `AppState.tasks` (a `Record<taskId, TaskState>`), kept
 * deliberately small: a single module-level map plus a `useSyncExternalStore`
 * subscription so the App can render a footer indicator and deliver completion
 * notifications, while the detached runners (agents/run.ts loop, executeBash)
 * mutate task state from outside React.
 *
 * Design (ported from the load-bearing core of Claude Code's task framework):
 *  - detached spawn: the tool's handler registers a task, fires the work
 *    fire-and-forget, and returns IMMEDIATELY with the task id;
 *  - the runner streams progress into `output` and, on finish, sets a terminal
 *    status + `result`;
 *  - the App watches the snapshot, and for every terminal-but-unnotified task
 *    injects ONE `<task-notification>` into the conversation (the `notified`
 *    flag dedups), then continues the turn so the model reads the result.
 *
 * What we deliberately DON'T port: disk output files, worktree isolation,
 * remote agents, auto-backgrounding heuristics, and the separate persistent
 * team-todo store. Output is buffered in memory (capped); a task that is still
 * running when the process exits is aborted, not resumed.
 */

export type BgTaskKind = "agent" | "bash";

export type BgTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BgTask {
  /** Stable handle the model uses with task_output / task_stop. */
  id: string;
  kind: BgTaskKind;
  status: BgTaskStatus;
  /** Short label: a subagent's description, or the shell command. */
  description: string;
  /** Agent tasks: the resolved subagent_type. */
  agentType?: string;
  /** Bash tasks: the full command. */
  command?: string;
  startedAt: number;
  endedAt?: number;
  /** Buffered live output (bash stdout, or a subagent's step/progress trail),
   *  capped at MAX_OUTPUT_CHARS so a runaway task can't grow without bound. */
  output: string;
  /** How many chars of `output` have already been handed to the model via
   *  task_output, so each poll returns only the NEW output (a delta read,
   *  mirroring Claude Code's outputOffset) instead of the whole growing buffer. */
  readOffset: number;
  /** Final report (subagent) / final stdout (bash). Set on terminal status. */
  result?: string;
  isError?: boolean;
  /** Subagent accounting, surfaced in task_output. */
  turns?: number;
  toolCalls?: number;
  /** Set true once the App has injected this task's completion notification,
   *  so the watcher never delivers it twice. */
  notified: boolean;
  /** Kill handle — aborts the detached runner / shell. */
  abort: () => void;
}

/** Soft cap on concurrently-running background tasks. Matches Claude Code's
 *  "encourage parallelism but don't fork-bomb" stance; the model is told to
 *  wait for some to finish rather than launching unboundedly. */
export const MAX_BACKGROUND_TASKS = 10;

const MAX_OUTPUT_CHARS = 30_000;

const tasks = new Map<string, BgTask>();
const listeners = new Set<() => void>();
let idCounter = 0;
let snapshot: BgTask[] = [];

function emit(): void {
  // Rebuild a fresh array so useSyncExternalStore sees a new reference; the
  // task objects themselves are shared (read-only for consumers).
  snapshot = Array.from(tasks.values());
  for (const l of listeners) l();
}

export function isTerminalBgStatus(status: BgTaskStatus): boolean {
  return status !== "running";
}

/** Generate a per-kind id: `a…` for agents, `b…` for bash (mirrors Claude
 *  Code's per-type id prefixes), unique within the process. */
export function generateBgTaskId(kind: BgTaskKind): string {
  const prefix = kind === "agent" ? "a" : "b";
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}${idCounter.toString(36)}${rand}`;
}

export function runningBgCount(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.status === "running") n += 1;
  return n;
}

/** Whether another background task may be launched right now. */
export function canLaunchBgTask(): boolean {
  return runningBgCount() < MAX_BACKGROUND_TASKS;
}

export interface RegisterBgTaskInit {
  id: string;
  kind: BgTaskKind;
  description: string;
  agentType?: string;
  command?: string;
  abort: () => void;
}

export function registerBgTask(init: RegisterBgTaskInit): BgTask {
  const task: BgTask = {
    id: init.id,
    kind: init.kind,
    status: "running",
    description: init.description,
    agentType: init.agentType,
    command: init.command,
    startedAt: Date.now(),
    output: "",
    readOffset: 0,
    notified: false,
    abort: init.abort,
  };
  tasks.set(task.id, task);
  emit();
  return task;
}

/** Append a chunk of live output, capped. No-op for unknown/terminal tasks. */
export function appendBgOutput(id: string, text: string): void {
  const task = tasks.get(id);
  if (!task) return;
  if (task.output.length >= MAX_OUTPUT_CHARS) return;
  task.output += text;
  if (task.output.length > MAX_OUTPUT_CHARS) {
    task.output = task.output.slice(0, MAX_OUTPUT_CHARS) + "\n… [output truncated]";
  }
  emit();
}

export interface BgTaskResult {
  status: Exclude<BgTaskStatus, "running">;
  result: string;
  isError?: boolean;
  turns?: number;
  toolCalls?: number;
}

/** Mark a task terminal with its final result. Idempotent on an already-terminal
 *  task (the first terminal transition wins). */
export function finishBgTask(id: string, res: BgTaskResult): void {
  const task = tasks.get(id);
  if (!task || isTerminalBgStatus(task.status)) return;
  task.status = res.status;
  task.result = res.result;
  task.isError = res.isError;
  task.turns = res.turns;
  task.toolCalls = res.toolCalls;
  task.endedAt = Date.now();
  emit();
}

/** Mark a task as notified so the App watcher delivers its completion once. */
export function markBgNotified(id: string): void {
  const task = tasks.get(id);
  if (!task || task.notified) return;
  task.notified = true;
  emit();
}

export function getBgTask(id: string): BgTask | undefined {
  return tasks.get(id);
}

/** Return the output buffered SINCE the last call (a delta) and advance the
 *  read cursor, so repeated task_output polls don't re-dump the whole buffer.
 *  No emit — the read cursor has no UI effect. */
export function readBgOutputDelta(id: string): string {
  const task = tasks.get(id);
  if (!task) return "";
  const delta = task.output.slice(task.readOffset);
  task.readOffset = task.output.length;
  return delta;
}

/** Abort all still-running tasks — used on process exit / unmount cleanup. */
export function abortAllBgTasks(): void {
  for (const t of tasks.values()) {
    if (t.status === "running") {
      try {
        t.abort();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ── useSyncExternalStore wiring ────────────────────────────────────────────

export function subscribeBgTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBgTasksSnapshot(): BgTask[] {
  return snapshot;
}
