// Where Chromium has got to in this process, on its own so the sealed
// pages' context (sealed.rs) can say it failed without needing the host that
// starts it (deslop-please's module-cycle).
use std::sync::Mutex;

/// Where Chromium has got to in this process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    NotStarted,
    Starting,
    Ready,
    Failed(String),
}

static STATUS: Mutex<Status> = Mutex::new(Status::NotStarted);

pub(crate) fn set_status(status: Status) {
    if let Ok(mut now) = STATUS.lock() {
        *now = status;
    }
}

pub fn status() -> Status {
    STATUS
        .lock()
        .map(|s| s.clone())
        .unwrap_or(Status::Failed("the web runtime's state was lost".into()))
}
