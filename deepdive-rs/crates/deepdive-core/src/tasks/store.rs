//! In-process store for BACKGROUND tasks (subagents / shell commands launched
//! with `run_in_background`). Port of `src/tasks/store.ts`.
//!
//! Modeled as an instance (`Arc<TaskStore>` per the plan) rather than the TS
//! module-global, so it composes cleanly and tests don't share state. The data
//! (`BgTask`) is kept separate from the abort handle so snapshots clone freely;
//! the abort handle is an `Arc<dyn Fn>` (the engine wires it to a
//! `CancellationToken`; tests use a flag).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

pub const MAX_BACKGROUND_TASKS: usize = 10;
const MAX_OUTPUT_CHARS: usize = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BgTaskKind {
    Agent,
    Bash,
}

impl BgTaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BgTaskKind::Agent => "agent",
            BgTaskKind::Bash => "bash",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BgTaskStatus {
    Running,
    Completed,
    Failed,
    Killed,
}

impl BgTaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            BgTaskStatus::Running => "running",
            BgTaskStatus::Completed => "completed",
            BgTaskStatus::Failed => "failed",
            BgTaskStatus::Killed => "killed",
        }
    }
}

pub fn is_terminal_bg_status(status: BgTaskStatus) -> bool {
    status != BgTaskStatus::Running
}

#[derive(Debug, Clone)]
pub struct BgTask {
    pub id: String,
    pub kind: BgTaskKind,
    pub status: BgTaskStatus,
    pub description: String,
    pub agent_type: Option<String>,
    pub command: Option<String>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub output: String,
    pub read_offset: usize,
    pub result: Option<String>,
    pub is_error: bool,
    pub turns: Option<u32>,
    pub tool_calls: Option<u32>,
    pub notified: bool,
}

pub type AbortFn = Arc<dyn Fn() + Send + Sync>;

pub struct RegisterBgTaskInit {
    pub id: String,
    pub kind: BgTaskKind,
    pub description: String,
    pub agent_type: Option<String>,
    pub command: Option<String>,
    pub abort: AbortFn,
}

pub struct BgTaskResult {
    pub status: BgTaskStatus,
    pub result: String,
    pub is_error: bool,
    pub turns: Option<u32>,
    pub tool_calls: Option<u32>,
}

#[derive(Default)]
struct Inner {
    tasks: HashMap<String, BgTask>,
    order: Vec<String>,
    aborts: HashMap<String, AbortFn>,
    id_counter: u64,
}

#[derive(Default)]
pub struct TaskStore {
    inner: Mutex<Inner>,
    /// Fired (one permit) whenever a task reaches a terminal status, so the
    /// engine task can auto-resume the conversation with the result. `notify_one`
    /// stores a permit if nobody is waiting, so a completion is never missed.
    completion: Arc<Notify>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap()
}

impl TaskStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Per-kind id prefix (`a…`/`b…`), unique within this store.
    pub fn generate_id(&self, kind: BgTaskKind) -> String {
        let counter = {
            let mut g = self.inner.lock().unwrap();
            g.id_counter += 1;
            g.id_counter
        };
        let prefix = match kind {
            BgTaskKind::Agent => 'a',
            BgTaskKind::Bash => 'b',
        };
        let rand: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(4)
            .collect();
        format!("{prefix}{}{rand}", to_base36(counter))
    }

    pub fn running_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap()
            .tasks
            .values()
            .filter(|t| t.status == BgTaskStatus::Running)
            .count()
    }

    pub fn can_launch(&self) -> bool {
        self.running_count() < MAX_BACKGROUND_TASKS
    }

    pub fn register(&self, init: RegisterBgTaskInit) -> BgTask {
        let task = BgTask {
            id: init.id.clone(),
            kind: init.kind,
            status: BgTaskStatus::Running,
            description: init.description,
            agent_type: init.agent_type,
            command: init.command,
            started_at: now_millis(),
            ended_at: None,
            output: String::new(),
            read_offset: 0,
            result: None,
            is_error: false,
            turns: None,
            tool_calls: None,
            notified: false,
        };
        let mut g = self.inner.lock().unwrap();
        if !g.tasks.contains_key(&init.id) {
            g.order.push(init.id.clone());
        }
        g.aborts.insert(init.id.clone(), init.abort);
        g.tasks.insert(init.id, task.clone());
        task
    }

    /// Append live output, capped. No-op for unknown/already-capped tasks.
    pub fn append_output(&self, id: &str, text: &str) {
        let mut g = self.inner.lock().unwrap();
        let Some(task) = g.tasks.get_mut(id) else {
            return;
        };
        if task.output.len() >= MAX_OUTPUT_CHARS {
            return;
        }
        task.output.push_str(text);
        if task.output.len() > MAX_OUTPUT_CHARS {
            let mut end = MAX_OUTPUT_CHARS;
            while !task.output.is_char_boundary(end) {
                end -= 1;
            }
            task.output.truncate(end);
            task.output.push_str("\n… [output truncated]");
        }
    }

    /// Mark a task terminal. The first terminal transition wins (idempotent).
    pub fn finish(&self, id: &str, res: BgTaskResult) {
        let mut g = self.inner.lock().unwrap();
        let Some(task) = g.tasks.get_mut(id) else {
            return;
        };
        if is_terminal_bg_status(task.status) {
            return;
        }
        task.status = res.status;
        task.result = Some(res.result);
        task.is_error = res.is_error;
        task.turns = res.turns;
        task.tool_calls = res.tool_calls;
        task.ended_at = Some(now_millis());
        drop(g);
        self.completion.notify_one();
    }

    /// A handle that resolves whenever a task finishes (terminal status). Clone
    /// is cheap (`Arc`). The engine task awaits `notify.notified()`.
    pub fn completion_notify(&self) -> Arc<Notify> {
        self.completion.clone()
    }

    pub fn mark_notified(&self, id: &str) {
        let mut g = self.inner.lock().unwrap();
        if let Some(task) = g.tasks.get_mut(id) {
            task.notified = true;
        }
    }

    pub fn get(&self, id: &str) -> Option<BgTask> {
        self.inner.lock().unwrap().tasks.get(id).cloned()
    }

    /// Output buffered since the last read (a delta); advances the read cursor.
    pub fn read_output_delta(&self, id: &str) -> String {
        let mut g = self.inner.lock().unwrap();
        let Some(task) = g.tasks.get_mut(id) else {
            return String::new();
        };
        let delta = task.output[task.read_offset..].to_string();
        task.read_offset = task.output.len();
        delta
    }

    /// Invoke one task's abort handle (off-lock). Returns false if unknown.
    /// The caller still `finish`es it with a `Killed` result (matches the TS
    /// `task_stop` flow: abort the process, then mark the task killed).
    pub fn abort(&self, id: &str) -> bool {
        let handle = {
            let g = self.inner.lock().unwrap();
            g.aborts.get(id).cloned()
        };
        match handle {
            Some(abort) => {
                abort();
                true
            }
            None => false,
        }
    }

    /// Abort every still-running task (process exit / cleanup).
    pub fn abort_all(&self) {
        // collect abort handles for running tasks, then call them off-lock.
        let to_abort: Vec<AbortFn> = {
            let g = self.inner.lock().unwrap();
            g.tasks
                .values()
                .filter(|t| t.status == BgTaskStatus::Running)
                .filter_map(|t| g.aborts.get(&t.id).cloned())
                .collect()
        };
        for abort in to_abort {
            abort();
        }
    }

    /// Snapshot of all tasks in registration order.
    pub fn snapshot(&self) -> Vec<BgTask> {
        let g = self.inner.lock().unwrap();
        g.order
            .iter()
            .filter_map(|id| g.tasks.get(id).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn noop_abort() -> AbortFn {
        Arc::new(|| {})
    }

    #[test]
    fn id_prefix_and_uniqueness() {
        let s = TaskStore::new();
        let a1 = s.generate_id(BgTaskKind::Agent);
        let a2 = s.generate_id(BgTaskKind::Agent);
        let b1 = s.generate_id(BgTaskKind::Bash);
        assert!(a1.starts_with('a'));
        assert!(b1.starts_with('b'));
        assert_ne!(a1, a2);
    }

    #[test]
    fn terminal_status() {
        assert!(!is_terminal_bg_status(BgTaskStatus::Running));
        assert!(is_terminal_bg_status(BgTaskStatus::Completed));
        assert!(is_terminal_bg_status(BgTaskStatus::Failed));
        assert!(is_terminal_bg_status(BgTaskStatus::Killed));
    }

    #[test]
    fn register_buffer_finish() {
        let s = TaskStore::new();
        let id = s.generate_id(BgTaskKind::Agent);
        s.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Agent,
            description: "research".into(),
            agent_type: Some("general-purpose".into()),
            command: None,
            abort: noop_abort(),
        });
        assert_eq!(s.get(&id).unwrap().status, BgTaskStatus::Running);
        assert_eq!(s.running_count(), 1);
        assert!(s.snapshot().iter().any(|t| t.id == id));

        s.append_output(&id, "step one\n");
        s.append_output(&id, "step two\n");
        assert_eq!(s.get(&id).unwrap().output, "step one\nstep two\n");

        s.finish(
            &id,
            BgTaskResult {
                status: BgTaskStatus::Completed,
                result: "done".into(),
                is_error: false,
                turns: Some(3),
                tool_calls: Some(5),
            },
        );
        let t = s.get(&id).unwrap();
        assert_eq!(t.status, BgTaskStatus::Completed);
        assert_eq!(t.result.as_deref(), Some("done"));
        assert_eq!(t.turns, Some(3));
        assert!(t.ended_at.unwrap() > 0);

        // first terminal transition wins
        s.finish(
            &id,
            BgTaskResult {
                status: BgTaskStatus::Failed,
                result: "nope".into(),
                is_error: true,
                turns: None,
                tool_calls: None,
            },
        );
        assert_eq!(s.get(&id).unwrap().status, BgTaskStatus::Completed);
        assert_eq!(s.get(&id).unwrap().result.as_deref(), Some("done"));
    }

    #[test]
    fn output_delta() {
        let s = TaskStore::new();
        let id = s.generate_id(BgTaskKind::Bash);
        s.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Bash,
            description: "x".into(),
            agent_type: None,
            command: Some("x".into()),
            abort: noop_abort(),
        });
        s.append_output(&id, "line1\n");
        assert_eq!(s.read_output_delta(&id), "line1\n");
        assert_eq!(s.read_output_delta(&id), "");
        s.append_output(&id, "line2\n");
        assert_eq!(s.read_output_delta(&id), "line2\n");
    }

    #[test]
    fn mark_notified_flips_once() {
        let s = TaskStore::new();
        let id = s.generate_id(BgTaskKind::Bash);
        s.register(RegisterBgTaskInit {
            id: id.clone(),
            kind: BgTaskKind::Bash,
            description: "ls".into(),
            agent_type: None,
            command: Some("ls".into()),
            abort: noop_abort(),
        });
        assert!(!s.get(&id).unwrap().notified);
        s.mark_notified(&id);
        assert!(s.get(&id).unwrap().notified);
    }

    #[test]
    fn abort_all_only_running() {
        let s = TaskStore::new();
        let run_flag = Arc::new(AtomicBool::new(false));
        let done_flag = Arc::new(AtomicBool::new(false));
        let rf = run_flag.clone();
        let df = done_flag.clone();

        let run_id = s.generate_id(BgTaskKind::Bash);
        let done_id = s.generate_id(BgTaskKind::Bash);
        s.register(RegisterBgTaskInit {
            id: run_id.clone(),
            kind: BgTaskKind::Bash,
            description: "sleep".into(),
            agent_type: None,
            command: Some("sleep 100".into()),
            abort: Arc::new(move || rf.store(true, Ordering::SeqCst)),
        });
        s.register(RegisterBgTaskInit {
            id: done_id.clone(),
            kind: BgTaskKind::Bash,
            description: "true".into(),
            agent_type: None,
            command: Some("true".into()),
            abort: Arc::new(move || df.store(true, Ordering::SeqCst)),
        });
        s.finish(
            &done_id,
            BgTaskResult {
                status: BgTaskStatus::Completed,
                result: String::new(),
                is_error: false,
                turns: None,
                tool_calls: None,
            },
        );

        s.abort_all();
        assert!(run_flag.load(Ordering::SeqCst));
        assert!(!done_flag.load(Ordering::SeqCst));
    }
}
