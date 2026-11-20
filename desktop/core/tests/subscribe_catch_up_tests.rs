// A thread caught up through `threads.subscribe` (a reconnect, or a thread the
// GPUI app kept loaded coming back into view, pane_cache.rs): deltas pushed
// while the subscribe was in flight are held and come after the reply's
// events, so one for a reply that's since been finished mustn't add its words
// again or set it streaming (Codex's review of the kept threads, 12 Nov).
mod support;

use serde_json::json;
use support::*;

#[test]
fn relay_subscription_reports_its_own_sparse_events_including_unflushed_results() {
    let mut model = TranscriptModel::new(None);
    model.load(vec![user(25, "First"), call(41, "tool"), text(73, "reply", "Done")], &[]);
    let mut feed = ThreadFeed::new(model);
    assert_eq!(feed.relay_seen(), None);
    feed.set_sparse(true);
    feed.receive(result(42, "tool"));
    assert_eq!(feed.relay_seen(), Some(vec![[25, 25], [41, 42], [73, 73]]));
    feed.flush();
    assert_eq!(feed.relay_seen(), Some(vec![[25, 25], [41, 42], [73, 73]]));
}
use threadbear_core::reducer::*;

#[test]
fn a_held_delta_after_the_reply_finished_changes_nothing() {
    let mut model = TranscriptModel::new(None);
    model.load(vec![event(1, "turn.started", json!({"turnId": "t1"})), user(2, "Hi")], &[]);
    let mut feed = ThreadFeed::new(model);
    feed.begin_subscribe();
    // "Hello" streamed before the subscribe; "!" pushed while it was in flight.
    let _ = feed.receive(delta(0, "m1", "!"));
    let in_progress = [InProgress { item_id: "m1".into(), type_: "assistant.text".into(), text: "Hello".into() }];
    let _ = feed.finish_subscribe(vec![text(3, "m1", "Hello!"), done(4)], &in_progress);
    let _ = feed.flush();
    let RowContent::Assistant(item) = &feed.model().item("a:m1").expect("the reply").content else { panic!("an assistant row") };
    assert_eq!(item.text, "Hello!");
    assert!(!item.is_streaming, "finished");
}

#[test]
fn a_delta_while_it_streams_still_adds_on() {
    let mut model = TranscriptModel::new(None);
    model.load(vec![event(1, "turn.started", json!({"turnId": "t1"})), user(2, "Hi")], &[]);
    let _ = model.apply(vec![delta(0, "m1", "Hel")]);
    let _ = model.apply(vec![delta(0, "m1", "lo")]);
    let RowContent::Assistant(item) = &model.item("a:m1").expect("the reply").content else { panic!("an assistant row") };
    assert_eq!(item.text, "Hello");
    assert!(item.is_streaming);
}

// Claude's narration streams as reasoning and lands as assistant text with the
// same item: a reasoning delta held past it doesn't bring a thinking row back.
#[test]
fn a_held_reasoning_delta_after_narration_landed_adds_no_row() {
    let mut model = TranscriptModel::new(None);
    model.load(vec![event(1, "turn.started", json!({"turnId": "t1"})), user(2, "Hi"), text(3, "n1", "Looking now."), done(4)], &[]);
    let before = ids(&model);
    let _ = model.apply(vec![reasoning_delta(0, "n1", " more")]);
    assert_eq!(ids(&model), before);
}

// A reply that was already streaming when the subscribe answered (a runner
// slow to answer it, so its turn started and its first words went out
// before the app was listening): the reply's `inProgress` text has no turn,
// but the row is still the open turn's, so it groups and ends with it
// (stress run, 18 Nov: `turn: null` on the streamed reply).
#[test]
fn a_reply_streaming_before_the_subscribe_belongs_to_its_turn() {
    let mut model = TranscriptModel::new(None);
    model.load(vec![event_turn(1, "turn.started", json!({"turnId": "t0"}), Some("t0")), user(2, "Hi"), event_turn(3, "turn.completed", json!({"turnId": "t0", "outcome": "completed"}), Some("t0"))], &[]);
    let mut feed = ThreadFeed::new(model);
    feed.begin_subscribe();
    let _ = feed.receive(delta(0, "m1", " there"));
    let in_progress = [InProgress { item_id: "m1".into(), type_: "assistant.text".into(), text: "Hello".into() }];
    let _ = feed.finish_subscribe(vec![event(4, "turn.started", json!({"turnId": "t1"}))], &in_progress);
    let _ = feed.flush();
    assert_eq!(feed.model().item("a:m1").expect("the reply").turn_id.as_deref(), Some("t1"), "while it streams");
    let _ = feed.receive(text(5, "m1", "Hello there"));
    let _ = feed.receive(done(6));
    let _ = feed.flush();
    assert_eq!(feed.model().item("a:m1").expect("the reply").turn_id.as_deref(), Some("t1"), "once it's finished");
}

// The same, read in the first page: `threads.events`' own `inProgress`.
#[test]
fn a_reply_streaming_in_the_first_page_belongs_to_its_turn() {
    let mut model = TranscriptModel::new(None);
    let in_progress = [InProgress { item_id: "m1".into(), type_: "assistant.text".into(), text: "Hello".into() }];
    model.load(vec![event(1, "turn.started", json!({"turnId": "t1"})), user(2, "Hi")], &in_progress);
    assert_eq!(model.item("a:m1").expect("the reply").turn_id.as_deref(), Some("t1"));
    let _ = model.apply(vec![text(3, "m1", "Hello there"), done(4)]);
    assert_eq!(model.item("a:m1").expect("the reply").turn_id.as_deref(), Some("t1"));
}

/// Where `item` is drawn: as a row of its own, or in a group's members.
fn places(model: &TranscriptModel, item: &str) -> usize {
    model
        .rows()
        .iter()
        .map(|r| match &r.content {
            RowContent::Group(group) => group.member_ids.iter().filter(|m| *m == item).count(),
            _ => usize::from(r.id == item),
        })
        .sum()
}

// Two thoughts still streaming with no turn known for either are grouped
// together; when one takes its turn, the group it leaves is drawn again
// rather than still listing it (Codex's review of the fix above).
#[test]
fn a_row_taking_its_turn_leaves_the_group_it_was_in() {
    let mut model = TranscriptModel::new(None);
    let in_progress = [
        InProgress { item_id: "a".into(), type_: "reasoning".into(), text: "First thought".into() },
        InProgress { item_id: "b".into(), type_: "reasoning".into(), text: "Second thought".into() },
    ];
    model.load(vec![event_turn(1, "turn.started", json!({"turnId": "t0"}), Some("t0")), user(2, "Hi"), done_turn(3, "t0")], &in_progress);
    assert_eq!(model.item("r:b").expect("b").turn_id, None);
    let _ = model.apply(vec![event_turn(0, "reasoning.delta", json!({"itemId": "b", "text": " more"}), Some("t2"))]);
    assert_eq!(model.item("r:b").expect("b").turn_id.as_deref(), Some("t2"));
    assert_eq!(places(&model, "r:b"), 1, "{:?}", model.rows().iter().map(|r| &r.id).collect::<Vec<_>>());
    assert_eq!(places(&model, "r:a"), 1);
}

// A running turn longer than a page: its start is on an older page, so the
// open turn is worked out from the page, and the reply still streaming is
// that turn's (Codex's review).
#[test]
fn a_reply_streaming_in_a_turn_longer_than_a_page_belongs_to_it() {
    let mut model = TranscriptModel::new(None);
    let in_progress = [InProgress { item_id: "m1".into(), type_: "assistant.text".into(), text: "Still going".into() }];
    model.load(vec![call(500, "c1"), result(501, "c1"), call(502, "c2"), result(503, "c2")], &in_progress);
    assert!(model.has_older_events());
    assert_eq!(model.open_turn(), Some("t1"));
    assert_eq!(model.item("a:m1").expect("the reply").turn_id.as_deref(), Some("t1"));
}
