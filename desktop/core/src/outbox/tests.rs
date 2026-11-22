// The outbox: every state with every step, its deadlines, the old hold
// tests, the specs (features/sending.feature, connection.feature) and each
// error class as event sequences, and the old thread-locals kept as a
// reference (`legacy`) with the same sequences, and thousands of made-up
// ones, run through both. A broken transition fails that comparison
// (`a_broken_transition_is_caught`).
use super::*;
use crate::reducer::{EventPayload, Pending};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

thread_local! {
    /// A transition to break on purpose, to show the comparison catches it.
    static BROKEN: Cell<Option<(State, Step)>> = const { Cell::new(None) };
}

/// `State::next`, or a broken one while `BROKEN` says so: whatever state
/// and step it names leaves the message where it was.
pub(super) fn transition(state: State, step: Step, now: Instant) -> (Option<State>, Then) {
    let broken = BROKEN.with(Cell::get);
    let same = |a: State, b: State| std::mem::discriminant(&a) == std::mem::discriminant(&b);
    match broken {
        Some((s, st)) if same(s, state) && st == step => (Some(state), Then::Nothing),
        _ => state.next(step, now),
    }
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

type Draft = String;

fn send(thread: &str, text: &str) -> Send<Draft> {
    Send {
        thread: thread.into(),
        text: text.into(),
        images: Vec::new(),
        after_seq: 10,
        remote: false,
        holding: false,
        busy: false,
        draft: Some(format!("box:{text}")),
    }
}

fn sent(o: &mut Outbox<Draft>, s: Send<Draft>, now: Instant) -> (String, Ticket) {
    o.next(Event::Send(s), now)
        .ticket
        .unwrap_or_else(|| panic!("no ticket"))
}

fn user_message(thread: &str, seq: i64, text: &str) -> ThreadEvent {
    ThreadEvent::new(
        seq,
        "",
        thread,
        None,
        "user.message",
        EventPayload::UserMessage {
            text: text.into(),
            images: Vec::new(),
            origin: None,
            wake_reason: None,
            answers: Vec::new(),
            edit_of: None,
            review: None,
        },
    )
}

/// Every state with every step, from one moment: a Taken's own deadline is
/// a little after it, and one already passed for the Clock column's second
/// Taken row.
#[test]
fn every_state_with_every_step() {
    use State as S;
    let now = Instant::now() + Duration::from_secs(10);
    let later = now + ms(300);
    let past = now - ms(1);
    let states = [
        S::Waiting { held: false },
        S::Waiting { held: true },
        S::Sending,
        S::Shown,
        S::Taken {
            held: false,
            queue_at: later,
        },
        S::Taken {
            held: true,
            queue_at: past,
        },
        S::Queued,
    ];
    let steps = [
        Step::Held,
        Step::Going,
        Step::Dropped,
        Step::Answered(Answer::Took),
        Step::Answered(Answer::MayHaveArrived),
        Step::Answered(Answer::Refused),
        Step::Clock,
        Step::QueuedLost,
    ];
    let queue_at = now + QUEUE_DELAY;
    let w = |held| (Some(S::Waiting { held }), Then::Nothing);
    let to = |s| (Some(s), Then::Nothing);
    let taken = |held, queue_at| (Some(S::Taken { held, queue_at }), Then::Nothing);
    let gone = (None, Then::Nothing);
    let give_back = (None, Then::GiveBack);
    let shown = (Some(S::Shown), Then::CheckTaken);
    let expected: [[(Option<State>, Then); 8]; 7] = [
        [
            w(true),
            to(S::Sending),
            shown,
            taken(false, queue_at),
            give_back,
            give_back,
            w(false),
            w(false),
        ],
        [
            w(true),
            to(S::Sending),
            shown,
            taken(true, queue_at),
            give_back,
            give_back,
            w(true),
            w(true),
        ],
        [
            w(true),
            to(S::Sending),
            shown,
            taken(false, queue_at),
            give_back,
            give_back,
            to(S::Sending),
            to(S::Sending),
        ],
        [
            to(S::Shown),
            to(S::Shown),
            to(S::Shown),
            gone,
            gone,
            give_back,
            to(S::Shown),
            to(S::Shown),
        ],
        [
            taken(true, later),
            taken(false, later),
            (None, Then::CheckTaken),
            taken(false, later),
            taken(false, later),
            taken(false, later),
            // Not yet.
            taken(false, later),
            taken(false, later),
        ],
        [
            taken(true, past),
            taken(false, past),
            (None, Then::CheckTaken),
            taken(true, past),
            taken(true, past),
            taken(true, past),
            (Some(S::Queued), Then::CheckTaken),
            taken(true, past),
        ],
        [
            to(S::Queued),
            to(S::Queued),
            gone,
            to(S::Queued),
            to(S::Queued),
            to(S::Queued),
            to(S::Queued),
            gone,
        ],
    ];
    for (state, row) in states.iter().zip(expected.iter()) {
        for (step, want) in steps.iter().zip(row.iter()) {
            assert_eq!(&state.next(*step, now), want, "{state:?} with {step:?}");
        }
    }
}

#[test]
fn what_each_state_draws_and_when_it_moves() {
    let t = Instant::now();
    let cases = [
        (State::Waiting { held: false }, Some(Pending::Sending), None),
        (
            State::Waiting { held: true },
            Some(Pending::WaitingForRunner),
            None,
        ),
        (State::Sending, Some(Pending::Sending), None),
        (State::Shown, None, None),
        (
            State::Taken {
                held: false,
                queue_at: t,
            },
            Some(Pending::Sending),
            Some(t),
        ),
        (
            State::Taken {
                held: true,
                queue_at: t,
            },
            Some(Pending::WaitingForRunner),
            Some(t),
        ),
        (State::Queued, Some(Pending::Queued), None),
    ];
    for (state, bubble, deadline) in cases {
        assert_eq!(state.bubble(), bubble, "{state:?}");
        assert_eq!(state.deadline(), deadline, "{state:?}");
    }
}

/// gpui's thread.rs `hold_tests`, on the outbox.
mod holds {
    use super::*;

    #[test]
    fn on_this_macs_runner_only_a_summary_after_the_message_counts() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let (id, _) = sent(&mut o, send("t3", "hi"), t);
        // Opening the thread marked it seen, and that summary came after
        // the click: older news than the message, which this runner shows
        // before its own summary.
        o.next(
            Event::Summary {
                thread: "t3".into(),
            },
            t,
        );
        o.next(
            Event::Heard {
                thread: "t3".into(),
                event: user_message("t3", 11, "hi"),
            },
            t,
        );
        o.next(
            Event::Transcript {
                thread: "t3".into(),
                list: Vec::new(),
            },
            t,
        );
        assert_eq!(o.state_of(&id), Some(State::Shown));
        assert_eq!(o.sending(), vec!["t3".to_string()]);
    }

    #[test]
    fn a_message_taken_holds_only_if_the_runner_said_nothing_since_the_click() {
        let t = Instant::now();
        let mut o = Outbox::default();
        sent(&mut o, send("t2", "a"), t);
        o.next(
            Event::Transcript {
                thread: "t2".into(),
                list: Vec::new(),
            },
            t,
        );
        assert_eq!(o.sending(), vec!["t2".to_string()]);
        o.next(
            Event::Summary {
                thread: "t2".into(),
            },
            t,
        );
        assert!(o.sending().is_empty());
        // Another runner's "needs you" beat the message's own echo here:
        // that's its word already, so no hold hides it.
        let mut remote = send("t2", "b");
        remote.remote = true;
        sent(&mut o, remote, t);
        o.next(
            Event::Summary {
                thread: "t2".into(),
            },
            t,
        );
        o.next(
            Event::Transcript {
                thread: "t2".into(),
                list: Vec::new(),
            },
            t,
        );
        assert!(o.sending().is_empty());
    }

    #[test]
    fn a_taken_message_holds_its_thread_until_the_next_summary_or_its_grace() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let shown = |o: &mut Outbox<Draft>, at| {
            sent(o, send("t1", "x"), at);
            o.next(
                Event::Transcript {
                    thread: "t1".into(),
                    list: Vec::new(),
                },
                at,
            );
        };
        shown(&mut o, t);
        assert_eq!(o.deadline(), Some(t + HOLD_GRACE));
        // The runner's next word ends it, whatever it says.
        o.next(
            Event::Summary {
                thread: "t1".into(),
            },
            t + ms(10),
        );
        assert!(o.sending().is_empty());
        // An old hold's grace running out leaves a newer one be.
        shown(&mut o, t + ms(20));
        shown(&mut o, t + ms(3000));
        let fx = o.next(Event::Clock, t + HOLD_GRACE + ms(20));
        assert!(!fx.let_go);
        assert_eq!(o.sending(), vec!["t1".to_string()]);
        let fx = o.next(Event::Clock, t + ms(3000) + HOLD_GRACE);
        assert!(fx.let_go);
        assert!(o.sending().is_empty());
    }
}

/// The specs and each error class, as the events the app hears.
mod specs {
    use super::*;

    fn transcript(o: &mut Outbox<Draft>, thread: &str, t: Instant) {
        let list = o.pending(thread);
        o.next(
            Event::Transcript {
                thread: thread.into(),
                list,
            },
            t,
        );
    }

    fn landed(o: &mut Outbox<Draft>, thread: &str, id: &str, t: Instant) {
        let list = o
            .pending(thread)
            .into_iter()
            .filter(|p| p.id != id)
            .collect();
        o.next(
            Event::Transcript {
                thread: thread.into(),
                list,
            },
            t,
        );
    }

    fn bubbles(o: &Outbox<Draft>, thread: &str) -> Vec<(String, Option<Pending>)> {
        o.pending(thread)
            .into_iter()
            .map(|p| {
                let b = if p.waiting_for_runner {
                    Pending::WaitingForRunner
                } else if p.queued {
                    Pending::Queued
                } else {
                    Pending::Sending
                };
                (p.text, Some(b))
            })
            .collect()
    }

    /// "Return sends what I typed": a spinner by its bubble until the
    /// runner's echo, the thread under Running until its summary.
    #[test]
    fn return_sends_what_i_typed() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let (id, ticket) = sent(&mut o, send("m", "Can you check the backups?"), t);
        assert!(ticket.was_idle);
        assert!(ticket.gate.still_to_go());
        assert_eq!(
            bubbles(&o, "m"),
            vec![("Can you check the backups?".into(), Some(Pending::Sending))]
        );
        assert_eq!(o.sending(), vec!["m".to_string()]);
        o.next(
            Event::Progress {
                id: id.clone(),
                still_to_go: false,
            },
            t,
        );
        ticket.gate.set(false);
        assert!(o.sending_now("m"));
        landed(&mut o, "m", &id, t + ms(50));
        assert!(o.pending("m").is_empty());
        assert_eq!(o.sending(), vec!["m".to_string()]);
        let fx = o.next(
            Event::Answered {
                id: id.clone(),
                answer: Answer::Took,
            },
            t + ms(60),
        );
        assert!(fx.gave_back.is_none());
        assert_eq!(o.state_of(&id), None);
        assert!(!o.sending_now("m"));
        o.next(Event::Summary { thread: "m".into() }, t + ms(100));
        assert!(o.sending().is_empty());
        assert_eq!(o.deadline(), None);
    }

    /// "A message the runner holds behind a turn says it's queued until
    /// it lands".
    #[test]
    fn a_message_behind_a_turn_is_queued_until_it_lands() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let mut s = send("m", "Check the logs too");
        s.busy = true;
        let (id, ticket) = sent(&mut o, s, t);
        assert!(!ticket.was_idle);
        o.next(
            Event::Progress {
                id: id.clone(),
                still_to_go: false,
            },
            t,
        );
        o.next(
            Event::Answered {
                id: id.clone(),
                answer: Answer::Took,
            },
            t + ms(20),
        );
        // A moment before it's called queued: no clock flashing up.
        assert_eq!(o.deadline(), Some(t + ms(20) + QUEUE_DELAY));
        assert_eq!(bubbles(&o, "m")[0].1, Some(Pending::Sending));
        let fx = o.next(Event::Clock, t + ms(20) + QUEUE_DELAY);
        assert_eq!(fx.moved, vec!["m".to_string()]);
        assert_eq!(bubbles(&o, "m")[0].1, Some(Pending::Queued));
        // Taken with no word since the click: held under Running until the
        // summary, then a queued one alone doesn't keep it there.
        assert_eq!(o.sending(), vec!["m".to_string()]);
        o.next(Event::Summary { thread: "m".into() }, t + ms(700));
        assert!(o.sending().is_empty());
        landed(&mut o, "m", &id, t + Duration::from_secs(4));
        assert!(o.pending("m").is_empty());
        assert!(o.sending().is_empty());
    }

    /// A second message while one is on its way isn't idle, so a restart
    /// can't send it twice on a guess.
    #[test]
    fn a_second_message_on_its_way_is_never_idle() {
        let t = Instant::now();
        let mut o = Outbox::default();
        sent(&mut o, send("m", "one"), t);
        let (_, second) = sent(&mut o, send("m", "two"), t);
        assert!(!second.was_idle);
        // Another thread's message is no matter.
        let (_, other) = sent(&mut o, send("n", "three"), t);
        assert!(other.was_idle);
    }

    /// A queued one counts too: the runner has it.
    #[test]
    fn a_queued_message_makes_the_next_not_idle() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let (id, _) = sent(&mut o, send("m", "one"), t);
        o.next(
            Event::Answered {
                id,
                answer: Answer::Took,
            },
            t,
        );
        o.next(Event::Clock, t + QUEUE_DELAY);
        let (_, next) = sent(&mut o, send("m", "two"), t + ms(700));
        assert!(!next.was_idle);
    }

    /// "A message sent while the runner restarts waits for it and goes
    /// once it's back", shown just once.
    #[test]
    fn a_message_sent_while_the_runner_restarts_waits() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let mut s = send("m", "Check the backups once you're back");
        s.holding = true;
        let (id, ticket) = sent(&mut o, s, t);
        assert_eq!(bubbles(&o, "m")[0].1, Some(Pending::WaitingForRunner));
        o.next(
            Event::Progress {
                id: id.clone(),
                still_to_go: true,
            },
            t,
        );
        // Quit now: its words are kept, as it hasn't gone.
        assert_eq!(
            o.held_drafts("m"),
            vec![&"box:Check the backups once you're back".to_string()]
        );
        assert!(!o.sending_now("m"));
        ticket.gate.set(false);
        o.next(
            Event::Progress {
                id: id.clone(),
                still_to_go: false,
            },
            t + Duration::from_secs(12),
        );
        assert!(o.held_drafts("m").is_empty());
        assert_eq!(bubbles(&o, "m")[0].1, Some(Pending::Sending));
        landed(&mut o, "m", &id, t + Duration::from_secs(13));
        o.next(
            Event::Answered {
                id: id.clone(),
                answer: Answer::Took,
            },
            t + Duration::from_secs(13),
        );
        assert!(o.pending("m").is_empty());
        assert_eq!(o.state_of(&id), None);
    }

    /// Each way a send can fail, before its echo: its words go back in the
    /// box. Not connected, closed on its way, no answer in time, the
    /// restarting runner's "Thread not found", busy: the client has already
    /// sent again whatever was safe to.
    #[test]
    fn each_failure_before_the_echo_gives_the_words_back() {
        for answer in [Answer::MayHaveArrived, Answer::Refused] {
            let t = Instant::now();
            let mut o = Outbox::default();
            let (id, _) = sent(&mut o, send("m", "Are the backups done?"), t);
            let fx = o.next(
                Event::Answered {
                    id: id.clone(),
                    answer,
                },
                t,
            );
            assert_eq!(fx.gave_back, Some(Some("box:Are the backups done?".into())));
            assert!(o.pending("m").is_empty());
            assert!(o.sending().is_empty());
            assert_eq!(o.deadline(), None);
        }
    }

    /// Shown already, as the runner echoed it: it went, whatever became of
    /// a closed connection's or a stalled runner's answer.
    #[test]
    fn a_lost_answer_after_the_echo_is_no_failure() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let (id, _) = sent(&mut o, send("m", "x"), t);
        landed(&mut o, "m", &id, t);
        let fx = o.next(
            Event::Answered {
                id,
                answer: Answer::MayHaveArrived,
            },
            t,
        );
        assert!(fx.gave_back.is_none());
    }

    /// A message held for a restart that never came back, or one the app's
    /// quit stopped: its words come back.
    #[test]
    fn a_held_message_whose_runner_never_came_back() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let mut s = send("m", "x");
        s.holding = true;
        let (id, _) = sent(&mut o, s, t);
        let fx = o.next(
            Event::Answered {
                id,
                answer: Answer::Refused,
            },
            t + Duration::from_secs(90),
        );
        assert_eq!(fx.gave_back, Some(Some("box:x".into())));
    }

    /// The connection drops and comes back mid-send: the client holds it
    /// and says so, then sends it; the bubble follows.
    #[test]
    fn the_connection_drops_and_returns_mid_send() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let (id, ticket) = sent(&mut o, send("m", "x"), t);
        for (still, bubble) in [
            (false, Pending::Sending),
            (true, Pending::WaitingForRunner),
            (false, Pending::Sending),
        ] {
            ticket.gate.set(still);
            o.next(
                Event::Progress {
                    id: id.clone(),
                    still_to_go: still,
                },
                t,
            );
            assert_eq!(bubbles(&o, "m")[0].1, Some(bubble));
        }
    }

    /// An edit drops what's queued behind it; an idle thread lets a lost
    /// queued one go.
    #[test]
    fn queued_messages_go_with_an_edit_or_an_idle_thread() {
        let t = Instant::now();
        let mut o = Outbox::default();
        for text in ["a", "b"] {
            let (id, _) = sent(&mut o, send("m", text), t);
            o.next(
                Event::Answered {
                    id,
                    answer: Answer::Took,
                },
                t,
            );
        }
        o.next(Event::Clock, t + QUEUE_DELAY);
        let (fresh, _) = sent(&mut o, send("m", "c"), t + ms(700));
        // The transcript's edit drops the queued ones only.
        let list = o.pending("m").into_iter().filter(|p| !p.queued).collect();
        o.next(
            Event::Transcript {
                thread: "m".into(),
                list,
            },
            t + ms(800),
        );
        assert_eq!(o.pending("m").len(), 1);
        assert_eq!(o.state_of(&fresh), Some(State::Waiting { held: false }));
        // Idle a while with one queued: let go; the one on its way stays.
        o.next(
            Event::Answered {
                id: fresh,
                answer: Answer::Took,
            },
            t + ms(900),
        );
        o.next(Event::Clock, t + ms(1500));
        o.next(Event::QueuedLost { thread: "m".into() }, t + ms(12_000));
        assert!(o.pending("m").is_empty());
    }

    /// Another runner's thread: sent through Convex, never held, so never
    /// in the drafts file; a slower answer is the same.
    #[test]
    fn another_runners_thread() {
        let t = Instant::now();
        let mut o = Outbox::default();
        let mut s = send("r", "x");
        s.remote = true;
        let (id, ticket) = sent(&mut o, s, t);
        assert!(!ticket.gate.still_to_go());
        assert_eq!(o.state_of(&id), Some(State::Sending));
        assert!(o.held_drafts("r").is_empty());
        assert!(o.sending_now("r"));
        transcript(&mut o, "r", t);
        assert_eq!(o.state_of(&id), Some(State::Sending));
    }

    /// The thread open in two places at once keeps one outbox: the second
    /// pane is given the same messages.
    #[test]
    fn the_same_messages_for_every_pane() {
        let t = Instant::now();
        let mut o = Outbox::default();
        sent(&mut o, send("m", "x"), t);
        transcript(&mut o, "m", t);
        transcript(&mut o, "m", t);
        assert_eq!(o.pending("m").len(), 1);
    }
}

/// The app's outbox before this (gpui's thread.rs at be2bd56fa: OUTBOX,
/// OUTBOX_CHANGES, AWAITING, HOLDS, SUMMARIES, SENT_AT, OUTBOX_DRAFTS, the
/// AtomicBool `held`, and `send_message`'s task), kept to run the same
/// sequences through both. Its timers (a hold's grace, the wait before
/// "queued") are kept as a list, fired by `wait`.
mod legacy {
    use super::*;
    use std::sync::atomic::AtomicBool;

    pub enum Timer {
        Grace { thread: String, n: u64 },
        Queue { thread: String, id: String },
    }

    #[derive(Default)]
    pub struct Legacy {
        outbox: HashMap<String, Vec<PendingMessage>>,
        awaiting: HashMap<String, u64>,
        holds: u64,
        summaries: HashMap<String, u64>,
        sent_at: HashMap<String, u64>,
        drafts: HashMap<String, (String, Draft, Arc<AtomicBool>)>,
        next: u64,
        pub timers: Vec<(Instant, Timer)>,
    }

    impl Legacy {
        pub fn outbox(&self, thread: &str) -> Vec<PendingMessage> {
            self.outbox.get(thread).cloned().unwrap_or_default()
        }

        fn set_outbox(&mut self, thread: &str, list: Vec<PendingMessage>) {
            if list.is_empty() {
                self.outbox.remove(thread);
            } else {
                self.outbox.insert(thread.to_owned(), list);
            }
        }

        pub fn sending(&self) -> Vec<String> {
            let mut ids: Vec<String> = self
                .outbox
                .iter()
                .filter(|(_, list)| list.iter().any(|m| !m.queued))
                .map(|(id, _)| id.clone())
                .collect();
            ids.extend(
                self.awaiting
                    .keys()
                    .filter(|id| !ids.contains(id))
                    .cloned()
                    .collect::<Vec<_>>(),
            );
            ids
        }

        fn summaries_of(&self, thread: &str) -> u64 {
            self.summaries.get(thread).copied().unwrap_or(0)
        }

        pub fn shown_here(&mut self, thread: &str, pending_id: &str) {
            let now = self.summaries_of(thread);
            if let Some(at) = self.sent_at.get_mut(pending_id) {
                *at = now;
            }
        }

        fn taken(&mut self, thread: &str, pending_id: &str) -> bool {
            let now = self.summaries_of(thread);
            self.sent_at.remove(pending_id).is_some_and(|at| at == now)
        }

        pub fn summary_arrived(&mut self, thread: &str) {
            *self.summaries.entry(thread.to_owned()).or_default() += 1;
            self.awaiting.remove(thread);
        }

        fn hold_for_summary(&mut self, thread: &str, now: Instant) {
            self.holds += 1;
            let n = self.holds;
            self.awaiting.insert(thread.to_owned(), n);
            self.timers.push((
                now + HOLD_GRACE,
                Timer::Grace {
                    thread: thread.to_owned(),
                    n,
                },
            ));
        }

        fn let_go(&mut self, thread: &str, n: u64) -> bool {
            let ours = self.awaiting.get(thread) == Some(&n);
            if ours {
                self.awaiting.remove(thread);
            }
            ours
        }

        pub fn held_drafts(&self, thread: &str) -> Vec<Draft> {
            self.outbox(thread)
                .iter()
                .filter_map(|m| {
                    self.drafts
                        .get(&m.id)
                        .filter(|(t, _, held)| t == thread && held.load(Ordering::SeqCst))
                        .map(|(_, d, _)| d.clone())
                })
                .collect()
        }

        pub fn sending_now(&self, thread: &str) -> bool {
            self.drafts
                .values()
                .any(|(t, _, held)| t == thread && !held.load(Ordering::SeqCst))
        }

        /// `keep_outbox`, with the model's list.
        pub fn keep_outbox(&mut self, thread: &str, list: Vec<PendingMessage>, now: Instant) {
            let shown: Vec<String> = self
                .outbox(thread)
                .into_iter()
                .filter(|m| !m.queued && !list.iter().any(|n| n.id == m.id))
                .map(|m| m.id)
                .collect();
            let mut hold = false;
            for id in &shown {
                hold |= self.taken(thread, id);
            }
            if hold {
                self.hold_for_summary(thread, now);
            }
            self.set_outbox(thread, list);
        }

        /// `send_message`'s part before the task: the id, `was_idle`, and
        /// the gate the progress sets.
        pub fn send(&mut self, s: &Send<Draft>) -> (String, bool, Arc<AtomicBool>) {
            self.next += 1;
            let id = format!("local-{}", self.next);
            let mut message = PendingMessage::new(&id, &s.text, s.after_seq);
            message.images = s.images.clone();
            message.waiting_for_runner = s.holding;
            let mut list = self.outbox(&s.thread);
            list.push(message);
            let was_idle = !s.busy && list.len() == 1;
            self.set_outbox(&s.thread, list);
            let held = Arc::new(AtomicBool::new(!s.remote));
            if let Some(d) = &s.draft {
                self.drafts
                    .insert(id.clone(), (s.thread.clone(), d.clone(), held.clone()));
            }
            let at = self.summaries_of(&s.thread);
            self.sent_at.insert(id.clone(), at);
            (id, was_idle, held)
        }

        /// The task's `SendStep::Progress`.
        pub fn progress(&mut self, thread: &str, id: &str, held: bool) {
            let mut list = self.outbox(thread);
            if let Some(m) = list.iter_mut().find(|m| m.id == id) {
                m.waiting_for_runner = held;
            }
            self.set_outbox(thread, list);
        }

        /// The task's `SendStep::Done`: the draft given back, if it failed.
        pub fn done(
            &mut self,
            thread: &str,
            id: &str,
            answer: Answer,
            now: Instant,
        ) -> Option<Option<Draft>> {
            let draft = self.drafts.remove(id).map(|(_, d, _)| d);
            let shown = !self.outbox(thread).iter().any(|m| m.id == id);
            if shown && answer == Answer::MayHaveArrived {
                self.sent_at.remove(id);
                return None;
            }
            if answer != Answer::Took {
                self.sent_at.remove(id);
                let mut list = self.outbox(thread);
                list.retain(|m| m.id != id);
                self.set_outbox(thread, list);
                return Some(draft);
            }
            self.timers.push((
                now + QUEUE_DELAY,
                Timer::Queue {
                    thread: thread.to_owned(),
                    id: id.to_owned(),
                },
            ));
            None
        }

        /// A timer whose time has come: the threads to show again.
        pub fn fire(&mut self, timer: Timer, now: Instant) -> Option<String> {
            match timer {
                Timer::Grace { thread, n } => {
                    self.let_go(&thread, n);
                    None
                }
                Timer::Queue { thread, id } => {
                    let unshown = self.outbox(&thread).iter().any(|m| m.id == id && !m.queued);
                    if unshown && self.taken(&thread, &id) {
                        self.hold_for_summary(&thread, now);
                    }
                    let mut list = self.outbox(&thread);
                    if let Some(m) = list.iter_mut().find(|m| m.id == id) {
                        m.queued = true;
                        m.waiting_for_runner = false;
                    }
                    self.set_outbox(&thread, list);
                    Some(thread)
                }
            }
        }

        /// `check_queued`'s grace run out.
        pub fn queued_lost(&mut self, thread: &str) {
            let mut list = self.outbox(thread);
            list.retain(|m| !m.queued);
            self.set_outbox(thread, list);
        }
    }
}

/// One side of the comparison: an outbox and a pane per open thread with
/// its transcript's list of messages on their way (the model's `pending`),
/// as thread.rs drives them.
trait Side {
    fn pending(&self, thread: &str) -> Vec<PendingMessage>;
    fn transcript(&mut self, thread: &str, list: Vec<PendingMessage>, now: Instant);
}

impl Side for legacy::Legacy {
    fn pending(&self, thread: &str) -> Vec<PendingMessage> {
        self.outbox(thread)
    }
    fn transcript(&mut self, thread: &str, list: Vec<PendingMessage>, now: Instant) {
        self.keep_outbox(thread, list, now);
    }
}

impl Side for Outbox<Draft> {
    fn pending(&self, thread: &str) -> Vec<PendingMessage> {
        Outbox::pending(self, thread)
    }
    fn transcript(&mut self, thread: &str, list: Vec<PendingMessage>, now: Instant) {
        self.next(
            Event::Transcript {
                thread: thread.into(),
                list,
            },
            now,
        );
    }
}

/// A pane's transcript: the messages it's been given, less those whose
/// `user.message` it holds (`landed`), less queued ones an edit cut.
#[derive(Default)]
struct Panes {
    open: HashMap<String, Vec<PendingMessage>>,
}

impl Panes {
    /// `show_outbox`: the outbox's list into the model, then `keep_outbox`.
    fn show<S: Side>(
        &mut self,
        side: &mut S,
        thread: &str,
        landed: &HashSet<String>,
        now: Instant,
    ) {
        let Some(model) = self.open.get_mut(thread) else {
            return;
        };
        *model = side
            .pending(thread)
            .into_iter()
            .filter(|m| !landed.contains(&m.id))
            .collect();
        let list = model.clone();
        side.transcript(thread, list, now);
    }

    /// The model took something out (an event landing a message, an edit),
    /// then `apply`'s `keep_outbox`.
    fn take<S: Side>(
        &mut self,
        side: &mut S,
        thread: &str,
        out: impl Fn(&PendingMessage) -> bool,
        now: Instant,
    ) {
        let Some(model) = self.open.get_mut(thread) else {
            return;
        };
        model.retain(|m| !out(m));
        let list = model.clone();
        side.transcript(thread, list, now);
    }
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Wait(u64),
    /// Send on thread `.0`: busy, remote, holding, with a draft.
    Send(u8, bool, bool, bool, bool),
    /// The client's word on the `.0`th message sent: held or going.
    Progress(usize, bool),
    Answered(usize, Answer),
    /// The `.0`th message's `user.message` comes, live.
    Land(usize),
    Summary(u8),
    /// An edit on the thread: the transcript drops what's queued.
    Rewind(u8),
    /// The thread sat idle with one queued.
    QueuedLost(u8),
    Open(u8),
    Close(u8),
}

struct Msg {
    thread: String,
    old_id: String,
    new_id: String,
    remote: bool,
    old_gate: Arc<std::sync::atomic::AtomicBool>,
    new_gate: Gate,
    answered: bool,
}

struct Both {
    now: Instant,
    old: legacy::Legacy,
    new: Outbox<Draft>,
    old_panes: Panes,
    new_panes: Panes,
    msgs: Vec<Msg>,
    /// Each side's ids of the messages whose `user.message` the thread has.
    old_landed: HashSet<String>,
    new_landed: HashSet<String>,
    sent: u64,
}

const THREADS: [&str; 2] = ["a", "b"];

impl Both {
    fn new() -> Both {
        Both {
            now: Instant::now(),
            old: legacy::Legacy::default(),
            new: Outbox::default(),
            old_panes: Panes::default(),
            new_panes: Panes::default(),
            msgs: Vec::new(),
            old_landed: HashSet::new(),
            new_landed: HashSet::new(),
            sent: 0,
        }
    }

    fn show(&mut self, thread: &str) {
        self.old_panes
            .show(&mut self.old, thread, &self.old_landed, self.now);
        self.new_panes
            .show(&mut self.new, thread, &self.new_landed, self.now);
    }

    fn wait(&mut self, ms_: u64) {
        let until = self.now + ms(ms_);
        loop {
            let old_next = self.old.timers.iter().map(|(at, _)| *at).min();
            let new_next = self.new.deadline();
            let next = match (old_next, new_next) {
                (Some(a), Some(b)) => a.min(b),
                (a, b) => match a.or(b) {
                    Some(at) => at,
                    None => break,
                },
            };
            if next > until {
                break;
            }
            self.now = next.max(self.now);
            // The old side's timers due now, in the order they were set.
            let mut i = 0;
            while i < self.old.timers.len() {
                if self.old.timers[i].0 <= self.now {
                    let (_, timer) = self.old.timers.remove(i);
                    if let Some(thread) = self.old.fire(timer, self.now) {
                        self.old_panes
                            .show(&mut self.old, &thread, &self.old_landed, self.now);
                    }
                } else {
                    i += 1;
                }
            }
            if self.new.deadline().is_some_and(|at| at <= self.now) {
                let fx = self.new.next(Event::Clock, self.now);
                for thread in fx.moved {
                    self.new_panes
                        .show(&mut self.new, &thread, &self.new_landed, self.now);
                }
            }
            self.compare("a timer");
        }
        self.now = until;
    }

    fn step(&mut self, op: Op) {
        match op {
            Op::Wait(n) => self.wait(n),
            Op::Send(t, busy, remote, holding, draft) => {
                let thread = THREADS[t as usize].to_owned();
                self.sent += 1;
                let s = Send {
                    thread: thread.clone(),
                    text: format!("m{}", self.sent),
                    images: Vec::new(),
                    after_seq: 10,
                    remote,
                    holding: holding && !remote,
                    busy,
                    draft: draft.then(|| format!("box{}", self.sent)),
                };
                let (old_id, was_idle, old_gate) = self.old.send(&s);
                let fx = self.new.next(Event::Send(s), self.now);
                let Some((new_id, ticket)) = fx.ticket else {
                    panic!("no ticket")
                };
                assert_eq!(ticket.was_idle, was_idle, "was_idle differs");
                self.msgs.push(Msg {
                    thread: thread.clone(),
                    old_id,
                    new_id,
                    remote,
                    old_gate,
                    new_gate: ticket.gate,
                    answered: false,
                });
                self.show(&thread);
            }
            Op::Progress(i, held) => {
                let Some(m) = self.msgs.get(i) else { return };
                // Only this Mac's runner's, and only before the answer.
                if m.remote || m.answered {
                    return;
                }
                let thread = m.thread.clone();
                m.old_gate.store(held, Ordering::SeqCst);
                m.new_gate.set(held);
                let (old_id, new_id) = (m.old_id.clone(), m.new_id.clone());
                self.old.progress(&thread, &old_id, held);
                self.new.next(
                    Event::Progress {
                        id: new_id,
                        still_to_go: held,
                    },
                    self.now,
                );
                self.show(&thread);
            }
            Op::Answered(i, answer) => {
                let Some(m) = self.msgs.get_mut(i) else {
                    return;
                };
                if m.answered {
                    return;
                }
                m.answered = true;
                let thread = m.thread.clone();
                let (old_id, new_id) = (m.old_id.clone(), m.new_id.clone());
                let old = self.old.done(&thread, &old_id, answer, self.now);
                let fx = self
                    .new
                    .next(Event::Answered { id: new_id, answer }, self.now);
                assert_eq!(fx.gave_back, old, "what's given back differs");
                if old.is_some() {
                    self.show(&thread);
                }
            }
            Op::Land(i) => {
                let Some(m) = self.msgs.get(i) else { return };
                let (thread, old_id, new_id, remote) = (
                    m.thread.clone(),
                    m.old_id.clone(),
                    m.new_id.clone(),
                    m.remote,
                );
                if self.old_landed.contains(&old_id) {
                    return;
                }
                self.old_landed.insert(old_id.clone());
                self.new_landed.insert(new_id.clone());
                let seq = 100 + i as i64;
                let event = user_message(&thread, seq, &format!("m{}", i + 1));
                // `event`: this Mac's runner's echo moves the click on.
                if !remote && self.old_panes.open.contains_key(&thread) {
                    for p in self.old.outbox(&thread) {
                        if !p.queued && p.is_landed_by(&event) {
                            self.old.shown_here(&thread, &p.id);
                        }
                    }
                    self.new.next(
                        Event::Heard {
                            thread: thread.clone(),
                            event,
                        },
                        self.now,
                    );
                }
                self.old_panes
                    .take(&mut self.old, &thread, |p| p.id == old_id, self.now);
                self.new_panes
                    .take(&mut self.new, &thread, |p| p.id == new_id, self.now);
            }
            Op::Summary(t) => {
                let thread = THREADS[t as usize];
                self.old.summary_arrived(thread);
                self.new.next(
                    Event::Summary {
                        thread: thread.into(),
                    },
                    self.now,
                );
            }
            Op::Rewind(t) => {
                let thread = THREADS[t as usize];
                self.old_panes
                    .take(&mut self.old, thread, |p| p.queued, self.now);
                self.new_panes
                    .take(&mut self.new, thread, |p| p.queued, self.now);
            }
            Op::QueuedLost(t) => {
                let thread = THREADS[t as usize];
                // Only a pane's check, and only with one queued.
                let Some(model) = self.old_panes.open.get(thread) else {
                    return;
                };
                if !model.iter().any(|m| m.queued) {
                    return;
                }
                self.old.queued_lost(thread);
                self.new.next(
                    Event::QueuedLost {
                        thread: thread.into(),
                    },
                    self.now,
                );
                self.show(thread);
            }
            Op::Open(t) => {
                let thread = THREADS[t as usize];
                if self.old_panes.open.contains_key(thread) {
                    return;
                }
                self.old_panes.open.insert(thread.into(), Vec::new());
                self.new_panes.open.insert(thread.into(), Vec::new());
                self.show(thread);
            }
            Op::Close(t) => {
                let thread = THREADS[t as usize];
                self.old_panes.open.remove(thread);
                self.new_panes.open.remove(thread);
            }
        }
    }

    /// The new side's id for the old side's.
    fn new_id(&self, old: &str) -> String {
        self.msgs
            .iter()
            .find(|m| m.old_id == old)
            .map(|m| m.new_id.clone())
            .unwrap_or_default()
    }

    fn compare(&self, after: &str) {
        for thread in THREADS {
            let old: Vec<(String, String, bool, bool)> = self
                .old
                .outbox(thread)
                .into_iter()
                .map(|m| (self.new_id(&m.id), m.text, m.queued, m.waiting_for_runner))
                .collect();
            let new: Vec<(String, String, bool, bool)> = self
                .new
                .pending(thread)
                .into_iter()
                .map(|m| (m.id, m.text, m.queued, m.waiting_for_runner))
                .collect();
            assert_eq!(new, old, "{thread}'s messages differ after {after}");
            assert_eq!(
                self.new.held_drafts(thread),
                self.old.held_drafts(thread).iter().collect::<Vec<_>>(),
                "{thread}'s held drafts differ after {after}"
            );
            assert_eq!(
                self.new.sending_now(thread),
                self.old.sending_now(thread),
                "{thread}'s sending_now differs after {after}"
            );
        }
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        assert_eq!(
            sorted(self.new.sending()),
            sorted(self.old.sending()),
            "the sidebar's Running differs after {after}"
        );
    }
}

fn run(ops: &[Op]) {
    let mut both = Both::new();
    for (i, op) in ops.iter().enumerate() {
        both.step(*op);
        both.compare(&format!("step {i} ({op:?}) of {ops:?}"));
    }
}

/// The specs' sequences, old and new.
#[test]
fn old_and_new_say_the_same_for_the_spec_sequences() {
    use Op::*;
    // Return sends; the echo, then the answer, then the summary.
    run(&[
        Open(0),
        Send(0, false, false, false, true),
        Progress(0, false),
        Wait(50),
        Land(0),
        Answered(0, Answer::Took),
        Wait(100),
        Summary(0),
        Wait(6000),
    ]);
    // Queued behind a turn, lands four seconds later.
    run(&[
        Open(0),
        Send(0, true, false, false, true),
        Progress(0, false),
        Answered(0, Answer::Took),
        Wait(700),
        Summary(0),
        Wait(4000),
        Land(0),
        Summary(0),
    ]);
    // Sent while the runner restarts: held, goes, shown once.
    run(&[
        Open(0),
        Send(0, false, false, true, true),
        Progress(0, true),
        Wait(12_000),
        Progress(0, false),
        Land(0),
        Answered(0, Answer::Took),
        Wait(6000),
    ]);
    // Each failure, before and after the echo.
    for answer in [Answer::MayHaveArrived, Answer::Refused] {
        run(&[
            Open(0),
            Send(0, false, false, false, true),
            Progress(0, false),
            Answered(0, answer),
        ]);
        run(&[
            Open(0),
            Send(0, false, false, false, true),
            Progress(0, false),
            Land(0),
            Answered(0, answer),
        ]);
    }
    // The thread closed while its message goes, opened again later.
    run(&[
        Open(0),
        Send(0, false, false, false, true),
        Close(0),
        Progress(0, false),
        Land(0),
        Answered(0, Answer::Took),
        Wait(700),
        Open(0),
        Wait(6000),
    ]);
    // Another runner's thread, whose summary beats its transcript.
    run(&[
        Open(1),
        Send(1, false, true, false, true),
        Summary(1),
        Land(0),
        Answered(0, Answer::Took),
        Wait(700),
    ]);
    // Two queued, an edit, an idle thread.
    run(&[
        Open(0),
        Send(0, true, false, false, true),
        Answered(0, Answer::Took),
        Send(0, true, false, false, false),
        Answered(1, Answer::Took),
        Wait(700),
        Rewind(0),
        Send(0, false, false, false, true),
        Answered(2, Answer::Took),
        Wait(700),
        QueuedLost(0),
    ]);
}

fn made_up(count: usize, seed: u64) -> Vec<Vec<Op>> {
    // A small fixed generator, so a failure is the same every run.
    let mut seed = seed;
    let mut next = move |n: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let waits = [10, 300, 599, 600, 601, 1000, 4999, 5000, 6000];
    let answers = [
        Answer::Took,
        Answer::Took,
        Answer::Took,
        Answer::MayHaveArrived,
        Answer::Refused,
    ];
    (0..count)
        .map(|_| {
            let len = 4 + next(28) as usize;
            let mut sent = 0usize;
            (0..len)
                .map(|_| {
                    let t = next(2) as u8;
                    let msg =
                        |n: &mut dyn FnMut(u64) -> u64, sent: usize| n(sent.max(1) as u64) as usize;
                    match next(16) {
                        0 | 1 => Op::Wait(waits[next(waits.len() as u64) as usize]),
                        2 | 3 => {
                            sent += 1;
                            Op::Send(t, next(2) == 0, next(4) == 0, next(3) == 0, next(4) != 0)
                        }
                        4 | 5 => Op::Progress(msg(&mut next, sent), next(2) == 0),
                        6 | 7 => Op::Answered(
                            msg(&mut next, sent),
                            answers[next(answers.len() as u64) as usize],
                        ),
                        8 | 9 => Op::Land(msg(&mut next, sent)),
                        10 | 11 => Op::Summary(t),
                        12 => Op::Rewind(t),
                        13 => Op::QueuedLost(t),
                        14 => Op::Open(t),
                        _ => Op::Close(t),
                    }
                })
                .collect()
        })
        .collect()
}

/// Thousands of made-up sequences, old and new.
#[test]
fn old_and_new_say_the_same_for_made_up_sequences() {
    for ops in made_up(4000, 0x0b0c_5eed) {
        run(&ops);
    }
}

/// The comparison fails if a transition is wrong: here a message whose
/// echo came stays on its way, and one refused after its echo keeps its
/// words.
#[test]
fn a_broken_transition_is_caught() {
    for broken in [
        (State::Sending, Step::Dropped),
        (State::Shown, Step::Answered(Answer::Refused)),
        (
            State::Taken {
                held: false,
                queue_at: Instant::now(),
            },
            Step::Clock,
        ),
    ] {
        BROKEN.with(|b| b.set(Some(broken)));
        let caught = std::panic::catch_unwind(|| {
            for ops in made_up(4000, 0x0b0c_5eed) {
                run(&ops);
            }
        });
        BROKEN.with(|b| b.set(None));
        assert!(caught.is_err(), "breaking {broken:?} wasn't caught");
    }
}

/// The sidebar's cache goes by `changes`: every line streamed in from this
/// Mac's runner is heard, and none of it may sort every thread again.
#[test]
fn only_what_the_sidebar_reads_counts_as_a_change() {
    let t = Instant::now();
    let mut o = Outbox::default();
    let (id, _) = sent(&mut o, send("m", "x"), t);
    let before = o.changes();
    o.next(
        Event::Heard {
            thread: "m".into(),
            event: user_message("m", 11, "x"),
        },
        t,
    );
    o.next(Event::Summary { thread: "m".into() }, t);
    o.next(
        Event::Transcript {
            thread: "m".into(),
            list: o.pending("m"),
        },
        t,
    );
    o.next(Event::Clock, t);
    assert_eq!(o.changes(), before);
    o.next(
        Event::Progress {
            id,
            still_to_go: true,
        },
        t,
    );
    assert!(o.changes() > before);
}
