//! A project's coordinator and its work, read from `coordinators.*`.
//! Project prose stays in `projects`; these records only link its conversation
//! and the tasks whose helper results the coordinator checks.
use crate::inbox::{Section, ThreadSummary};
use serde_json::Value;
use std::sync::Arc;

pub mod tasks;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskState {
    Todo,
    Working,
    Blocked,
    Review,
    Done,
}

impl TaskState {
    fn read(state: &Value, run_status: &str) -> Self {
        match state.as_str() {
            Some("todo") => Self::Todo,
            Some("working") => Self::Working,
            Some("blocked") => Self::Blocked,
            Some("review") => Self::Review,
            Some("done") => Self::Done,
            _ => match run_status {
                "running" => Self::Working,
                "completed" => Self::Review,
                "failed" | "interrupted" | "stopped" => Self::Blocked,
                _ => Self::Todo,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub done_when: String,
    pub state: TaskState,
    pub agent_id: Option<String>,
    pub status: String,
    pub summary: Option<String>,
}

impl Task {
    pub fn status_label(&self) -> &'static str {
        if self.state == TaskState::Done {
            return "Done";
        }
        if self.state == TaskState::Review || self.status == "completed" {
            return "Needs review";
        }
        match self.state {
            TaskState::Working => "Helper working",
            TaskState::Blocked => "Blocked",
            _ => "To do",
        }
    }

    pub fn finished(&self) -> bool {
        self.state == TaskState::Done
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopKind {
    UserQuestion,
    WaitingOnUser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopState {
    Open,
    Answered,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loop {
    pub id: String,
    pub kind: LoopKind,
    pub state: LoopState,
    pub title: String,
    pub summary: Option<String>,
    pub options: Vec<String>,
    pub source_seq: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
}

impl Loop {
    pub fn is_open(&self) -> bool {
        self.state != LoopState::Closed
    }

    pub fn needs_signoff(&self) -> bool {
        self.kind == LoopKind::UserQuestion && self.state == LoopState::Answered
    }

    pub fn waiting_on_user(&self) -> bool {
        self.kind == LoopKind::WaitingOnUser && self.state == LoopState::Open
    }

    pub fn checking(&self) -> bool {
        self.kind == LoopKind::UserQuestion && self.state == LoopState::Open
    }

    fn sort_rank(&self) -> u8 {
        if self.needs_signoff() {
            0
        } else if self.waiting_on_user() {
            1
        } else {
            2
        }
    }

    pub fn decode(v: &Value) -> Option<Self> {
        let kind = match v["kind"].as_str()? {
            "user_question" => LoopKind::UserQuestion,
            "waiting_on_user" => LoopKind::WaitingOnUser,
            _ => return None,
        };
        let state = match v["state"].as_str()? {
            "open" => LoopState::Open,
            "answered" => LoopState::Answered,
            "closed" => LoopState::Closed,
            _ => return None,
        };
        Some(Self {
            id: identity(v, "id")?,
            kind,
            state,
            title: identity(v, "title")?,
            summary: v["summary"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            options: v["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(4)
                .map(str::to_owned)
                .collect(),
            source_seq: v["sourceSeq"].as_i64().filter(|n| *n >= 0),
            created_at: v["createdAt"].as_str().unwrap_or("").to_owned(),
            updated_at: v["updatedAt"].as_str().unwrap_or("").to_owned(),
            closed_at: identity(v, "closedAt"),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coordinator {
    pub project_id: String,
    pub thread_id: String,
    pub state: State,
    pub charter: String,
    pub interests: Vec<String>,
    pub tasks: Vec<Task>,
    pub loops: Vec<Loop>,
    pub task_board: Option<Arc<tasks::TaskBoard>>,
    pub updated_at: String,
}

fn identity(v: &Value, field: &str) -> Option<String> {
    v[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

impl Coordinator {
    pub fn decode(v: &Value) -> Option<Self> {
        let state = match v["state"].as_str()? {
            "active" => State::Active,
            "paused" => State::Paused,
            _ => return None,
        };
        Some(Self {
            project_id: identity(v, "projectId")?,
            thread_id: identity(v, "threadId")?,
            state,
            charter: v["charter"].as_str().unwrap_or("").to_owned(),
            interests: v["interests"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            tasks: v["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    let status = t["run"]["status"].as_str().unwrap_or("queued");
                    Some(Task {
                        id: identity(t, "id")?,
                        title: identity(t, "title")?,
                        done_when: t["doneWhen"].as_str().unwrap_or("").to_owned(),
                        state: TaskState::read(&t["state"], status),
                        agent_id: identity(&t["run"], "agentId"),
                        status: status.to_owned(),
                        summary: t["run"]["summary"].as_str().map(str::to_owned),
                    })
                })
                .collect(),
            loops: v["loops"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Loop::decode)
                .collect(),
            task_board: tasks::TaskBoard::decode(&v["taskBoard"]).map(Arc::new),
            updated_at: v["updatedAt"].as_str().unwrap_or("").to_owned(),
        })
    }

    pub fn list(v: &Value) -> Vec<Self> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Self::decode)
            .collect()
    }

    pub fn working(&self) -> usize {
        self.tasks
            .iter()
            .filter(|t| t.state == TaskState::Working && t.status == "running")
            .count()
    }

    pub fn open_loops(&self) -> Vec<&Loop> {
        let mut open = self
            .loops
            .iter()
            .filter(|l| l.is_open())
            .collect::<Vec<_>>();
        open.sort_by_key(|l| l.sort_rank());
        open
    }

    pub fn waiting_count(&self) -> usize {
        self.loops.iter().filter(|l| l.waiting_on_user()).count()
    }

    pub fn signoff_count(&self) -> usize {
        self.loops.iter().filter(|l| l.needs_signoff()).count()
    }

    pub fn actionable_loops(&self) -> usize {
        self.waiting_count() + self.signoff_count()
    }
}

/// Splits markdown notes into `(heading, body)` cards on `## ` headings for the
/// Agent memory drawer. Notes without `## ` headings stay as one card.
pub fn note_sections(notes: &str) -> Vec<(Option<String>, String)> {
    let trimmed = notes.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut sections: Vec<(Option<String>, Vec<&str>)> = Vec::new();
    for line in trimmed.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            let title = heading.trim();
            if !title.is_empty() {
                sections.push((Some(title.to_owned()), Vec::new()));
                continue;
            }
        }
        if let Some((_, body)) = sections.last_mut() {
            body.push(line);
        } else {
            sections.push((None, vec![line]));
        }
    }
    sections
        .into_iter()
        .map(|(title, lines)| (title, lines.join("\n").trim().to_owned()))
        .filter(|(title, body)| title.is_some() || !body.is_empty())
        .collect()
}

/// Coordinators sit below Starred by default. Their ordinary thread is
/// removed from every other section exactly once, except after archiving.
pub fn sections(
    mut sections: Vec<Section<Arc<ThreadSummary>>>,
    coordinators: &[Coordinator],
) -> Vec<Section<Arc<ThreadSummary>>> {
    let mut rows = Vec::new();
    for coordinator in coordinators {
        for section in &mut sections {
            if section.key == "archived" {
                continue;
            }
            if let Some(index) = section
                .rows
                .iter()
                .position(|t| t.id == coordinator.thread_id)
            {
                rows.push(section.rows.remove(index));
                break;
            }
        }
    }
    // Another runner sends the optional summary hint, not its local registry.
    // Take those rows too, in a stable order independent of their last event.
    let mut remote = Vec::new();
    for section in &mut sections {
        if section.key == "archived" {
            continue;
        }
        let mut ordinary = Vec::new();
        for row in std::mem::take(&mut section.rows) {
            if row.is_coordinator() {
                remote.push(row);
            } else {
                ordinary.push(row);
            }
        }
        section.rows = ordinary;
    }
    remote.sort_by(|a, b| {
        a.coordinator_project_id
            .cmp(&b.coordinator_project_id)
            .then_with(|| a.id.cmp(&b.id))
    });
    rows.extend(remote);
    sections.retain(|s| !s.rows.is_empty() || s.key == "inbox");
    if !rows.is_empty() {
        let at = usize::from(sections.first().is_some_and(|s| s.key == "starred"));
        sections.insert(
            at,
            Section {
                key: "coordinators",
                title: "Coordinators",
                rows,
            },
        );
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unreadable_identity_or_lifecycle_never_hides_an_ordinary_thread() {
        for v in [
            json!({"projectId":"p", "threadId":"", "state":"active"}),
            json!({"projectId":3, "threadId":"t", "state":"active"}),
            json!({"projectId":"p", "threadId":"t", "state":"future-state"}),
        ] {
            assert!(Coordinator::decode(&v).is_none());
        }
    }

    #[test]
    fn metadata_keeps_remote_coordinators_pinned_without_a_registry() {
        let remote = Arc::new(ThreadSummary {
            id: "remote".into(),
            coordinator_project_id: Some("p_remote".into()),
            ..Default::default()
        });
        let ordinary = Arc::new(ThreadSummary {
            id: "ordinary".into(),
            ..Default::default()
        });
        let result = sections(
            vec![Section {
                key: "inbox",
                title: "Inbox",
                rows: vec![ordinary, remote.clone()],
            }],
            &[],
        );
        assert_eq!(result[0].key, "coordinators");
        assert_eq!(result[0].rows[0].id, "remote");
        assert_eq!(result[1].rows[0].id, "ordinary");
        let result = sections(
            vec![Section {
                key: "archived",
                title: "Archived",
                rows: vec![remote],
            }],
            &[],
        );
        assert_eq!(result[0].key, "archived");
    }

    #[test]
    fn a_helper_returning_needs_review_until_the_coordinator_accepts_it() {
        let c = Coordinator::decode(&json!({
            "projectId":"p", "threadId":"t", "state":"active", "tasks":[
                {"id":"a", "title":"Fix a bug", "doneWhen":"Review passes", "run":{"status":"completed","agentId":"worker"}},
                {"id":"b", "title":"Next job"},
                {"id":null, "title":"Broken row"}
            ]
        })).unwrap();
        assert_eq!(c.tasks.len(), 2);
        assert!(!c.tasks[0].finished());
        assert_eq!(c.tasks[0].status_label(), "Needs review");
        assert_eq!(c.tasks[1].status_label(), "To do");
        let done = Coordinator::decode(&json!({
            "projectId":"p", "threadId":"t", "state":"active", "tasks":[
                {"id":"a", "title":"Fix a bug", "state":"done", "run":{"status":"completed"}}
            ]
        }))
        .unwrap();
        assert!(done.tasks[0].finished());
        assert_eq!(done.tasks[0].status_label(), "Done");
    }

    #[test]
    fn coordinator_moves_once_below_starred_and_archived_stays_put() {
        let c =
            Coordinator::decode(&json!({"projectId":"p","threadId":"t","state":"paused"})).unwrap();
        let starred = Arc::new(ThreadSummary {
            id: "s".to_owned(),
            starred_at: Some("2026-11-06T09:00:00Z".to_owned()),
            ..Default::default()
        });
        let thread = Arc::new(ThreadSummary {
            id: "t".to_owned(),
            ..Default::default()
        });
        let result = sections(
            vec![
                Section {
                    key: "starred",
                    title: "Starred",
                    rows: vec![starred],
                },
                Section {
                    key: "inbox",
                    title: "Inbox",
                    rows: vec![thread.clone()],
                },
            ],
            std::slice::from_ref(&c),
        );
        assert_eq!(
            result.iter().map(|s| s.key).collect::<Vec<_>>(),
            ["starred", "coordinators", "inbox"]
        );
        assert_eq!(result[1].rows.len(), 1);
        assert!(result[2].rows.is_empty());
        let result = sections(
            vec![Section {
                key: "archived",
                title: "Archived",
                rows: vec![thread],
            }],
            &[c],
        );
        assert_eq!(result[0].key, "archived");
    }

    #[test]
    fn open_loops_decode_tolerantly_and_sort_signoff_before_waiting_before_checking() {
        let c = Coordinator::decode(&json!({
            "projectId": "p",
            "threadId": "t",
            "state": "active",
            "loops": [
                {"id": "chk", "kind": "user_question", "state": "open", "title": "Does waterproofing muffle mic?"},
                {"id": "wait", "kind": "waiting_on_user", "state": "open", "title": "Build iOS auto-resume?", "summary": "Uses geofence.", "options": ["Build it", "Not yet"], "sourceSeq": 12},
                {"id": "ans", "kind": "user_question", "state": "answered", "title": "What sensors are in Omi CV1?", "summary": "6-axis IMU and 2 PDM mics.", "sourceSeq": 7},
                {"id": "done", "kind": "waiting_on_user", "state": "closed", "title": "Old decision"},
                {"id": "bad", "kind": "future_kind", "state": "open", "title": "Ignored"}
            ]
        }))
        .unwrap();
        assert_eq!(c.loops.len(), 4);
        let open = c.open_loops();
        assert_eq!(
            open.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            ["ans", "wait", "chk"]
        );
        assert_eq!(c.signoff_count(), 1);
        assert_eq!(c.waiting_count(), 1);
        assert_eq!(c.actionable_loops(), 2);
        assert_eq!(open[1].options, ["Build it", "Not yet"]);
        assert_eq!(open[1].source_seq, Some(12));
    }

    #[test]
    fn note_sections_splits_h2_headings_and_handles_plain_notes() {
        assert!(note_sections("   ").is_empty());
        assert_eq!(
            note_sections("Just a plain note."),
            vec![(None, "Just a plain note.".to_owned())]
        );
        let parsed =
            note_sections("## Hardware\n6-axis IMU\n\n## ASR Pipeline\nTinker Desk poller\n");
        assert_eq!(
            parsed,
            vec![
                (Some("Hardware".to_owned()), "6-axis IMU".to_owned()),
                (
                    Some("ASR Pipeline".to_owned()),
                    "Tinker Desk poller".to_owned()
                ),
            ]
        );
    }
}
