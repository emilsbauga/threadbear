// Messages on their way from this app to a runner, every thread's, with each
// message's life as one state (`State`) and every move it can make in one
// place (`State::next`). Before this the app kept seven thread-locals and
// three loose flags for it in gpui's thread.rs (`tests::legacy` keeps them,
// to run the same sequences through both).
//
// What the outbox doesn't do is decide when a message goes again: that's the
// client's (`send_through_restart` in desktop/client/src/runner.rs), which
// holds a message for a restarting runner, sends one it turned away again,
// and looks for one cut off on its way before sending it twice. The outbox
// hands it the facts it goes on (`Ticket`: whether the thread was idle with
// nothing else on its way, the seq to look after, the message to look for)
// and hears back how it got on (`Event::Progress`, `Event::Answered`).
//
// Neither crate sees the other, so the GPUI app turns what the client says
// into plain data here. Time moves the outbox too (a taken message's wait to
// be called queued, a hold's grace): the deadlines live in the states, and
// the app delivers `Event::Clock` at `deadline`.
use crate::reducer::{Event as ThreadEvent, ImageRef, Pending, PendingMessage};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a message the runner has taken waits for its `user.message`
/// before it's called queued behind the running turn: it usually comes just
/// before the answer, so the clock doesn't flash on every send
/// (`markQueued`).
pub const QUEUE_DELAY: Duration = Duration::from_millis(600);

/// How long a taken message holds its thread under Running if no summary
/// comes (a dropped connection, another runner that's gone quiet): the guess
/// never outlives this.
pub const HOLD_GRACE: Duration = Duration::from_secs(5);

/// Where one message is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Made, and not on the wire yet: waiting its turn behind another
    /// request about its thread, or (`held`) for a restarting runner, which
    /// its bubble says. Only this Mac's runner's messages wait.
    Waiting { held: bool },
    /// On its way: the client has said it's going, or (another runner's,
    /// through Convex) it went from the click.
    Sending,
    /// The transcript has shown it; the runner's answer to the send isn't in
    /// yet. No longer drawn as on its way.
    Shown,
    /// The runner took it and its `user.message` hasn't come: at `queue_at`
    /// it's called queued. `held`: the client's last word was that it was
    /// held (a cut-off send found to have arrived after all).
    Taken { held: bool, queue_at: Instant },
    /// Queued behind the running turn: the runner has it, and its
    /// `user.message` comes when its own turn starts.
    Queued,
}

/// What can happen to one message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// The client holds it for a restarting runner (`Progress::Held`).
    Held,
    /// The client is sending it now (`Progress::Sending`).
    Going,
    /// The transcript no longer has it on its way: its `user.message` came
    /// (live, in a catch-up or a reload), or an edit dropped the messages
    /// queued behind it.
    Dropped,
    /// The runner's answer to the send.
    Answered(Answer),
    /// A deadline (`deadline`) has come.
    Clock,
    /// Its thread sat idle with it still queued: it was lost on the way
    /// (`checkQueued`).
    QueuedLost,
}

/// The runner's answer to a send, as the outbox needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Taken (or the client found it had arrived after all).
    Took,
    /// The connection closed with it on its way, or no answer came in time:
    /// it may or may not have arrived.
    MayHaveArrived,
    /// Anything else: not taken.
    Refused,
}

/// What else a step means, beyond the message's new state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    Nothing,
    /// The runner has taken it: its thread stays under Running until the
    /// next summary, if none has come since the click (`Outbox::taken`).
    CheckTaken,
    /// It didn't go: its words go back in the box, and the error bar says so.
    GiveBack,
}

impl State {
    /// The only way a message moves: its next state (None once it's done
    /// with) and what else that means.
    pub fn next(self, step: Step, now: Instant) -> (Option<State>, Then) {
        use State as S;
        let stay = (Some(self), Then::Nothing);
        match (self, step) {
            // On its way and not shown yet.
            (S::Waiting { .. } | S::Sending, Step::Held) => {
                (Some(S::Waiting { held: true }), Then::Nothing)
            }
            (S::Waiting { .. } | S::Sending, Step::Going) => (Some(S::Sending), Then::Nothing),
            (S::Waiting { .. } | S::Sending, Step::Dropped) => (Some(S::Shown), Then::CheckTaken),
            (S::Waiting { held }, Step::Answered(Answer::Took)) => (
                Some(S::Taken {
                    held,
                    queue_at: now + QUEUE_DELAY,
                }),
                Then::Nothing,
            ),
            (S::Sending, Step::Answered(Answer::Took)) => (
                Some(S::Taken {
                    held: false,
                    queue_at: now + QUEUE_DELAY,
                }),
                Then::Nothing,
            ),
            // Not shown, and not taken: whatever became of it, the words go
            // back in the box rather than be lost.
            (
                S::Waiting { .. } | S::Sending,
                Step::Answered(Answer::MayHaveArrived | Answer::Refused),
            ) => (None, Then::GiveBack),
            (S::Waiting { .. } | S::Sending, Step::Clock | Step::QueuedLost) => stay,

            // Shown: it went, whatever became of the answer (a stalled
            // runner's that came too late, a connection that closed after
            // it arrived)...
            (S::Shown, Step::Answered(Answer::Took | Answer::MayHaveArrived)) => {
                (None, Then::Nothing)
            }
            // ...but a refusal after it showed gives the words back, as the
            // Swift app's did.
            (S::Shown, Step::Answered(Answer::Refused)) => (None, Then::GiveBack),
            (
                S::Shown,
                Step::Held | Step::Going | Step::Dropped | Step::Clock | Step::QueuedLost,
            ) => stay,

            // Taken, waiting a moment for its echo.
            (S::Taken { queue_at, .. }, Step::Held) => (
                Some(S::Taken {
                    held: true,
                    queue_at,
                }),
                Then::Nothing,
            ),
            (S::Taken { queue_at, .. }, Step::Going) => (
                Some(S::Taken {
                    held: false,
                    queue_at,
                }),
                Then::Nothing,
            ),
            (S::Taken { .. }, Step::Dropped) => (None, Then::CheckTaken),
            (S::Taken { queue_at, .. }, Step::Clock) if queue_at <= now => {
                (Some(S::Queued), Then::CheckTaken)
            }
            (S::Taken { .. }, Step::Clock | Step::Answered(_) | Step::QueuedLost) => stay,

            // Queued: it lands when its turn starts, or is let go.
            (S::Queued, Step::Dropped | Step::QueuedLost) => (None, Then::Nothing),
            (S::Queued, Step::Held | Step::Going | Step::Answered(_) | Step::Clock) => stay,
        }
    }

    /// How its bubble shows it at the end of the transcript, if it's drawn.
    pub fn bubble(&self) -> Option<Pending> {
        match self {
            State::Waiting { held: true } | State::Taken { held: true, .. } => {
                Some(Pending::WaitingForRunner)
            }
            State::Waiting { held: false } | State::Sending | State::Taken { held: false, .. } => {
                Some(Pending::Sending)
            }
            State::Queued => Some(Pending::Queued),
            State::Shown => None,
        }
    }

    /// When it next moves by itself.
    pub fn deadline(&self) -> Option<Instant> {
        match self {
            State::Taken { queue_at, .. } => Some(*queue_at),
            State::Waiting { .. } | State::Sending | State::Shown | State::Queued => None,
        }
    }
}

/// Whether a message is still to go, shared with the connection's task,
/// which sets it as the client says (`Progress`): a quit reads it straight
/// after `Client::stop_holding`, before any event from that task could reach
/// the outbox, so a message the client has said is going is never also
/// kept in the drafts file. The one fact the outbox doesn't move itself.
#[derive(Clone, Debug, Default)]
pub struct Gate(Arc<AtomicBool>);

impl Gate {
    fn new(still_to_go: bool) -> Gate {
        Gate(Arc::new(AtomicBool::new(still_to_go)))
    }

    /// From the connection's task: held (still to go) or going.
    pub fn set(&self, still_to_go: bool) {
        self.0.store(still_to_go, Ordering::SeqCst);
    }

    pub fn still_to_go(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One message on its way.
#[derive(Clone, Debug)]
struct Message<D> {
    id: String,
    thread: String,
    text: String,
    images: Vec<ImageRef>,
    /// The thread's last seq when it was sent: only a `user.message` after
    /// it can be this one. Moved on by the transcript when an earlier
    /// message with the same words lands.
    after_seq: i64,
    /// What the box held, to give back, or to keep through a quit while
    /// it's still to go. Let go once the runner has answered.
    draft: Option<D>,
    gate: Gate,
    /// How many summaries of its thread had come when it was sent, until
    /// it's taken (`Outbox::taken`).
    sent_at: Option<u64>,
    state: State,
}

impl<D> Message<D> {
    fn pending(&self) -> Option<PendingMessage> {
        let bubble = self.state.bubble()?;
        Some(PendingMessage {
            id: self.id.clone(),
            text: self.text.clone(),
            images: self.images.clone(),
            answers: Vec::new(),
            after_seq: self.after_seq,
            queued: bubble == Pending::Queued,
            waiting_for_runner: bubble == Pending::WaitingForRunner,
        })
    }
}

/// What the runner last said about a thread, as far as a send cares.
#[derive(Clone, Debug, Default)]
struct News {
    /// How many summaries of it have come, so a send can tell whether one
    /// has since its click.
    summaries: u64,
    /// It's held under Running until this, or its next summary: the runner
    /// has just taken a message for it. The runner sends the message's
    /// `user.message` first and the summary saying its turn has started just
    /// after, later on a busy Mac or from another runner; until then its
    /// summary still has the last turn's "needs you". Any summary after the
    /// message is the runner's word, whatever it says: one that failed at
    /// once goes straight back to the Inbox (18 Nov).
    awaiting: Option<Instant>,
}

/// A message sent.
#[derive(Clone, Debug)]
pub struct Send<D> {
    pub thread: String,
    pub text: String,
    pub images: Vec<ImageRef>,
    /// The thread's last seq as the pane knows it.
    pub after_seq: i64,
    /// Another Mac's thread, sent through this Mac's runner and Convex: it
    /// goes as it is, never held.
    pub remote: bool,
    /// Sent while this Mac's runner is down for a restart: held for the new
    /// one from the click.
    pub holding: bool,
    /// The thread's summary says a turn is running.
    pub busy: bool,
    pub draft: Option<D>,
}

/// What the client needs to send it, and what the app shows meanwhile.
#[derive(Clone, Debug)]
pub struct Ticket {
    /// The message as its bubble shows it, also what to look for in the
    /// thread to tell whether a cut-off send arrived.
    pub message: PendingMessage,
    /// Idle when sent and the only one on its way: nothing on the runner
    /// could queue it, so one cut off by a restart can be looked for and
    /// sent again if it never arrived (`Resend::was_idle`).
    pub was_idle: bool,
    /// For the client's progress to set (`Gate`).
    pub gate: Gate,
}

/// What moves the outbox.
#[derive(Clone, Debug)]
pub enum Event<D> {
    Send(Send<D>),
    /// The client's word on a message held for a restarting runner: still
    /// held (`still_to_go`) or going now.
    Progress {
        id: String,
        still_to_go: bool,
    },
    Answered {
        id: String,
        answer: Answer,
    },
    /// What a thread's transcript has as on its way now (its model's
    /// `pending`, after it took out what's landed): the ones it has dropped
    /// have landed, or an edit cut them. Their `after_seq`s too.
    Transcript {
        thread: String,
        list: Vec<PendingMessage>,
    },
    /// An event from this Mac's runner, before the transcript takes it in:
    /// a message it shows was taken now, so only a summary from here on is
    /// the runner's word on it. One between the click and here (opening the
    /// thread marked it seen, say) is older news (Codex's review, 18 Nov).
    /// Another runner's summary can beat its transcript here, so theirs keep
    /// the click.
    Heard {
        thread: String,
        event: ThreadEvent,
    },
    /// The runner said something new about a thread.
    Summary {
        thread: String,
    },
    /// The thread sat idle with messages still queued: they were lost.
    QueuedLost {
        thread: String,
    },
    Clock,
}

/// What the app does about a move, beyond drawing the outbox again.
#[derive(Debug)]
pub struct Effects<D> {
    /// A Send's.
    pub ticket: Option<(String, Ticket)>,
    /// A message that didn't go: its draft back in the box, and the error bar.
    pub gave_back: Option<Option<D>>,
    /// Threads whose messages the clock moved (called queued), to show again.
    pub moved: Vec<String>,
    /// A hold ran out: the sidebar sorts again.
    pub let_go: bool,
}

impl<D> Default for Effects<D> {
    fn default() -> Self {
        Effects {
            ticket: None,
            gave_back: None,
            moved: Vec::new(),
            let_go: false,
        }
    }
}

/// Every message on its way, every thread's: kept outside any pane (the
/// Swift app keeps its sessions, and with them their pending messages), as
/// a pane goes when another thread is opened and a message held for a
/// restarting runner can wait a minute and more.
#[derive(Clone, Debug)]
pub struct Outbox<D> {
    /// In the order they were sent.
    messages: Vec<Message<D>>,
    news: BTreeMap<String, News>,
    next_id: u64,
    /// Goes up whenever what the sidebar reads (`sending`) may have changed,
    /// for its cache: not for every event heard, which would sort every
    /// thread again for each line streamed in.
    changes: u64,
}

impl<D> Default for Outbox<D> {
    fn default() -> Self {
        Outbox {
            messages: Vec::new(),
            news: BTreeMap::new(),
            next_id: 0,
            changes: 0,
        }
    }
}

impl<D: Clone> Outbox<D> {
    /// The only way the outbox moves.
    pub fn next(&mut self, event: Event<D>, now: Instant) -> Effects<D> {
        let mut fx = Effects::default();
        match event {
            Event::Send(send) => {
                self.changes += 1;
                fx.ticket = Some(self.send(send));
            }
            Event::Progress { id, still_to_go } => {
                let step = if still_to_go { Step::Held } else { Step::Going };
                self.step(&id, step, now);
            }
            Event::Answered { id, answer } => {
                // No longer one to keep through a quit, whatever happens.
                let draft = self
                    .messages
                    .iter_mut()
                    .find(|m| m.id == id)
                    .and_then(|m| m.draft.take());
                if self.step(&id, Step::Answered(answer), now).0 == Then::GiveBack {
                    fx.gave_back = Some(draft);
                }
            }
            Event::Transcript { thread, list } => {
                let mut ids = Vec::new();
                for m in self.messages.iter_mut().filter(|m| m.thread == thread) {
                    if m.state.bubble().is_none() {
                        continue;
                    }
                    match list.iter().find(|p| p.id == m.id) {
                        Some(p) => m.after_seq = p.after_seq,
                        None => ids.push(m.id.clone()),
                    }
                }
                // Every one is taken (each clears its own record), not just
                // the first.
                let mut hold = false;
                for id in ids {
                    hold |= self.step(&id, Step::Dropped, now).1;
                }
                if hold {
                    self.hold(&thread, now);
                }
            }
            Event::Heard { thread, event } => {
                let summaries = self.summaries_of(&thread);
                for m in self.messages.iter_mut().filter(|m| m.thread == thread) {
                    let shows = m
                        .pending()
                        .is_some_and(|p| !p.queued && p.is_landed_by(&event));
                    if shows && m.sent_at.is_some() {
                        m.sent_at = Some(summaries);
                    }
                }
            }
            Event::Summary { thread } => {
                let news = self.news.entry(thread).or_default();
                news.summaries += 1;
                if news.awaiting.take().is_some() {
                    self.changes += 1;
                }
            }
            Event::QueuedLost { thread } => {
                let ids: Vec<String> = self
                    .messages
                    .iter()
                    .filter(|m| m.thread == thread)
                    .map(|m| m.id.clone())
                    .collect();
                for id in ids {
                    self.step(&id, Step::QueuedLost, now);
                }
            }
            Event::Clock => {
                let ids: Vec<(String, String)> = self
                    .messages
                    .iter()
                    .filter(|m| m.state.deadline().is_some_and(|at| at <= now))
                    .map(|m| (m.id.clone(), m.thread.clone()))
                    .collect();
                for (id, thread) in ids {
                    if self.step(&id, Step::Clock, now).1 {
                        self.hold(&thread, now);
                    }
                    if !fx.moved.contains(&thread) {
                        fx.moved.push(thread);
                    }
                }
                for news in self.news.values_mut() {
                    if news.awaiting.is_some_and(|until| until <= now) {
                        news.awaiting = None;
                        fx.let_go = true;
                        self.changes += 1;
                    }
                }
            }
        }
        fx
    }

    fn send(&mut self, send: Send<D>) -> (String, Ticket) {
        self.next_id += 1;
        // Unique across panes: the outbox outlives each one.
        let id = format!("local-{}", self.next_id);
        let was_idle = !send.busy && self.pending(&send.thread).is_empty();
        let state = if send.remote {
            State::Sending
        } else {
            State::Waiting { held: send.holding }
        };
        let sent_at = Some(self.summaries_of(&send.thread));
        let message = Message {
            id: id.clone(),
            thread: send.thread,
            text: send.text,
            images: send.images,
            after_seq: send.after_seq,
            draft: send.draft,
            // Not yet on its way: held for a restart, or waiting behind
            // another message to this thread.
            gate: Gate::new(!send.remote),
            sent_at,
            state,
        };
        let ticket = Ticket {
            message: message.pending().unwrap_or_default(),
            was_idle,
            gate: message.gate.clone(),
        };
        self.messages.push(message);
        (id, ticket)
    }

    /// Moves one message on. With `Then::CheckTaken`, whether its thread
    /// is to be held under Running (`taken`); `Then::GiveBack` as it is;
    /// Then::Nothing for one that's gone.
    fn step(&mut self, id: &str, step: Step, now: Instant) -> (Then, bool) {
        let Some(i) = self.messages.iter().position(|m| m.id == id) else {
            return (Then::Nothing, false);
        };
        #[cfg(not(test))]
        let (state, then) = self.messages[i].state.next(step, now);
        // The tests break a transition on purpose, to see the comparison
        // with the old code catch it.
        #[cfg(test)]
        let (state, then) = tests::transition(self.messages[i].state, step, now);
        let summaries = self.summaries_of(&self.messages[i].thread);
        let message = &mut self.messages[i];
        // The runner has taken it: whether its thread should stay under
        // Running until its next summary. Only if none has come since the
        // click: one that has is the runner's word already (a turn that
        // failed at once, or asked something, from another runner whose
        // summary can beat its transcript here), and holding past it would
        // hide a thread that needs Mike. Once only: it's spoken for.
        let taken = then == Then::CheckTaken && message.sent_at.take() == Some(summaries);
        let changed = state != Some(message.state);
        match state {
            Some(state) => message.state = state,
            None => {
                self.messages.remove(i);
            }
        }
        if changed {
            self.changes += 1;
        }
        (then, taken)
    }

    /// What a thread's transcript shows as on its way, oldest first: the
    /// bubbles at its end.
    pub fn pending(&self, thread: &str) -> Vec<PendingMessage> {
        self.messages
            .iter()
            .filter(|m| m.thread == thread)
            .filter_map(Message::pending)
            .collect()
    }

    /// The threads the sidebar has under Running rather than in the Inbox
    /// (`inbox::as_sending`): with a message the runner hasn't taken yet
    /// (the spinner by its bubble), or has taken without a summary since. A
    /// queued one is left out: the runner has it, and its summary says what
    /// the thread is doing. That also bounds the guess to the send's own
    /// call, whose answer marks it queued or takes it out whether or not a
    /// pane is open, so no bubble left behind keeps a thread in Running.
    pub fn sending(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for m in &self.messages {
            let on_its_way = m.state.bubble().is_some_and(|b| b != Pending::Queued);
            if on_its_way && !ids.contains(&m.thread) {
                ids.push(m.thread.clone());
            }
        }
        for (thread, news) in &self.news {
            if news.awaiting.is_some() && !ids.contains(thread) {
                ids.push(thread.clone());
            }
        }
        ids
    }

    /// The boxes' words of a thread's messages still to go (held for the
    /// new runner, or behind another), oldest first, for the drafts file:
    /// one still held when the app quits comes back in the box next time
    /// (Swift's `heldForResend` into DraftStore), rather than lost.
    pub fn held_drafts(&self, thread: &str) -> Vec<&D> {
        self.messages
            .iter()
            .filter(|m| m.thread == thread && m.state.bubble().is_some())
            .filter(|m| m.gate.still_to_go())
            .filter_map(|m| m.draft.as_ref())
            .collect()
    }

    /// A message from the thread's box on its way to the runner and not
    /// answered yet: a refusal would put its words back in a box a restart
    /// had already saved.
    pub fn sending_now(&self, thread: &str) -> bool {
        self.messages
            .iter()
            .any(|m| m.thread == thread && m.draft.is_some() && !m.gate.still_to_go())
    }

    /// When the outbox next moves by itself, for the app to deliver
    /// `Event::Clock` then.
    pub fn deadline(&self) -> Option<Instant> {
        let messages = self.messages.iter().filter_map(|m| m.state.deadline());
        let holds = self.news.values().filter_map(|n| n.awaiting);
        messages.chain(holds).min()
    }

    /// How many times the outbox has changed, for the sidebar's cache.
    pub fn changes(&self) -> u64 {
        self.changes
    }

    /// Where a message is, while the outbox has it.
    pub fn state_of(&self, id: &str) -> Option<State> {
        self.messages.iter().find(|m| m.id == id).map(|m| m.state)
    }

    fn hold(&mut self, thread: &str, now: Instant) {
        self.news.entry(thread.to_owned()).or_default().awaiting = Some(now + HOLD_GRACE);
        self.changes += 1;
    }

    fn summaries_of(&self, thread: &str) -> u64 {
        self.news.get(thread).map_or(0, |n| n.summaries)
    }
}

#[cfg(test)]
mod tests;
