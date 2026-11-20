//! Moves the app has asked for that the runner hasn't shown yet.
//!
//! Picking a machine from the menu marks the row "Moving to …" and locks
//! the box at once, then asks the runner where the thread would go
//! (`threads.movePreview`) and starts it (`threads.move`). For another
//! runner's thread that look goes over the relay and can take a quarter of
//! a minute, and any update of the row meanwhile (its runner's list coming
//! in, a `thread.updated`) is a summary without `moving`, which took the
//! guess away: on 18 Nov 2026 Mike saw the spinner start, stop with the box
//! open again, and start once more when the move began. So the guess is
//! kept here and put back on every summary that comes in, until the runner
//! says something of its own about the move, the app gives up on it (the
//! sheet came up instead, or the runner refused), or a short while after
//! the runner took it without a word.

use std::collections::HashMap;

use serde_json::Value;

use crate::inbox::ThreadSummary;

/// How long a guess outlives the runner taking the move without showing it
/// (an older runner, or its row update lost): long enough for the runner's
/// own word to come, short enough that a box locked by a guess opens again.
pub const SHOWN_AFTER_START_MS: i64 = 30_000;

#[derive(Debug, Clone)]
struct Guess {
    moving: Value,
    /// Which pick this is: a continuation of an older one (cancelled, or
    /// picked again since) finds it isn't current and does nothing.
    token: u64,
    /// The move's id once `threads.move` has answered.
    move_id: Option<String>,
    /// Set once `threads.move` has answered: the guess goes after this.
    until_ms: Option<i64>,
    /// A failed or cancelled move seen before `threads.move` answered: it
    /// may be this one, failing at once (Codex's review), which `started`
    /// then hands back.
    ended_seen: Option<Value>,
}

#[derive(Debug, Default, Clone)]
pub struct StartingMoves {
    by_thread: HashMap<String, Guess>,
    next_token: u64,
    /// Picks Mike cancelled before `threads.move` answered. Kept apart from
    /// the guesses: a guess also goes when the runner shows the move, which
    /// can come before that answer, and that's no cancel (Codex's second
    /// review: the app cancelled a move nobody had).
    cancelled: std::collections::HashSet<u64>,
}

fn state(moving: &Value) -> &str {
    moving.get("state").and_then(Value::as_str).unwrap_or("")
}

fn ended(moving: &Value) -> bool {
    matches!(state(moving), "failed" | "cancelled")
}

fn move_id(moving: &Value) -> Option<&str> {
    moving.get("moveId").and_then(Value::as_str)
}

/// The app's own guess on a row, as opposed to anything the runner said.
pub fn is_guess(moving: &Value) -> bool {
    move_id(moving) == Some("")
}

impl StartingMoves {
    /// Mike picked a machine: the row says it's going to `to_name`. The
    /// token names this pick for the calls it makes.
    pub fn start(&mut self, thread_id: &str, to: &str, to_name: &str) -> (Value, u64) {
        let moving = serde_json::json!({ "moveId": "", "to": to, "toName": to_name, "state": "asking" });
        self.next_token += 1;
        let token = self.next_token;
        self.by_thread.insert(thread_id.to_owned(), Guess { moving: moving.clone(), token, move_id: None, until_ms: None, ended_seen: None });
        (moving, token)
    }

    /// Whether `token`'s guess is still on the thread: not cancelled, given
    /// up on, picked again since or taken over by the runner's own word.
    pub fn is_current(&self, thread_id: &str, token: u64) -> bool {
        self.by_thread.get(thread_id).is_some_and(|g| g.token == token)
    }

    /// Cancel Move before `threads.move` answered: the guess goes, and the
    /// pick's calls are to stop (`was_cancelled`). False when there's no
    /// such pick, so the runner's move is the one to cancel.
    pub fn cancel_pending(&mut self, thread_id: &str) -> bool {
        match self.by_thread.get(thread_id) {
            Some(g) if g.move_id.is_none() => {
                self.cancelled.insert(g.token);
                self.by_thread.remove(thread_id);
                true
            }
            _ => false,
        }
    }

    /// Whether Mike cancelled the pick `token` before it started. Asked
    /// once, by the pick's own continuation, which then forgets it.
    pub fn take_cancelled(&mut self, token: u64) -> bool {
        self.cancelled.remove(&token)
    }

    /// Picked, but `threads.move` hasn't answered: Cancel Move is the app's
    /// to do, as the runner has no move to cancel yet.
    pub fn is_pending(&self, thread_id: &str) -> bool {
        self.by_thread.get(thread_id).is_some_and(|g| g.move_id.is_none())
    }

    /// `threads.move` answered with the move's id: the runner's own word on
    /// it is due, and the guess stands in for it a short while longer. A
    /// failure or cancel of this very move that came in first is handed
    /// back, for the row, and the guess goes.
    pub fn started(&mut self, thread_id: &str, token: u64, move_id: Option<&str>, now_ms: i64) -> Option<Value> {
        let g = self.by_thread.get_mut(thread_id).filter(|g| g.token == token)?;
        if let (Some(seen), Some(id)) = (&g.ended_seen, move_id) {
            if self::move_id(seen) == Some(id) {
                let seen = seen.clone();
                self.by_thread.remove(thread_id);
                return Some(seen);
            }
        }
        g.move_id = move_id.map(str::to_owned);
        g.until_ms = Some(now_ms + SHOWN_AFTER_START_MS);
        None
    }

    /// The app gave up on it: the sheet came up instead, the runner refused
    /// the move, or Mike cancelled it.
    pub fn forget(&mut self, thread_id: &str) {
        self.by_thread.remove(thread_id);
    }

    /// Called once the wait after `started` is over, so a guess the runner
    /// never answered goes without another summary coming in (Codex's
    /// review). True when it went, and the row's guess should too.
    pub fn expire(&mut self, thread_id: &str, token: u64, now_ms: i64) -> bool {
        let due = self.by_thread.get(thread_id).is_some_and(|g| g.token == token && g.until_ms.is_some_and(|until| now_ms >= until));
        if due {
            self.by_thread.remove(thread_id);
        }
        due
    }

    /// The threads with a guess, to dress after a whole new list.
    pub fn threads(&self) -> Vec<String> {
        self.by_thread.keys().cloned().collect()
    }

    pub fn is_starting(&self, thread_id: &str) -> bool {
        self.by_thread.contains_key(thread_id)
    }

    /// A summary of the thread has come in: put the guess on it while the
    /// runner hasn't said anything of its own about this move. A move the
    /// runner shows going, or this one by its id (failed too), is its word,
    /// and the guess goes. A failure or cancel before the id is known isn't
    /// yet (an earlier move's is shown for a minute, so a second try right
    /// after one would flash "Couldn't move"), but it's kept for `started`.
    pub fn dress(&mut self, t: &mut ThreadSummary, now_ms: i64) {
        let Some(g) = self.by_thread.get_mut(&t.id) else { return };
        if g.until_ms.is_some_and(|until| now_ms > until) {
            self.by_thread.remove(&t.id);
            return;
        }
        if let Some(m) = &t.moving {
            if is_guess(m) {
                // The app's own guess come back round (a cached copy): not
                // the runner's word.
            } else {
                let this_one = g.move_id.is_some() && g.move_id.as_deref() == move_id(m);
                if this_one || !ended(m) {
                    self.by_thread.remove(&t.id);
                    return;
                }
                if g.move_id.is_none() {
                    g.ended_seen = Some(m.clone());
                }
            }
        }
        t.moving = Some(g.moving.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(moving: Option<Value>) -> ThreadSummary {
        let mut v = json!({
            "id": "t1", "title": "Thread 1", "cwd": "/home/alex/dev/x",
            "provider": "claude", "status": "idle", "needsYou": false,
            "lastActivityAt": "2026-11-18T03:57:00Z", "preview": "", "lastSeq": 10, "lastSeenSeq": 10
        });
        if let Some(m) = moving {
            v["moving"] = m;
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_row_update_while_the_runner_looks_keeps_the_move_showing() {
        let mut s = StartingMoves::default();
        let _ = s.start("t1", "r-m5", "M5");
        // Hetzner's list comes in while the M5 works out where it would go.
        let mut t = thread(None);
        s.dress(&mut t, 1_000);
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"));
    }

    #[test]
    fn the_runners_own_word_takes_over() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        s.started("t1", tok, Some("m1"), 1_000);
        let mut t = thread(Some(json!({ "moveId": "m1", "to": "r-m5", "toName": "M5", "state": "packing" })));
        s.dress(&mut t, 2_000);
        assert_eq!(t.moving.as_ref().unwrap()["state"], "packing");
        assert!(!s.is_starting("t1"));
        // and later updates are the runner's alone
        let mut t = thread(None);
        s.dress(&mut t, 3_000);
        assert!(t.moving.is_none());
    }

    #[test]
    fn this_move_failing_shows_as_failed() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        s.started("t1", tok, Some("m1"), 1_000);
        let mut t = thread(Some(json!({ "moveId": "m1", "state": "failed", "note": "No login." })));
        s.dress(&mut t, 2_000);
        assert_eq!(t.moving.as_ref().unwrap()["state"], "failed");
    }

    #[test]
    fn an_earlier_moves_failure_doesnt_stand_in_for_a_new_try() {
        let mut s = StartingMoves::default();
        let _ = s.start("t1", "r-m5", "M5");
        let mut t = thread(Some(json!({ "moveId": "m0", "state": "failed", "note": "Changed." })));
        s.dress(&mut t, 1_000);
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"));
    }

    #[test]
    fn a_runner_that_never_shows_it_lets_the_box_go_after_a_while() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        s.started("t1", tok, Some("m1"), 1_000);
        let mut t = thread(None);
        s.dress(&mut t, 1_000 + SHOWN_AFTER_START_MS);
        assert!(t.moving.is_some(), "still within the wait");
        let mut t = thread(None);
        s.dress(&mut t, 1_001 + SHOWN_AFTER_START_MS);
        assert!(t.moving.is_none());
        assert!(!s.is_starting("t1"));
    }

    #[test]
    fn a_move_given_up_on_leaves_the_row_alone() {
        let mut s = StartingMoves::default();
        let _ = s.start("t1", "r-m5", "M5");
        s.forget("t1");
        let mut t = thread(None);
        s.dress(&mut t, 1_000);
        assert!(t.moving.is_none());
    }

    #[test]
    fn a_failure_before_the_move_answers_is_handed_back_once_its_id_is_known() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        let mut t = thread(Some(json!({ "moveId": "m1", "state": "failed", "note": "Changed." })));
        s.dress(&mut t, 1_000);
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"), "not known to be this move yet");
        let back = s.started("t1", tok, Some("m1"), 1_100).expect("this move failed");
        assert_eq!(back["note"], "Changed.");
        assert!(!s.is_starting("t1"));
    }

    #[test]
    fn a_cancelled_pick_is_no_longer_current() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        assert!(s.is_pending("t1"));
        assert!(s.cancel_pending("t1"));
        assert!(!s.is_current("t1", tok));
        assert_eq!(s.started("t1", tok, Some("m1"), 1_000), None);
        assert!(!s.is_starting("t1"), "a late answer doesn't bring it back");
        let (_, again) = s.start("t1", "r-m5", "M5");
        assert!(!s.is_current("t1", tok) && s.is_current("t1", again), "a new pick isn't the old one's");
    }

    #[test]
    fn the_wait_after_the_move_answers_ends_by_itself() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        assert!(!s.expire("t1", tok, 1_000), "not before the move has answered");
        s.started("t1", tok, Some("m1"), 1_000);
        assert!(!s.expire("t1", tok, 1_000 + SHOWN_AFTER_START_MS - 1));
        assert!(s.expire("t1", tok, 1_000 + SHOWN_AFTER_START_MS));
        assert!(!s.is_starting("t1"));
    }

    #[test]
    fn its_own_guess_coming_back_round_doesnt_count_as_the_runners_word() {
        let mut s = StartingMoves::default();
        let (guess, _) = s.start("t1", "r-m5", "M5");
        let mut t = thread(Some(guess));
        s.dress(&mut t, 1_000);
        assert!(s.is_starting("t1"));
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"));
    }

    #[test]
    fn the_runner_showing_the_move_first_is_no_cancel() {
        let mut s = StartingMoves::default();
        let (_, tok) = s.start("t1", "r-m5", "M5");
        // remoteThreads.updated with the move comes before threads.move's answer
        let mut t = thread(Some(json!({ "moveId": "m1", "to": "r-m5", "toName": "M5", "state": "asking" })));
        s.dress(&mut t, 1_000);
        assert!(!s.is_current("t1", tok), "the runner speaks for it now");
        assert!(!s.take_cancelled(tok), "but nobody cancelled it");
    }

    #[test]
    fn a_cancel_is_told_once_and_only_to_its_own_pick() {
        let mut s = StartingMoves::default();
        let (_, a) = s.start("t1", "r-m5", "M5");
        assert!(s.cancel_pending("t1"));
        let (_, b) = s.start("t1", "r-m5", "M5");
        assert!(!s.take_cancelled(b));
        assert!(s.take_cancelled(a));
        assert!(!s.take_cancelled(a));
        s.started("t1", b, Some("m2"), 1_000);
        assert!(!s.cancel_pending("t1"), "started: the runner's move is the one to cancel");
    }
}
