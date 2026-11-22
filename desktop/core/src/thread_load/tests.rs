// The load state: every state with every event, what each draws, the specs
// (switching-threads.feature, connection.feature's load failure) as event
// sequences, and the old fields kept as a reference (`legacy`) with those
// sequences and thousands of made-up ones run through both. A broken
// transition fails that comparison (`a_broken_transition_is_caught`).
use super::*;
use std::cell::Cell;

thread_local! {
    /// A transition to break on purpose, to show the comparison catches it.
    static BROKEN: Cell<Option<(u8, u8)>> = const { Cell::new(None) };
}

fn state_kind(l: &ThreadLoad) -> u8 {
    match l {
        ThreadLoad::Reading { .. } => 0,
        ThreadLoad::Failed { .. } => 1,
        ThreadLoad::NoRecord => 2,
        ThreadLoad::Shown { .. } => 3,
    }
}

fn event_kind(e: &Event) -> u8 {
    match e {
        Event::Read => 0,
        Event::TryAgain => 1,
        Event::ReadFailed { .. } => 2,
        Event::NoRecord => 3,
        Event::Landed => 4,
        Event::Subscribed => 5,
        Event::SubscribeFailed => 6,
        Event::ConnectionBack => 7,
        Event::ShownAgain => 8,
    }
}

/// `ThreadLoad::next`, or a broken one while `BROKEN` says so: that state
/// and event leave it where it was.
fn transition(l: ThreadLoad, e: Event) -> (ThreadLoad, Then) {
    match BROKEN.with(Cell::get) {
        Some((s, ev)) if s == state_kind(&l) && ev == event_kind(&e) => (l, Then::Nothing),
        _ => l.next(e),
    }
}

fn reading(behind: bool) -> ThreadLoad {
    ThreadLoad::Reading { behind }
}

fn failed(message: &str, behind: bool) -> ThreadLoad {
    ThreadLoad::Failed {
        message: message.into(),
        behind,
    }
}

fn shown(behind: bool, rereading: bool) -> ThreadLoad {
    ThreadLoad::Shown { behind, rereading }
}

fn read_failed(message: &str) -> Event {
    Event::ReadFailed {
        message: message.into(),
    }
}

fn every_state() -> Vec<ThreadLoad> {
    let mut all = vec![ThreadLoad::NoRecord];
    for behind in [false, true] {
        all.push(reading(behind));
        all.push(failed("x", behind));
        for rereading in [false, true] {
            all.push(shown(behind, rereading));
        }
    }
    all
}

fn every_event() -> Vec<Event> {
    vec![
        Event::Read,
        Event::TryAgain,
        read_failed("y"),
        Event::NoRecord,
        Event::Landed,
        Event::Subscribed,
        Event::SubscribeFailed,
        Event::ConnectionBack,
        Event::ShownAgain,
    ]
}

#[test]
fn every_state_with_every_event() {
    use Then::{CatchUp, ClearErrorLine, Nothing, SayOnErrorLine};
    let nr = ThreadLoad::NoRecord;
    let cases: Vec<(ThreadLoad, Event, ThreadLoad, Then)> = vec![
        // Reading.
        (reading(false), Event::Read, reading(false), Nothing),
        (reading(true), Event::TryAgain, reading(true), Nothing),
        (reading(true), read_failed("y"), failed("y", true), Nothing),
        (reading(false), Event::NoRecord, nr.clone(), Nothing),
        (
            reading(true),
            Event::Landed,
            shown(true, false),
            ClearErrorLine,
        ),
        (reading(true), Event::Subscribed, reading(false), Nothing),
        (
            reading(false),
            Event::SubscribeFailed,
            reading(true),
            Nothing,
        ),
        (
            reading(false),
            Event::ConnectionBack,
            reading(true),
            Nothing,
        ),
        (reading(false), Event::ShownAgain, reading(false), Nothing),
        (reading(true), Event::ShownAgain, reading(false), CatchUp),
        // Failed.
        (failed("x", true), Event::Read, reading(true), Nothing),
        (failed("x", true), Event::TryAgain, reading(true), Nothing),
        (
            failed("x", false),
            read_failed("y"),
            failed("y", false),
            Nothing,
        ),
        (failed("x", false), Event::NoRecord, nr.clone(), Nothing),
        (
            failed("x", false),
            Event::Landed,
            shown(false, false),
            ClearErrorLine,
        ),
        (
            failed("x", true),
            Event::Subscribed,
            failed("x", false),
            Nothing,
        ),
        (
            failed("x", false),
            Event::ConnectionBack,
            failed("x", true),
            Nothing,
        ),
        (
            failed("x", false),
            Event::ShownAgain,
            failed("x", false),
            CatchUp,
        ),
        (
            failed("x", true),
            Event::ShownAgain,
            failed("x", false),
            CatchUp,
        ),
        // No record.
        (nr.clone(), Event::Read, nr.clone(), Nothing),
        (nr.clone(), Event::TryAgain, reading(false), Nothing),
        (nr.clone(), read_failed("y"), failed("y", false), Nothing),
        (nr.clone(), Event::NoRecord, nr.clone(), Nothing),
        (
            nr.clone(),
            Event::Landed,
            shown(false, false),
            ClearErrorLine,
        ),
        (nr.clone(), Event::Subscribed, nr.clone(), Nothing),
        (nr.clone(), Event::ConnectionBack, nr.clone(), Nothing),
        (nr.clone(), Event::ShownAgain, nr, CatchUp),
        // Shown.
        (
            shown(false, false),
            Event::Read,
            shown(false, true),
            Nothing,
        ),
        (
            shown(true, false),
            Event::TryAgain,
            shown(true, true),
            Nothing,
        ),
        (
            shown(false, true),
            read_failed("y"),
            shown(true, false),
            SayOnErrorLine("y".into()),
        ),
        (
            shown(true, true),
            Event::NoRecord,
            shown(true, false),
            Nothing,
        ),
        (
            shown(true, true),
            Event::Landed,
            shown(true, false),
            ClearErrorLine,
        ),
        (
            shown(true, true),
            Event::Subscribed,
            shown(false, true),
            Nothing,
        ),
        (
            shown(false, false),
            Event::SubscribeFailed,
            shown(true, false),
            Nothing,
        ),
        (
            shown(false, true),
            Event::ConnectionBack,
            shown(true, true),
            Nothing,
        ),
        (
            shown(false, false),
            Event::ShownAgain,
            shown(false, false),
            Nothing,
        ),
        (
            shown(true, true),
            Event::ShownAgain,
            shown(false, true),
            CatchUp,
        ),
    ];
    for (from, event, to, then) in cases {
        assert_eq!(
            from.clone().next(event.clone()),
            (to, then),
            "{from:?} on {event:?}"
        );
    }
    // And nothing panics anywhere, and a read starting never leaves a
    // failure up.
    for from in every_state() {
        for event in every_event() {
            let (to, _) = from.clone().next(event.clone());
            if event == Event::Read {
                assert!(
                    !matches!(to, ThreadLoad::Failed { .. }),
                    "{from:?} on {event:?}"
                );
            }
        }
    }
}

#[test]
fn what_each_state_draws() {
    assert_eq!(reading(false).view(), View::Spinner);
    assert_eq!(reading(true).view(), View::Spinner);
    assert_eq!(
        failed("Couldn't read it.", false).view(),
        View::Failed {
            message: "Couldn't read it.".into()
        }
    );
    assert_eq!(ThreadLoad::NoRecord.view(), View::NoRecord);
    for behind in [false, true] {
        for rereading in [false, true] {
            assert_eq!(shown(behind, rereading).view(), View::Transcript);
        }
    }
    assert_eq!(reading(false).name(), "loading");
    assert_eq!(failed("no", false).name(), "failed: no");
    assert_eq!(ThreadLoad::NoRecord.name(), format!("failed: {NO_RECORD}"));
    assert_eq!(shown(true, true).name(), "loaded");
    assert!(shown(false, false).is_shown() && !reading(false).is_shown());
    assert!(shown(true, false).shows_old() && !shown(false, false).shows_old());
    assert!(shown(false, true).shows_old());
}

/// The specs as event sequences.
mod specs {
    use super::*;

    fn run(events: Vec<Event>) -> (ThreadLoad, Vec<Then>) {
        let mut l = ThreadLoad::opening();
        let mut thens = Vec::new();
        for e in events {
            let (next, then) = l.next(e);
            l = next;
            thens.push(then);
        }
        (l, thens)
    }

    /// switching-threads.feature, "A thread being read shows a spinner
    /// where its transcript will be".
    #[test]
    fn a_thread_being_read_shows_a_spinner() {
        let (l, _) = run(vec![Event::Read]);
        assert_eq!(l.view(), View::Spinner);
        let (l, _) = run(vec![Event::Read, Event::Landed, Event::Subscribed]);
        assert_eq!(l, shown(false, false));
        assert_eq!(l.view(), View::Transcript);
    }

    /// connection.feature, "A thread that can't be read says so, and Try
    /// again reads it".
    #[test]
    fn a_thread_that_cant_be_read_says_so_and_try_again_reads_it() {
        let (l, _) = run(vec![Event::Read, read_failed("Couldn't read it.")]);
        assert_eq!(
            l.view(),
            View::Failed {
                message: "Couldn't read it.".into()
            }
        );
        let (l, _) = l.next(Event::TryAgain);
        assert_eq!(l.view(), View::Spinner);
        let (l, _) = l.next(Event::Read);
        let (l, _) = l.next(Event::Landed);
        assert_eq!(l.view(), View::Transcript);
    }

    /// switching-threads.feature, "Going back to a thread shows it straight
    /// away": kept and shown again, with nothing to catch up.
    #[test]
    fn going_back_to_a_kept_thread_shows_it_straight_away() {
        let (l, thens) = run(vec![
            Event::Read,
            Event::Landed,
            Event::Subscribed,
            Event::ShownAgain,
        ]);
        assert_eq!(l.view(), View::Transcript);
        assert_eq!(thens.last(), Some(&Then::Nothing));
    }

    /// A kept thread across a reconnect catches up when it's next shown,
    /// and says its turn is old until then (b9c8a3e4a).
    #[test]
    fn a_kept_thread_across_a_reconnect_catches_up_when_shown() {
        let (l, thens) = run(vec![
            Event::Read,
            Event::Landed,
            Event::Subscribed,
            Event::ConnectionBack,
        ]);
        assert!(l.shows_old());
        assert_eq!(thens.last(), Some(&Then::Nothing));
        let (l, then) = l.next(Event::ShownAgain);
        assert_eq!(then, Then::CatchUp);
        let (l, _) = l.next(Event::Subscribed);
        assert!(!l.shows_old());
    }

    /// A sub-agent the runner has no record of says so, plainly.
    #[test]
    fn a_sub_agent_with_no_record() {
        let (l, _) = run(vec![Event::Read, Event::NoRecord]);
        assert_eq!(l.view(), View::NoRecord);
        assert_eq!(l.failure().as_deref(), Some(NO_RECORD));
    }
}

/// Fixed 21 Nov: a thread whose first read failed, read again as the
/// connection comes back (or the thread moves), kept saying "Couldn't load
/// this thread." with Try again until that read answered, and pressing Try
/// again then read it a second time. It shows the spinner now.
#[test]
fn a_read_starting_after_a_failure_shows_the_spinner() {
    let mut old = legacy::Pane::default();
    old.read_failed("Not connected to the runner.");
    old.read_unfixed();
    assert_eq!(
        old.drawn(),
        legacy::Drawn::Failed("Not connected to the runner.".into()),
        "the old pane, reading again"
    );
    let (l, _) = ThreadLoad::opening().next(read_failed("Not connected to the runner."));
    let (l, _) = l.next(Event::Read);
    assert_eq!(l.view(), View::Spinner);
    assert_eq!(l.name(), "loading");
    let (l, _) = l.next(Event::Landed);
    assert_eq!(l.view(), View::Transcript);
}

/// Fixed 21 Nov: something on the error line while a thread's first page
/// was read (a picture that couldn't be added, a send that failed) took the
/// spinner away, leaving an empty pane until the read answered.
#[test]
fn the_error_line_leaves_the_spinner_be() {
    let mut old = legacy::Pane::default();
    old.read();
    old.error = Some("Couldn't add that picture.".into());
    assert_eq!(
        old.drawn_unfixed(),
        legacy::Drawn::Transcript,
        "the old pane"
    );
    assert_eq!(ThreadLoad::opening().view(), View::Spinner);
}

/// Fixed 21 Nov: a kept thread of another runner's, or one far behind,
/// shown again after the connection came back, read its newest page under
/// the old rows with its stale mark already taken, so meanwhile its working
/// line counted on ("Bear with me · 31m") for a turn that had ended while
/// the app was away, the bug b9c8a3e4a fixed for the other way of catching
/// up. A pane on show read again as the connection comes back did the same.
#[test]
fn a_read_under_the_rows_shows_its_turn_as_old() {
    // Kept across a reconnect, then shown again.
    let mut old = legacy::Pane::default();
    old.landed();
    old.subscribed();
    old.not_subscribed();
    assert!(old.shown_again());
    old.try_again();
    assert!(
        !old.stale,
        "the old pane, reading again: its turn counted on"
    );

    let (l, _) = ThreadLoad::opening().next(Event::Landed);
    let (l, _) = l.next(Event::Subscribed);
    let (l, _) = l.next(Event::ConnectionBack);
    let (l, then) = l.next(Event::ShownAgain);
    assert_eq!(then, Then::CatchUp);
    let (l, _) = l.next(Event::TryAgain);
    let (l, _) = l.next(Event::Read);
    assert!(l.shows_old(), "reading its newest page again");
    let (l, _) = l.next(Event::Landed);
    // From here the feed's catching up says so till the subscribe answers.
    let (l, _) = l.next(Event::Subscribed);
    assert!(!l.shows_old());
    // A pane on show, read again as the connection comes back.
    let (l, _) = l.next(Event::Read);
    assert!(l.shows_old());
    let (l, _) = l.next(read_failed("Not connected to the runner."));
    assert!(l.shows_old(), "a read that failed leaves it behind");
}

/// The fields thread.rs kept before, and what it did with them, as it was
/// bar the bugs since fixed, each marked "Fixed" with the old code beside it.
pub(super) mod legacy {
    use super::NO_RECORD;

    #[derive(Clone, Debug, Default)]
    pub struct Pane {
        pub subagent: bool,
        pub loaded: bool,
        pub load_failed: Option<String>,
        pub subagent_missing: bool,
        pub stale: bool,
        pub error: Option<String>,
    }

    /// What went where the transcript goes (`render`).
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Drawn {
        Spinner,
        Transcript,
        Failed(String),
        NoRecord(String),
    }

    impl Pane {
        /// `load` as it began, and `load_subagent`: nothing it kept changed,
        /// so a failure stayed up while it read again (`read_unfixed`).
        /// Fixed 21 Nov: one not shown goes back to the spinner.
        pub fn read(&mut self) {
            if !self.loaded && !self.subagent_missing {
                self.load_failed = None;
            }
        }

        /// `read` as it was.
        pub fn read_unfixed(&mut self) {}

        /// `retry_load`, and `resubscribe` reading again.
        pub fn try_again(&mut self) {
            self.load_failed = None;
            self.read();
        }

        pub fn read_failed(&mut self, message: &str) {
            if self.subagent {
                self.load_failed = Some(message.into());
            } else if self.loaded {
                self.error = Some(message.into());
                self.stale = true;
            } else {
                self.load_failed = Some(message.into());
            }
        }

        pub fn no_record(&mut self) {
            self.subagent_missing = true;
            self.load_failed = Some(NO_RECORD.into());
        }

        pub fn landed(&mut self) {
            self.loaded = true;
            self.load_failed = None;
            if self.subagent {
                self.subagent_missing = false;
            } else {
                self.error = None;
            }
        }

        pub fn subscribed(&mut self) {
            self.stale = false;
        }

        /// The subscribe's answer didn't come, and `connection_back`.
        pub fn not_subscribed(&mut self) {
            self.stale = true;
        }

        /// `shown_again`: whether it catches up (`resubscribe`).
        pub fn shown_again(&mut self) -> bool {
            std::mem::take(&mut self.stale) || (!self.loaded && self.load_failed.is_some())
        }

        pub fn drawn(&self) -> Drawn {
            match self.load_failed.clone() {
                Some(m) if !self.loaded && self.subagent_missing => Drawn::NoRecord(m),
                Some(m) if !self.loaded => Drawn::Failed(m),
                // Fixed 21 Nov: the error line no longer takes the spinner
                // away (`drawn_unfixed`).
                _ if !self.loaded => Drawn::Spinner,
                _ => Drawn::Transcript,
            }
        }

        /// `drawn` as it was.
        pub fn drawn_unfixed(&self) -> Drawn {
            match self.load_failed.clone() {
                Some(m) if !self.loaded && self.subagent_missing => Drawn::NoRecord(m),
                Some(m) if !self.loaded => Drawn::Failed(m),
                _ if !self.loaded && self.error.is_none() => Drawn::Spinner,
                _ => Drawn::Transcript,
            }
        }

        pub fn load_state(&self) -> String {
            match (&self.load_failed, self.loaded) {
                (_, true) => "loaded".to_owned(),
                (Some(message), false) => format!("failed: {message}"),
                (None, false) => "loading".to_owned(),
            }
        }
    }
}

/// What can happen to a pane, as the app makes it happen.
#[derive(Clone, Debug)]
enum Op {
    /// A read begins: the connection back for a pane on show, a thread
    /// moved between runners.
    Read,
    /// A read on its way answers: with a page, or failing.
    Answer {
        landed: bool,
    },
    /// A sub-agent's read answers with no record.
    NoRecord,
    /// A subscribe on its way answers.
    Subscribe {
        ok: bool,
    },
    ConnectionBack,
    /// Kept and shown again. `far`: catching up reads again rather than
    /// subscribing from its last seq.
    ShownAgain {
        far: bool,
    },
    /// Try again, where the pane offers it.
    TryAgain,
    /// Something else on the error line (a send), or it dismissed.
    ErrorLine(bool),
}

struct Both {
    old: legacy::Pane,
    new: ThreadLoad,
    /// The new side's error line, as its `Then`s leave it.
    error: Option<String>,
    reads: usize,
    subscribes: usize,
    log: Vec<String>,
}

impl Both {
    fn new(subagent: bool) -> Both {
        let mut both = Both {
            old: legacy::Pane {
                subagent,
                ..Default::default()
            },
            new: ThreadLoad::opening(),
            error: None,
            reads: 0,
            subscribes: 0,
            log: Vec::new(),
        };
        both.read();
        both
    }

    fn deliver(&mut self, e: Event) -> Then {
        let (next, then) = transition(self.new.clone(), e);
        self.new = next;
        match &then {
            Then::SayOnErrorLine(m) => self.error = Some(m.clone()),
            // A sub-agent's read never cleared the error line.
            Then::ClearErrorLine if !self.old.subagent => self.error = None,
            Then::ClearErrorLine | Then::Nothing | Then::CatchUp => {}
        }
        then
    }

    fn read(&mut self) {
        self.old.read();
        self.deliver(Event::Read);
        self.reads += 1;
    }

    /// `retry_load`, and `resubscribe` reading again: the failure let go,
    /// then `load`.
    fn try_again(&mut self) {
        self.old.try_again();
        self.deliver(Event::TryAgain);
        self.read();
    }

    fn step(&mut self, op: &Op) {
        self.log.push(format!("{op:?}"));
        match *op {
            // A sub-agent read again under its rows (its thread moved
            // runners) doesn't move the state: only a page that came replaces
            // them (`load_subagent`, `first`).
            Op::Read if self.old.subagent && self.new.is_shown() => {
                self.old.read();
                self.reads += 1;
            }
            Op::Read => self.read(),
            Op::Answer { landed } if self.old.subagent && self.new.is_shown() => {
                self.reads -= 1;
                if landed {
                    self.old.landed();
                    self.deliver(Event::Landed);
                } else {
                    self.old.read_failed("Not connected to the runner.");
                }
            }
            Op::NoRecord if self.new.is_shown() => {
                self.reads -= 1;
                self.old.no_record();
            }
            Op::Answer { landed } => {
                self.reads -= 1;
                if landed {
                    self.old.landed();
                    self.deliver(Event::Landed);
                    if !self.old.subagent {
                        self.subscribes += 1;
                    }
                } else {
                    self.old.read_failed("Not connected to the runner.");
                    self.deliver(read_failed("Not connected to the runner."));
                }
            }
            Op::NoRecord => {
                self.reads -= 1;
                self.old.no_record();
                self.deliver(Event::NoRecord);
            }
            Op::Subscribe { ok } => {
                self.subscribes -= 1;
                if ok {
                    self.old.subscribed();
                    self.deliver(Event::Subscribed);
                } else {
                    self.old.not_subscribed();
                    self.deliver(Event::SubscribeFailed);
                }
            }
            Op::ConnectionBack => {
                self.old.not_subscribed();
                self.deliver(Event::ConnectionBack);
            }
            Op::ShownAgain { far } => {
                let old = self.old.shown_again();
                let new = self.deliver(Event::ShownAgain) == Then::CatchUp;
                assert_eq!(old, new, "catching up, after {:?}", self.log);
                // `resubscribe`: a sub-agent never does; one not shown, or
                // far behind, reads again; otherwise it subscribes.
                if new && !self.old.subagent {
                    if far || !self.old.loaded {
                        self.try_again();
                    } else {
                        self.subscribes += 1;
                    }
                }
            }
            Op::TryAgain => self.try_again(),
            Op::ErrorLine(on) => {
                let e = on.then(|| "That wasn't sent.".to_owned());
                self.old.error = e.clone();
                self.error = e;
            }
        }
        self.compare();
    }

    fn compare(&self) {
        let drawn = match self.new.view() {
            View::Spinner => legacy::Drawn::Spinner,
            View::Transcript => legacy::Drawn::Transcript,
            View::Failed { message } => legacy::Drawn::Failed(message),
            View::NoRecord => legacy::Drawn::NoRecord(NO_RECORD.to_owned()),
        };
        let at = || format!("{:?}\nnew {:?}\nold {:?}", self.log, self.new, self.old);
        assert_eq!(drawn, self.old.drawn(), "drawn, after {}", at());
        assert_eq!(
            self.new.name(),
            self.old.load_state(),
            "name, after {}",
            at()
        );
        assert_eq!(
            self.new.is_shown(),
            self.old.loaded,
            "shown, after {}",
            at()
        );
        assert_eq!(self.error, self.old.error, "error line, after {}", at());
        // Old turns only matter where there are rows to show one.
        // Fixed 21 Nov: a read under the rows counts as old too
        // (`a_read_under_the_rows_shows_its_turn_as_old`).
        let rereading = matches!(
            self.new,
            ThreadLoad::Shown {
                rereading: true,
                ..
            }
        );
        if self.new.is_shown() {
            assert_eq!(
                self.new.shows_old(),
                self.old.stale || rereading,
                "old turn, after {}",
                at()
            );
        }
    }

    /// The ops the app could make next.
    fn possible(&self) -> Vec<Op> {
        let mut ops = vec![
            Op::ConnectionBack,
            Op::ErrorLine(true),
            Op::ErrorLine(false),
        ];
        let try_again_shown = matches!(self.old.drawn(), legacy::Drawn::Failed(_));
        if self.old.subagent {
            // A sub-agent reads as it opens, on Try again, and again under
            // its rows when its thread moves runners: one at a time.
            if self.reads > 0 {
                ops.push(Op::Answer { landed: true });
                ops.push(Op::Answer { landed: false });
                ops.push(Op::NoRecord);
            } else if try_again_shown {
                ops.push(Op::TryAgain);
            } else if self.new.is_shown() {
                ops.push(Op::Read);
            }
            return ops;
        }
        ops.push(Op::Read);
        ops.push(Op::ShownAgain { far: false });
        ops.push(Op::ShownAgain { far: true });
        if try_again_shown {
            ops.push(Op::TryAgain);
        }
        if self.reads > 0 {
            ops.push(Op::Answer { landed: true });
            ops.push(Op::Answer { landed: false });
        }
        if self.subscribes > 0 {
            ops.push(Op::Subscribe { ok: true });
            ops.push(Op::Subscribe { ok: false });
        }
        ops
    }
}

fn run(subagent: bool, ops: &[Op]) {
    let mut both = Both::new(subagent);
    both.compare();
    for op in ops {
        both.step(op);
    }
}

#[test]
fn old_and_new_say_the_same_for_the_spec_sequences() {
    let land = Op::Answer { landed: true };
    let fail = Op::Answer { landed: false };
    let subscribed = Op::Subscribe { ok: true };
    run(false, &[land.clone(), subscribed.clone()]);
    run(false, &[fail.clone(), Op::TryAgain, land.clone()]);
    run(
        false,
        &[
            land.clone(),
            subscribed.clone(),
            Op::ConnectionBack,
            Op::ShownAgain { far: false },
            subscribed.clone(),
        ],
    );
    run(
        false,
        &[
            land.clone(),
            subscribed.clone(),
            Op::Read,
            fail.clone(),
            Op::ShownAgain { far: true },
            land.clone(),
            subscribed,
        ],
    );
    run(true, &[Op::NoRecord, Op::ConnectionBack]);
    run(true, &[fail, Op::TryAgain, land]);
}

/// Made-up sequences of what the app could do, from a seeded generator.
fn made_up(count: usize, seed: u64) -> Vec<(bool, Vec<Op>)> {
    let mut seed = seed;
    let mut next = |n: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n
    };
    (0..count)
        .map(|_| {
            let subagent = next(5) == 0;
            let mut both = Both::new(subagent);
            let mut ops = Vec::new();
            for _ in 0..(4 + next(24)) {
                let possible = both.possible();
                let op = possible[next(possible.len())].clone();
                // Played as it's made, so the next pick is one the app
                // could make from there (BROKEN is off while making them).
                both.step(&op);
                ops.push(op);
            }
            (subagent, ops)
        })
        .collect()
}

#[test]
fn old_and_new_say_the_same_for_made_up_sequences() {
    for (subagent, ops) in made_up(5000, 0x10ad_5eed) {
        run(subagent, &ops);
    }
}

/// The comparison fails if a transition is wrong.
#[test]
fn a_broken_transition_is_caught() {
    let sequences = made_up(3000, 0x0b0c_5eed);
    for broken in [
        // A failed read that keeps the spinner.
        (0, 2),
        // A page in that keeps Try again up.
        (1, 4),
        // A reconnect a shown pane doesn't hear.
        (3, 7),
        // A subscribe that never clears the old turn.
        (3, 5),
    ] {
        BROKEN.with(|b| b.set(Some(broken)));
        let caught = std::panic::catch_unwind(|| {
            for (subagent, ops) in &sequences {
                run(*subagent, ops);
            }
        });
        BROKEN.with(|b| b.set(None));
        assert!(caught.is_err(), "breaking {broken:?} wasn't caught");
    }
}
