// Paging older history: every phase with every event, the skip past an empty
// page, the retries, and the old fields kept as a reference (`legacy`) with
// thousands of made-up sequences run through both. A broken transition fails
// that comparison (`a_broken_transition_is_caught`).
use super::*;
use std::cell::Cell;

thread_local! {
    /// A transition to break on purpose, to show the comparison catches it.
    static BROKEN: Cell<Option<(u8, u8)>> = const { Cell::new(None) };
}

fn phase_kind(p: Phase) -> u8 {
    match p {
        Phase::Idle { .. } => 0,
        Phase::Fetching { .. } => 1,
    }
}

fn event_kind(e: Event) -> u8 {
    match e {
        Event::Ask { .. } => 0,
        Event::Failed { .. } => 1,
        Event::Empty { .. } => 2,
        Event::Arrived { .. } => 3,
        Event::NewestRead => 4,
        Event::Trimmed => 5,
    }
}

/// `Phase::next`, or a broken one while `BROKEN` says so: that phase and
/// event leave it where it was.
pub(super) fn breakable(p: Phase, e: Event) -> (Phase, Then) {
    match BROKEN.with(Cell::get) {
        Some((s, ev)) if s == phase_kind(p) && ev == event_kind(e) => (p, Then::Nothing),
        _ => p.next(e),
    }
}

fn idle(failures: u32) -> Phase {
    Phase::Idle { failures }
}

fn fetching(ticket: u64, failures: u32) -> Phase {
    Phase::Fetching { ticket, failures }
}

#[test]
fn every_phase_with_every_event() {
    let secs = |s| Then::RetryIn(Duration::from_secs(s));
    let cases = [
        (
            idle(0),
            Event::Ask { ticket: 1 },
            fetching(1, 0),
            Then::Fetch,
        ),
        (
            idle(2),
            Event::Ask { ticket: 4 },
            fetching(4, 2),
            Then::Fetch,
        ),
        (
            fetching(1, 0),
            Event::Ask { ticket: 2 },
            fetching(1, 0),
            Then::Nothing,
        ),
        (
            fetching(1, 0),
            Event::Failed { ticket: 1 },
            idle(1),
            secs(2),
        ),
        (
            fetching(1, 2),
            Event::Failed { ticket: 1 },
            idle(3),
            secs(6),
        ),
        (
            fetching(1, 3),
            Event::Failed { ticket: 1 },
            idle(4),
            Then::Nothing,
        ),
        (
            fetching(1, 2),
            Event::Empty { ticket: 1 },
            idle(0),
            Then::Skip,
        ),
        (
            fetching(1, 2),
            Event::Arrived { ticket: 1 },
            idle(0),
            Then::Prepend,
        ),
        (fetching(1, 2), Event::NewestRead, idle(2), Then::Nothing),
        (fetching(1, 2), Event::Trimmed, idle(2), Then::Nothing),
        // An answer to an ask made before a newest read or a trim is let go.
        (idle(0), Event::Failed { ticket: 1 }, idle(0), Then::Nothing),
        (idle(1), Event::Empty { ticket: 1 }, idle(1), Then::Nothing),
        (
            idle(1),
            Event::Arrived { ticket: 1 },
            idle(1),
            Then::Nothing,
        ),
        (
            fetching(2, 1),
            Event::Failed { ticket: 1 },
            fetching(2, 1),
            Then::Nothing,
        ),
        (
            fetching(2, 1),
            Event::Empty { ticket: 1 },
            fetching(2, 1),
            Then::Nothing,
        ),
        (
            fetching(2, 1),
            Event::Arrived { ticket: 1 },
            fetching(2, 1),
            Then::Nothing,
        ),
        (idle(1), Event::NewestRead, idle(1), Then::Nothing),
        (idle(1), Event::Trimmed, idle(1), Then::Nothing),
    ];
    for (from, event, to, then) in cases {
        assert_eq!(from.next(event), (to, then), "{from:?} on {event:?}");
    }
}

#[test]
fn an_empty_page_steps_back_past_the_range_it_covered() {
    let mut o = OlderPages::default();
    let ask = o.ask(2000, true).expect("an ask");
    assert_eq!((ask.before, ask.first_seq), (2000, 2000));
    assert_eq!(o.answered(ask, Answer::Empty), Then::Skip);
    assert_eq!(o.before(2000), 1500);
    let ask = o.ask(2000, true).expect("an ask");
    assert_eq!(ask.before, 1500);
    // Once the rows start somewhere else, the step back no longer counts.
    assert_eq!(o.before(1200), 1200);
    // A step back to the first seq leaves nothing more to ask for.
    let mut o = OlderPages::default();
    let ask = o.ask(300, true).expect("an ask");
    o.answered(ask, Answer::Empty);
    assert_eq!(o.before(300), 1);
    assert!(!o.has_more(300, true));
    assert_eq!(o.ask(300, true), None);
}

#[test]
fn one_page_at_a_time_and_none_when_theres_no_more() {
    let mut o = OlderPages::default();
    assert_eq!(o.ask(1, true), None);
    assert_eq!(o.ask(800, false), None);
    let ask = o.ask(800, true).expect("an ask");
    assert!(o.fetching());
    assert_eq!(o.ask(800, true), None);
    assert_eq!(o.answered(ask, Answer::Arrived), Then::Prepend);
    assert!(!o.fetching());
    assert!(o.ask(300, true).is_some());
}

#[test]
fn failures_are_asked_again_three_times_further_apart() {
    let mut o = OlderPages::default();
    let mut waits = Vec::new();
    for _ in 0..5 {
        let ask = o.ask(900, true).expect("an ask");
        waits.push(o.answered(ask, Answer::Failed));
    }
    let secs = |s| Then::RetryIn(Duration::from_secs(s));
    assert_eq!(
        waits,
        vec![secs(2), secs(4), secs(6), Then::Nothing, Then::Nothing]
    );
    // A page that comes starts the count again.
    let ask = o.ask(900, true).expect("an ask");
    o.answered(ask, Answer::Arrived);
    let ask = o.ask(400, true).expect("an ask");
    assert_eq!(o.answered(ask, Answer::Failed), secs(2));
}

#[test]
fn a_newest_read_or_a_trim_starts_over_from_the_newest_page() {
    let mut o = OlderPages::default();
    let ask = o.ask(2000, true).expect("an ask");
    o.answered(ask, Answer::Empty);
    o.trimmed();
    assert_eq!(o.before(2000), 2000);
    let ask = o.ask(2000, true).expect("an ask");
    o.answered(ask, Answer::Empty);
    o.newest_read();
    assert_eq!(o.before(2000), 2000);
    assert!(!o.fetching());
}

/// Fixed 21 Nov: an older page on its way as the pane read its newest page
/// again (the connection back, the thread moved) or was trimmed back to it
/// (kept with more than 2,000 events, after reading far back) still went in
/// above the new rows when it came: its events end where the old rows began,
/// thousands of seqs before the new ones, so the transcript had a hole in
/// it for good, and paging went on from below the hole. After a newest read
/// a second ask could also go out beside it. Now only the answer to the ask
/// on its way counts.
#[test]
fn a_page_asked_for_before_a_trim_is_let_go() {
    // The old code: asked at 3,000, trimmed back to rows from 9,500.
    let mut old = legacy::Pane::default();
    let (before, first) = old.load_older(3000, true).expect("an ask");
    old.older_skip = None; // what trim_kept did, and all it did
    assert_eq!(
        old.finish_older(before, first, legacy::Answer::Arrived),
        legacy::Did::Prepended,
        "the old pane put the page above rows starting at 9,500"
    );
    // And after a newest read, a second ask went out beside the first.
    let mut old = legacy::Pane::default();
    old.load_older(3000, true).expect("an ask");
    old.reload();
    assert!(
        old.load_older(9500, true).is_some(),
        "the old pane asked twice"
    );

    let mut o = OlderPages::default();
    let ask = o.ask(3000, true).expect("an ask");
    o.trimmed();
    assert_eq!(o.answered(ask, Answer::Arrived), Then::Nothing);
    let ask = o.ask(3000, true).expect("an ask");
    o.newest_read();
    let second = o.ask(9500, true).expect("an ask from the new rows");
    assert_eq!(o.answered(ask, Answer::Arrived), Then::Nothing, "the first");
    assert!(o.fetching(), "the second's still on its way");
    assert_eq!(o.answered(ask, Answer::Failed), Then::Nothing);
    assert_eq!(o.answered(second, Answer::Arrived), Then::Prepend);
}

/// The fields thread.rs kept before, and what it did with them, as it was
/// bar the bugs since fixed, each marked "Fixed".
pub(super) mod legacy {
    use super::EVENTS_PAGE;
    use std::time::Duration;

    #[derive(Clone, Debug, Default)]
    pub struct Pane {
        pub loading_older: bool,
        pub older_skip: Option<(i64, i64)>,
        pub older_failures: u32,
    }

    /// What `finish_older` went on to do.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Did {
        Retry(Duration),
        GaveUp,
        Skipped,
        Prepended,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Answer {
        Failed,
        Empty,
        Arrived,
    }

    impl Pane {
        pub fn older_before(&self, first: i64) -> i64 {
            match self.older_skip {
                Some((at, before)) if at == first => before,
                _ => first,
            }
        }

        pub fn has_more_above(&self, first: i64, has_older_events: bool) -> bool {
            has_older_events && self.older_before(first) > 1
        }

        /// `load_older` (the pane loaded): the page's `before` and the first
        /// seq it was asked from.
        pub fn load_older(&mut self, first: i64, has_older_events: bool) -> Option<(i64, i64)> {
            if self.loading_older || !self.has_more_above(first, has_older_events) {
                return None;
            }
            self.loading_older = true;
            Some((self.older_before(first), first))
        }

        pub fn finish_older(&mut self, before: i64, first_seq: i64, answer: Answer) -> Did {
            match answer {
                Answer::Failed => {
                    self.loading_older = false;
                    self.older_failures += 1;
                    if self.older_failures <= 3 {
                        Did::Retry(Duration::from_secs(u64::from(self.older_failures) * 2))
                    } else {
                        Did::GaveUp
                    }
                }
                Answer::Empty => {
                    self.older_failures = 0;
                    self.older_skip = Some((first_seq, (before - EVENTS_PAGE as i64).max(1)));
                    self.loading_older = false;
                    Did::Skipped
                }
                Answer::Arrived => {
                    self.older_failures = 0;
                    self.loading_older = false;
                    Did::Prepended
                }
            }
        }

        /// `load`'s answer landing.
        pub fn reload(&mut self) {
            self.loading_older = false;
            self.older_skip = None;
        }

        /// `trim_kept`. Fixed 21 Nov: the page on its way is let go too
        /// (`a_page_asked_for_before_a_trim_is_let_go`); it left
        /// `loading_older` alone.
        pub fn trim(&mut self) {
            self.older_skip = None;
            self.loading_older = false;
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Op {
    /// The view near the top, or a retry's timer.
    Ask,
    /// The `which`th ask still out answers.
    Answer { which: usize, answer: Answer },
    /// The newest page read again: the rows start `newest` seqs on.
    NewestRead { newest: i64 },
    /// Kept and trimmed back to its newest page.
    Trim { newest: i64 },
}

struct Both {
    old: legacy::Pane,
    new: OlderPages,
    /// The pane's first seq, as both sides move it alike.
    first: i64,
    /// Asks still out: the old side's and the new one's.
    out: Vec<((i64, i64), Ask)>,
    log: Vec<String>,
}

impl Both {
    fn new() -> Both {
        Both {
            old: legacy::Pane::default(),
            new: OlderPages::default(),
            first: 3000,
            out: Vec::new(),
            log: Vec::new(),
        }
    }

    fn has_older(&self) -> bool {
        self.first > 1
    }

    fn step(&mut self, op: Op) {
        self.log.push(format!("{op:?}"));
        match op {
            Op::Ask => {
                let old = self.old.load_older(self.first, self.has_older());
                let new = self.new.ask(self.first, self.has_older());
                assert_eq!(
                    old,
                    new.map(|a| (a.before, a.first_seq)),
                    "ask, after {:?}",
                    self.log
                );
                if let (Some(o), Some(n)) = (old, new) {
                    self.out.push((o, n));
                }
            }
            Op::Answer { which, answer } => {
                let ((before, first), ask) = self.out.remove(which % self.out.len());
                // Fixed 21 Nov: the answer to an ask from before the rows
                // were read again or trimmed is let go. The old code took
                // it (`a_page_asked_for_before_a_trim_is_let_go`).
                let current = matches!(
                    self.new.phase(),
                    Phase::Fetching { ticket, .. } if ticket == ask.ticket
                );
                if !current {
                    let phase = self.new.phase();
                    assert_eq!(
                        self.new.answered(ask, answer),
                        Then::Nothing,
                        "{:?}",
                        self.log
                    );
                    assert_eq!(
                        self.new.phase(),
                        phase,
                        "a stale answer moved it: {:?}",
                        self.log
                    );
                    return;
                }
                let did = self.old.finish_older(
                    before,
                    first,
                    match answer {
                        Answer::Failed => legacy::Answer::Failed,
                        Answer::Empty => legacy::Answer::Empty,
                        Answer::Arrived => legacy::Answer::Arrived,
                    },
                );
                let then = self.new.answered(ask, answer);
                let did_new = match then {
                    Then::RetryIn(d) => Some(legacy::Did::Retry(d)),
                    Then::Nothing => Some(legacy::Did::GaveUp),
                    Then::Skip => Some(legacy::Did::Skipped),
                    Then::Prepend => Some(legacy::Did::Prepended),
                    Then::Fetch => None,
                };
                assert_eq!(Some(did), did_new, "answer, after {:?}", self.log);
                if did == legacy::Did::Prepended {
                    // The page's rows go above: the first seq moves back.
                    self.first = (before - EVENTS_PAGE as i64).max(1);
                }
            }
            Op::NewestRead { newest } => {
                self.old.reload();
                self.new.newest_read();
                self.first += newest;
            }
            Op::Trim { newest } => {
                self.old.trim();
                self.new.trimmed();
                self.first += newest;
            }
        }
        let at = || format!("{:?}\nnew {:?}\nold {:?}", self.log, self.new, self.old);
        assert_eq!(
            self.new.fetching(),
            self.old.loading_older,
            "fetching, after {}",
            at()
        );
        assert_eq!(
            self.new.before(self.first),
            self.old.older_before(self.first),
            "before, after {}",
            at()
        );
    }
}

fn run(ops: &[Op]) {
    let mut both = Both::new();
    for &op in ops {
        both.step(op);
    }
}

fn made_up(count: usize, seed: u64) -> Vec<Vec<Op>> {
    let mut seed = seed;
    let mut next = |n: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n
    };
    (0..count)
        .map(|_| {
            let mut both = Both::new();
            let mut ops = Vec::new();
            for _ in 0..(4 + next(30)) {
                let out = both.out.len();
                let op = match next(9) {
                    0..=2 => Op::Ask,
                    3..=6 if out > 0 => Op::Answer {
                        which: next(out),
                        answer: [Answer::Failed, Answer::Empty, Answer::Arrived][next(3)],
                    },
                    7 => Op::NewestRead {
                        newest: next(3) as i64 * 400,
                    },
                    8 => Op::Trim {
                        newest: next(3) as i64 * 400,
                    },
                    _ => Op::Ask,
                };
                // Played as it's made, to know which asks are out.
                both.step(op);
                ops.push(op);
            }
            ops
        })
        .collect()
}

#[test]
fn old_and_new_say_the_same_for_made_up_sequences() {
    for ops in made_up(4000, 0x01de_5eed) {
        run(&ops);
    }
}

#[test]
fn a_broken_transition_is_caught() {
    let sequences = made_up(3000, 0x0b0c_5eed);
    for broken in [(0, 0), (1, 1), (1, 2), (1, 3), (1, 4), (1, 5)] {
        BROKEN.with(|b| b.set(Some(broken)));
        let caught = std::panic::catch_unwind(|| {
            for ops in &sequences {
                run(ops);
            }
        });
        BROKEN.with(|b| b.set(None));
        assert!(caught.is_err(), "breaking {broken:?} wasn't caught");
    }
}
