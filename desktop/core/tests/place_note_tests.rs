// The lines a thread gets when it's archived, brought back, hibernated or
// woken (runner/src/place-notes.ts): on show, not folded into the turn's
// work. Mike, 25 Nov 2026: a thread the quiet inbox archived, which an
// agent brought back with `tb unarchive --wrong-hide`, showed its reply,
// the footer and the Done card, with nothing to say either had happened.
// The runner had written both lines, after the turn, and they folded into
// its line of work.

mod support;

use serde_json::json;
use support::*;
use threadbear_core::reducer::*;

const QUIET: &str = "Archived by Quiet inbox on Tue 24 Nov, 8:10 pm: it finished with nothing for you, and Opus judged you didn't need to see it. The note was done as asked.";
const BACK: &str = "Brought back from the archive by an agent on Wed 25 Nov, 9:40 am: you said Quiet inbox shouldn't have hidden it.";

fn note(seq: i64, words: &str) -> Event {
    event_no_turn(seq, "system.note", json!({"text": words}))
}

fn note_row<'a>(model: &'a TranscriptModel, id: &str) -> &'a Row {
    model
        .rows()
        .iter()
        .find(|r| r.id == id)
        .unwrap_or_else(|| panic!("{id} on show: {:?}", ids(model)))
}

#[test]
fn the_quiet_inbox_archive_and_the_return_show_after_the_turn() {
    let model = from_events(vec![
        user(1, "I bookmarked this X post. Write me a short note on it."),
        call_titled(2, "c1", "Read the post"),
        result(3, "c1"),
        text(4, "m1", "Here's the note."),
        done_turn(5, "t1"),
        note(6, QUIET),
        note(7, BACK),
    ]);
    let quiet = note_row(&model, "n:6");
    let back = note_row(&model, "n:7");
    assert!(!quiet.in_group && !back.in_group, "{:?}", ids(&model));
    // The quiet inbox's line says what it is on hover; a plain return
    // names it too, so it does as well.
    assert_eq!(quiet.content.note_tip(), Some(QUIET_INBOX_TIP));
    assert_eq!(back.content.note_tip(), Some(QUIET_INBOX_TIP));
}

/// The lines as an older runner wrote them, Mike's own thread among them.
#[test]
fn the_quiet_inbox_lines_from_before_they_named_it_show_and_explain_it() {
    let model = from_events(vec![
        user(1, "Write me a short note on it."),
        text(2, "m1", "Here's the note."),
        done_turn(3, "t1"),
        note(4, "Archived quietly: it finished with nothing for you, and a model judged you didn't need to see it. Routine."),
        note(5, "Brought back by you: you should have been shown this."),
    ]);
    for id in ["n:4", "n:5"] {
        let row = note_row(&model, id);
        assert!(!row.in_group, "{id}");
        assert_eq!(row.content.note_tip(), Some(QUIET_INBOX_TIP), "{id}");
    }
}

#[test]
fn every_kind_of_place_line_stays_out_of_the_work() {
    for words in [
        "Archived by you on Tue 24 Nov, 3:32 pm.",
        "Archived by you: it worked.",
        "Archived, as the agent was asked to once it had finished.",
        "Brought back from the archive by you on Tue 24 Nov, 3:32 pm.",
        "Back in the archive: the scheduled run ended with nothing for you.",
        "Back in the inbox on Tue 24 Nov, 3:32 pm: no schedule is booked for it any more.",
        "Hibernated by an agent on Tue 24 Nov, 3:32 pm, until Wed 25 Nov, 9:00 am.",
        "Hibernating until Wed 25 Nov, 9:00 am, as the agent was asked to.",
        "Woken by you on Tue 24 Nov, 3:32 pm.",
        "Moved to Hibernating on Tue 24 Nov, 3:32 pm: nothing needs you, and a schedule brings it back.",
    ] {
        let model = from_events(vec![
            user(1, "Do it"),
            call_titled(2, "c1", "git status"),
            result(3, "c1"),
            text(4, "m1", "Done."),
            done_turn(5, "t1"),
            note(6, words),
        ]);
        assert!(!note_row(&model, "n:6").in_group, "{words}");
        assert_eq!(
            RowContent::Note(words.into()).note_tip(),
            None,
            "only a line naming Quiet inbox has a tip"
        );
    }
}

#[test]
fn other_notes_still_fold() {
    let model = from_events(vec![
        user(1, "Do it"),
        call_titled(2, "c1", "git status"),
        result(3, "c1"),
        text(4, "m1", "Done."),
        done_turn(5, "t1"),
        note(6, "Compacted the conversation"),
    ]);
    assert!(
        !model.rows().iter().any(|r| r.id == "n:6" && !r.in_group),
        "{:?}",
        ids(&model)
    );
}
