//! Background-task subsystem (store + completion notification). Port of
//! `src/tasks/*`.

pub mod notification;
pub mod store;

pub use notification::make_bg_task_notification;
pub use store::{BgTask, BgTaskKind, BgTaskResult, BgTaskStatus, RegisterBgTaskInit, TaskStore};
