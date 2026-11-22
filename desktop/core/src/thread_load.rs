// How far a thread pane has got with reading its thread, as one state, with
// every move it can make in one place (`ThreadLoad::next`) and what the pane
// draws for it (`ThreadLoad::view`). Before this gpui's thread.rs kept it in
// four loose fields (`loaded`, `load_failed`, `subagent_missing`, `stale`),
// written from nine places (`tests::legacy` keeps them, to run the same
// sequences through both).
//
// Two things ride along in the states rather than being states of their own:
// `behind`, that what the pane holds may be old (from before the connection
// last went, or not subscribed), so it catches up when it's next shown and
// its working line doesn't count on; and, once rows show, `rereading`, a read
// of the newest page under them that hasn't answered yet.
//
// Paging older history in is a lifecycle of its own (older_pages.rs): it only
// runs once rows show, and a new newest page resets it.
//
// The pane's error line (`ThreadPane::error`) isn't a load state: sends, card
// buttons and pictures write it too. A read's answer says what to do with it
// (`Then`).

/// What the pane says when the runner has no record of a sub-agent (-32006).
pub const NO_RECORD: &str = "There's no record of what this sub-agent did.";

/// Where a pane's read of its thread (or sub-agent) is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThreadLoad {
    /// Its first page is on its way: a spinner where the transcript will be.
    Reading { behind: bool },
    /// Its first read failed: what went wrong, with Try again, in place of
    /// the transcript.
    Failed { message: String, behind: bool },
    /// A sub-agent the runner has no record of: a plain note, not a failure.
    /// Nothing more comes of it (a sub-agent's pane is never kept or caught
    /// up), so nothing rides along.
    NoRecord,
    /// Its rows show. `rereading`: a read of its newest page is on its way
    /// under them (a reconnect, a move, catching up from far behind).
    Shown { behind: bool, rereading: bool },
}

/// What moves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A read of the newest page (or the sub-agent's whole transcript) has
    /// begun: as it opens, the connection back, the thread moved.
    Read,
    /// Try again, or catching up a pane whose first read failed: the
    /// failure's let go and it reads again.
    TryAgain,
    /// The read failed.
    ReadFailed { message: String },
    /// The runner has no record of the sub-agent.
    NoRecord,
    /// The read's page is in and its rows are made.
    Landed,
    /// `threads.subscribe` answered: it's up to date and hears what's new.
    Subscribed,
    /// Not subscribed (the answer didn't come, or made no sense).
    SubscribeFailed,
    /// The connection came back while it wasn't shown, so it isn't
    /// subscribed on the new one.
    ConnectionBack,
    /// Shown again from the panes kept loaded.
    ShownAgain,
}

/// What else a move means, beyond the new state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Then {
    Nothing,
    /// A read over rows already shown failed: they stay, and the error line
    /// says why.
    SayOnErrorLine(String),
    /// A read that worked puts right whatever the error line said.
    ClearErrorLine,
    /// Shown again behind, or with its first read failed: catch it up now
    /// (`ThreadPane::resubscribe`).
    CatchUp,
}

/// What the pane draws where the transcript goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum View {
    /// A small spinner in the middle, no words, no rows.
    Spinner,
    /// The transcript (no rows yet if the read hasn't answered).
    Transcript,
    /// "Couldn't load this thread.", the message and Try again.
    Failed { message: String },
    /// The no-record note.
    NoRecord,
}

impl ThreadLoad {
    /// As a pane opens: its read is about to begin.
    pub fn opening() -> ThreadLoad {
        ThreadLoad::Reading { behind: false }
    }

    /// The only way it moves.
    pub fn next(self, event: Event) -> (ThreadLoad, Then) {
        use ThreadLoad as L;
        let nothing = |l| (l, Then::Nothing);
        match (self, event) {
            // A read starting from a failure goes back to the spinner, as Try
            // again does: the failure, Try again and all, stayed up while the
            // connection's return read it again, and Try again read it twice.
            (L::Failed { behind, .. }, Event::Read) => nothing(L::Reading { behind }),
            (l @ (L::Reading { .. } | L::NoRecord), Event::Read) => nothing(l),
            (L::Shown { behind, .. }, Event::Read | Event::TryAgain) => nothing(L::Shown {
                behind,
                rereading: true,
            }),
            (l @ L::Reading { .. }, Event::TryAgain) => nothing(l),
            (L::Failed { behind, .. }, Event::TryAgain) => nothing(L::Reading { behind }),
            (L::NoRecord, Event::TryAgain) => nothing(L::Reading { behind: false }),

            (L::Reading { behind } | L::Failed { behind, .. }, Event::ReadFailed { message }) => {
                nothing(L::Failed { message, behind })
            }
            (L::NoRecord, Event::ReadFailed { message }) => nothing(L::Failed {
                message,
                behind: false,
            }),
            // Rows already shown stay, behind, and the error line says why.
            (L::Shown { .. }, Event::ReadFailed { message }) => (
                L::Shown {
                    behind: true,
                    rereading: false,
                },
                Then::SayOnErrorLine(message),
            ),

            (L::Reading { .. } | L::Failed { .. } | L::NoRecord, Event::NoRecord) => {
                nothing(L::NoRecord)
            }
            // A sub-agent is read again only to add to what shows.
            (L::Shown { behind, .. }, Event::NoRecord) => nothing(L::Shown {
                behind,
                rereading: false,
            }),

            (L::NoRecord, Event::Landed) => (
                L::Shown {
                    behind: false,
                    rereading: false,
                },
                Then::ClearErrorLine,
            ),
            (
                L::Reading { behind } | L::Failed { behind, .. } | L::Shown { behind, .. },
                Event::Landed,
            ) => (
                L::Shown {
                    behind,
                    rereading: false,
                },
                Then::ClearErrorLine,
            ),

            (
                l @ (L::Reading { .. } | L::Failed { .. } | L::NoRecord | L::Shown { .. }),
                Event::Subscribed,
            ) => nothing(l.with_behind(false)),
            (
                l @ (L::Reading { .. } | L::Failed { .. } | L::NoRecord | L::Shown { .. }),
                Event::SubscribeFailed | Event::ConnectionBack,
            ) => nothing(l.with_behind(true)),

            // Shown again: behind, or never read, catches up now.
            (l @ (L::Failed { .. } | L::NoRecord), Event::ShownAgain) => {
                (l.with_behind(false), Then::CatchUp)
            }
            (l @ (L::Reading { .. } | L::Shown { .. }), Event::ShownAgain) => {
                if l.behind() {
                    (l.with_behind(false), Then::CatchUp)
                } else {
                    nothing(l)
                }
            }
        }
    }

    /// What goes where the transcript goes. The error line above it has no
    /// say: something going wrong while the first page is read (a picture
    /// that couldn't be added) used to take the spinner away and leave an
    /// empty pane, as the Swift app never did.
    pub fn view(&self) -> View {
        match self {
            ThreadLoad::Reading { .. } => View::Spinner,
            ThreadLoad::Failed { message, .. } => View::Failed {
                message: message.clone(),
            },
            ThreadLoad::NoRecord => View::NoRecord,
            ThreadLoad::Shown { .. } => View::Transcript,
        }
    }

    /// Its rows show: it can page older history in, remember where it's
    /// read to, and mark the thread read.
    pub fn is_shown(&self) -> bool {
        matches!(self, ThreadLoad::Shown { .. })
    }

    /// What it shows may be old, so a turn it shows running while the
    /// thread's summary says none is says "Catching up…" rather than
    /// counting on (`ThreadPane::shows_old_turn`): behind, or with its newest
    /// page being read again under the rows. That read is what a kept pane
    /// of another runner's thread, or one far behind, catches up with, and a
    /// pane on show reads as the connection comes back; it used to count on
    /// meanwhile, a turn that had ended while the app was away.
    pub fn shows_old(&self) -> bool {
        match self {
            ThreadLoad::Shown { behind, rereading } => *behind || *rereading,
            ThreadLoad::Reading { .. } | ThreadLoad::Failed { .. } | ThreadLoad::NoRecord => {
                self.behind()
            }
        }
    }

    /// The automation dump's name for it (the Swift dump's), a failure with
    /// its message.
    pub fn name(&self) -> String {
        match self {
            ThreadLoad::Shown { .. } => "loaded".to_owned(),
            ThreadLoad::Failed { message, .. } => format!("failed: {message}"),
            ThreadLoad::NoRecord => format!("failed: {NO_RECORD}"),
            ThreadLoad::Reading { .. } => "loading".to_owned(),
        }
    }

    /// The failure the automation's `subagent` reports, if it's one.
    pub fn failure(&self) -> Option<String> {
        match self {
            ThreadLoad::Failed { message, .. } => Some(message.clone()),
            ThreadLoad::NoRecord => Some(NO_RECORD.to_owned()),
            ThreadLoad::Reading { .. } | ThreadLoad::Shown { .. } => None,
        }
    }

    fn behind(&self) -> bool {
        match self {
            ThreadLoad::Reading { behind }
            | ThreadLoad::Failed { behind, .. }
            | ThreadLoad::Shown { behind, .. } => *behind,
            ThreadLoad::NoRecord => false,
        }
    }

    fn with_behind(self, behind: bool) -> ThreadLoad {
        match self {
            ThreadLoad::Reading { .. } => ThreadLoad::Reading { behind },
            ThreadLoad::Failed { message, .. } => ThreadLoad::Failed { message, behind },
            ThreadLoad::NoRecord => ThreadLoad::NoRecord,
            ThreadLoad::Shown { rereading, .. } => ThreadLoad::Shown { behind, rereading },
        }
    }
}

#[cfg(test)]
mod tests;
