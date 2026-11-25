// The quiet inbox for Mike's own threads (experiment quietInboxMine;
// docs/protocol/threads.md, "Inbox guess"): the runner archives a finished
// thread of his when a model judges he didn't need to see it. A list of them
// at the foot of the Inbox came and went on 23 Nov 2026: Mike didn't want it
// cluttering the sidebar, and checks them in a daily thread instead. What's
// left here is an archived row's "Should Have Shown Me" (its right-click
// menu): back to the inbox at once, telling the runner the guess was wrong
// (`threads.update` with `archived: false, verdict: "shouldHaveShown"`),
// rolled back with the error if the runner refuses (`update_thread`).
use crate::app::Threadbear;
use gpui_kit::*;
use serde_json::json;

impl Threadbear {
    /// "Should have shown me": back to the inbox now, the label with it.
    pub(crate) fn should_have_shown(&mut self, id: &str, cx: &mut Context<Self>) {
        self.update_thread(
            id,
            |t| {
                t.archived_at = None;
                t.quietly_archived = None;
            },
            json!({ "archived": false, "verdict": "shouldHaveShown" }),
            cx,
        );
    }
}
