use serde_json::json;
use threadbear_core::inbox::{self, ThreadSummary};

fn row(value: serde_json::Value) -> ThreadSummary {
    serde_json::from_value(value).unwrap()
}

#[test]
fn saved_tasks_are_separate_from_inbox_even_when_starred() {
    let task = row(
        json!({"id":"saved", "title":"Plan the garden", "starredAt":"2026-11-01T00:00:00Z",
        "backlog":{"text":"Plan the garden  \n\n", "images":[], "revision":3}}),
    );
    let conversation = row(json!({"id":"chat", "title":"Current conversation"}));
    let sections = inbox::sections([&task, &conversation], 0);
    assert_eq!(inbox::section_of(&task, 0, &Default::default()), "backlog");
    assert_eq!(
        sections.iter().find(|s| s.key == "backlog").unwrap().rows[0].id,
        "saved"
    );
    assert_eq!(
        sections
            .iter()
            .find(|s| s.key == "inbox")
            .unwrap()
            .rows
            .len(),
        1
    );
}

#[test]
fn deferred_conversations_stay_in_backlog_without_losing_history() {
    let task = row(
        json!({"id":"later", "backlogged":true,"lastSeq":47,"needsYou":true,
        "starredAt":"2026-11-01T00:00:00Z"}),
    );
    assert_eq!(inbox::section_of(&task, 0, &Default::default()), "backlog");
    assert_eq!(task.last_seq, 47);
    assert_eq!(inbox::needs_you_count([&task], 0), 0);
    let archived =
        row(json!({"id":"later", "backlogged":true,"archivedAt":"2026-11-01T00:00:00Z"}));
    assert_eq!(
        inbox::section_of(&archived, 0, &Default::default()),
        "archived"
    );
}

#[test]
fn saving_keeps_whitespace_picture_positions_and_owned_files() {
    let file = threadbear_core::backlog::Attachment {
        id: "file1".into(),
        path: "/thread/intake/a.pdf".into(),
        name: "a.pdf".into(),
        media_type: "application/pdf".into(),
        size: 42,
        sha256: "hash".into(),
    };
    let params = threadbear_core::backlog::save_params(
        "task",
        "Before \u{fffc} after  \n\n",
        &[threadbear_core::reducer::ImageRef::new(
            "/thread/media/a.png",
            "image/png",
        )],
        &[file],
        2,
    );
    assert_eq!(params["text"], "Before [Picture 1] after  \n\n");
    assert_eq!(params["revision"], 2);
    assert_eq!(params["attachments"][0]["id"], "file1");
    assert_eq!(params["images"][0]["path"], "/thread/media/a.png");
}

#[test]
fn other_machines_saved_tasks_are_not_mixed_into_inbox() {
    let remote = threadbear_core::remote::decode_remote_threads(&json!({"threads":[
        {"runnerId":"other","threadId":"11111111-1111-4111-8111-111111111111","backlog":true},
        {"runnerId":"other","threadId":"22222222-2222-4222-8222-222222222222","backlogged":true}
    ]}));
    assert_eq!(remote.threads.len(), 2);
    for t in &remote.threads {
        assert_eq!(inbox::section_of(t, 0, &Default::default()), "backlog");
    }
}
