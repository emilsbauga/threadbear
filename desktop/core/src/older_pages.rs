// Paging a thread's older history in above what its pane shows, as one state
// (`Phase`) with every move it can make in one place (`Phase::next`). Before
// this gpui's thread.rs kept it in three loose fields (`loading_older`,
// `older_skip`, `older_failures`; `tests::legacy` keeps them, to run the same
// sequences through both).
//
// It only runs once the pane's rows show (thread_load.rs, `is_shown`), and
// the pane asks when its view nears the first row. Each ask has a ticket, and
// only the answer to the ask on its way counts: a newest read or a trim
// starts over, and an answer to an ask from before is let go.
//
// Besides the phase it keeps where the next page ends (`skip`): a page that
// came back with nothing before the seq asked for steps back past the range
// it covered, so the next ask ends before that instead (`olderSkip`).
use std::time::Duration;

/// Events read in a page, as ThreadSession.eventsPage: the newest page as a
/// thread opens, and each older one.
pub const EVENTS_PAGE: u64 = 500;

/// Older pages that fail in a row are asked for again by themselves this
/// many times, further apart each time; after that, when the view next asks.
pub const RETRIES: u32 = 3;

/// Where paging is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Nothing on its way. `failures`: asks in a row that failed.
    Idle { failures: u32 },
    /// A page is on its way, asked for with `ticket`.
    Fetching { ticket: u64, failures: u32 },
}

/// What moves it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The view is near the top and there's more: ask for a page, with this
    /// ticket.
    Ask { ticket: u64 },
    /// The answer to the ask with `ticket`: it failed.
    Failed { ticket: u64 },
    /// The answer: a page with nothing before the seq asked for.
    Empty { ticket: u64 },
    /// The answer: a page with rows to add above.
    Arrived { ticket: u64 },
    /// The pane read its newest page again, over what it showed.
    NewestRead,
    /// A kept pane went back to its newest page (`trim_kept`).
    Trimmed,
}

/// What else a move means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    Nothing,
    /// Fetch the page now.
    Fetch,
    /// It failed: ask again after this long, if the view's still near the top.
    RetryIn(Duration),
    /// Step back past the range the empty page covered and ask again if
    /// the view's near the top.
    Skip,
    /// Add the page above the rows.
    Prepend,
}

impl Phase {
    /// The only way paging moves.
    pub fn next(self, event: Event) -> (Phase, Then) {
        use Phase as P;
        let failures = match self {
            P::Idle { failures } | P::Fetching { failures, .. } => failures,
        };
        match (self, event) {
            (P::Idle { failures }, Event::Ask { ticket }) => {
                (P::Fetching { ticket, failures }, Then::Fetch)
            }
            // One page at a time.
            (fetching @ P::Fetching { .. }, Event::Ask { .. }) => (fetching, Then::Nothing),
            // The answer to the ask on its way.
            (P::Fetching { ticket: asked, .. }, Event::Failed { ticket }) if ticket == asked => {
                let failures = failures + 1;
                let then = if failures <= RETRIES {
                    Then::RetryIn(Duration::from_secs(u64::from(failures) * 2))
                } else {
                    Then::Nothing
                };
                (P::Idle { failures }, then)
            }
            (P::Fetching { ticket: asked, .. }, Event::Empty { ticket }) if ticket == asked => {
                (P::Idle { failures: 0 }, Then::Skip)
            }
            (P::Fetching { ticket: asked, .. }, Event::Arrived { ticket }) if ticket == asked => {
                (P::Idle { failures: 0 }, Then::Prepend)
            }
            // Any other answer is to an ask made before the rows were read
            // again or trimmed: its page would go above rows that no longer
            // start where it ends, leaving a hole in the transcript, and the
            // ask after it would be a second one on its way.
            (
                phase @ (P::Idle { .. } | P::Fetching { .. }),
                Event::Failed { .. } | Event::Empty { .. } | Event::Arrived { .. },
            ) => (phase, Then::Nothing),
            (P::Idle { .. } | P::Fetching { .. }, Event::NewestRead | Event::Trimmed) => {
                (P::Idle { failures }, Then::Nothing)
            }
        }
    }
}

/// An ask for an older page, as it was made: its answer comes back with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ask {
    pub ticket: u64,
    /// The page ends before this seq.
    pub before: i64,
    /// The pane's first seq when it asked.
    pub first_seq: i64,
}

/// How an ask was answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Failed,
    /// Nothing before the seq asked for.
    Empty,
    Arrived,
}

/// A pane's paging: the phase, where the next page ends, and the tickets.
#[derive(Clone, Debug)]
pub struct OlderPages {
    phase: Phase,
    /// A page that came back with nothing before `.1` when the pane's first
    /// seq was `.0`: the next ends before `.1` instead.
    skip: Option<(i64, i64)>,
    tickets: u64,
}

impl Default for OlderPages {
    fn default() -> Self {
        OlderPages {
            phase: Phase::Idle { failures: 0 },
            skip: None,
            tickets: 0,
        }
    }
}

impl OlderPages {
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// A page is on its way.
    pub fn fetching(&self) -> bool {
        matches!(self.phase, Phase::Fetching { .. })
    }

    /// Where the next page ends, for a pane whose first seq is `first_seq`.
    pub fn before(&self, first_seq: i64) -> i64 {
        match self.skip {
            Some((at, before)) if at == first_seq => before,
            _ => first_seq,
        }
    }

    /// `hasMoreAbove`: there are events the runner hasn't sent.
    pub fn has_more(&self, first_seq: i64, has_older_events: bool) -> bool {
        has_older_events && self.before(first_seq) > 1
    }

    /// Asks for the next older page if there's more and none is on its way:
    /// the ask to fetch, if one's to be made.
    pub fn ask(&mut self, first_seq: i64, has_older_events: bool) -> Option<Ask> {
        if !self.has_more(first_seq, has_older_events) {
            return None;
        }
        let ticket = self.tickets + 1;
        let before = self.before(first_seq);
        match self.step(Event::Ask { ticket }) {
            Then::Fetch => {
                self.tickets = ticket;
                Some(Ask {
                    ticket,
                    before,
                    first_seq,
                })
            }
            Then::Nothing | Then::RetryIn(_) | Then::Skip | Then::Prepend => None,
        }
    }

    /// The answer to `ask`: what the pane does with it.
    pub fn answered(&mut self, ask: Ask, answer: Answer) -> Then {
        let ticket = ask.ticket;
        let then = self.step(match answer {
            Answer::Failed => Event::Failed { ticket },
            Answer::Empty => Event::Empty { ticket },
            Answer::Arrived => Event::Arrived { ticket },
        });
        if then == Then::Skip {
            self.skip = Some((ask.first_seq, (ask.before - EVENTS_PAGE as i64).max(1)));
        }
        then
    }

    /// The pane read its newest page again: paging starts over from it.
    pub fn newest_read(&mut self) {
        self.skip = None;
        self.step(Event::NewestRead);
    }

    /// A kept pane went back to its newest page.
    pub fn trimmed(&mut self) {
        self.skip = None;
        self.step(Event::Trimmed);
    }

    fn step(&mut self, event: Event) -> Then {
        // The tests break a transition on purpose, to see the comparison
        // with the old code catch it.
        #[cfg(not(test))]
        let (phase, then) = self.phase.next(event);
        #[cfg(test)]
        let (phase, then) = tests::breakable(self.phase, event);
        self.phase = phase;
        then
    }
}

#[cfg(test)]
mod tests;
