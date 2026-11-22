// The app's connection to its runner as one state, with every move it can
// make in one place (`ConnectionPhase::next`) and what the banner over the
// transcript says about it (`banner`). Before this the app kept eight loose
// fields and worked the state out again on every draw, reading the client
// live; two races came of that (`tests::races`).
//
// The client (desktop/client) owns the socket and its restart (`Phase` in
// client/src/restart.rs); neither crate sees the other, so the GPUI app
// turns what the client says into `Event`s of plain data: a status change,
// with when the restart the client knows of stops being one, a restart
// notice, Try again, Start runner. Time moves the phase too (the drop's
// grace, a restart that has gone on too long): the phase holds those
// deadlines (`deadline`) and the app delivers `Event::Clock` then.
use std::time::{Duration, Instant};

/// How long an unexpected drop goes unmentioned in the banner: this Mac's
/// runner is usually back by then, and a warning that flicks up and away is
/// only noise (Mike, 12 Nov).
pub const DROP_GRACE: Duration = Duration::from_secs(3);

/// Why the connection isn't up, as the client tells them apart
/// (`threadbear_client::runner::Disconnect`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// It was connected, and the connection went.
    Lost,
    /// The runner couldn't be reached at all: Start runner can help.
    Down,
    /// The runner turned the app's token down.
    Refused,
}

/// What the last drop was: its cause and, in plain words, why
/// (`threadbear_client::runner::plain_reason`), for the banner's tooltip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gone {
    pub cause: Cause,
    pub reason: String,
}

/// Where the connection is, as the window tells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionPhase {
    /// Connected and signed in. `restart_ends`: the runner has said it's
    /// restarting now while still up, which shows quietly until then.
    Connected { restart_ends: Option<Instant> },
    /// Not connected, and too soon to say so: the app has just opened, or
    /// the connection has just gone. Nothing shows until `quiet_until`;
    /// `gone` is what the drop was, if one has been heard.
    Quiet {
        gone: Option<Gone>,
        quiet_until: Instant,
    },
    /// Not connected because the runner is restarting: a quiet line with no
    /// buttons, until it's connected again or `ends`, when a runner still
    /// away is down, not restarting. Kept whatever the client says
    /// meanwhile (the first race in `tests::races`).
    Restarting {
        ends: Instant,
        gone: Option<Gone>,
        quiet_until: Instant,
    },
    /// Trying, with nothing known to be wrong: a first connection that's
    /// slow, or the try Try again started. "Connecting to the runner…"
    Connecting,
    /// Nothing answered: "Can't reach the runner.", with Start runner.
    Unreachable { reason: String },
    /// Start runner was pressed: its button spins, and can't be pressed
    /// again, until launchctl has answered and the app has tried again.
    StartingRunner { reason: String },
    /// The connection went and hasn't come back.
    Lost { reason: String },
    /// The runner turned the token down. Said at once, grace or not, as it
    /// won't put itself right; `quiet_until` is the drop's grace, should it
    /// turn into a plain drop.
    Refused {
        reason: String,
        quiet_until: Instant,
    },
}

/// What moves the phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The client has begun a try. `restart_ends`: when the restart the
    /// client knows of stops being one (None for none), as for each event
    /// from it.
    Connecting { restart_ends: Option<Instant> },
    /// Signed in, and hello answered, with any restart the client has
    /// heard of since (the new runner's notice can reach the app first).
    Connected { restart_ends: Option<Instant> },
    /// The connection went, or a try failed.
    Disconnected {
        gone: Gone,
        restart_ends: Option<Instant>,
    },
    /// The runner's news about restarting (a notice, `runner.status`'s
    /// answer): when the restart under way stops being one, or None.
    Restart { ends: Option<Instant> },
    /// A deadline the phase gave (`deadline`) has come.
    Clock,
    /// Try again in the banner.
    TryAgain,
    /// Start runner in the banner.
    StartRunner,
    /// Start runner's launchctl has answered and the app tries again.
    RunnerStarted,
}

/// What the banner says about the connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Banner {
    /// Information, in grey with a spinner, rather than a warning.
    pub quiet: bool,
    /// The symbol before the words; None for the spinner.
    pub icon: Option<&'static str>,
    pub text: &'static str,
    /// Why, in plain words, for the tooltip.
    pub detail: Option<String>,
    pub buttons: Buttons,
}

/// The banner's buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Buttons {
    None,
    TryAgain,
    /// Start runner (where the app can start it) and Try again. `starting`:
    /// Start runner spins.
    StartRunnerAndTryAgain {
        starting: bool,
    },
}

impl ConnectionPhase {
    /// As the app opens: not connected yet, and quiet for the grace.
    pub fn opening(now: Instant) -> ConnectionPhase {
        ConnectionPhase::Quiet {
            gone: None,
            quiet_until: now + DROP_GRACE,
        }
    }

    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionPhase::Connected { .. })
    }

    /// The only way the phase moves: from the phase as it is at `now`, so
    /// an event that beats a late Clock finds its deadlines passed.
    pub fn next(self, event: Event, now: Instant) -> ConnectionPhase {
        use ConnectionPhase as P;
        let phase = self.at(now);
        let moved = match event {
            Event::Connected { restart_ends } => P::Connected {
                restart_ends: restart_ends.filter(|e| *e > now),
            },
            Event::Clock => phase,
            Event::Connecting { restart_ends } => phase.away(None, restart_ends, now),
            Event::Disconnected { gone, restart_ends } => phase.away(Some(gone), restart_ends, now),
            Event::Restart { ends } => {
                let ends = ends.filter(|e| *e > now);
                match (phase, ends) {
                    (P::Connected { .. }, ends) => P::Connected { restart_ends: ends },
                    // The first restart this outage belongs to stays it.
                    (restarting @ P::Restarting { .. }, _) => restarting,
                    (P::Quiet { gone, quiet_until }, Some(ends)) => P::Restarting {
                        ends,
                        gone,
                        quiet_until,
                    },
                    (quiet @ P::Quiet { .. }, None) => quiet,
                    (
                        shown @ (P::Connecting
                        | P::Unreachable { .. }
                        | P::StartingRunner { .. }
                        | P::Lost { .. }
                        | P::Refused { .. }),
                        Some(ends),
                    ) => P::Restarting {
                        ends,
                        quiet_until: shown.quiet_until(now),
                        gone: shown.gone(),
                    },
                    (
                        shown @ (P::Connecting
                        | P::Unreachable { .. }
                        | P::StartingRunner { .. }
                        | P::Lost { .. }
                        | P::Refused { .. }),
                        None,
                    ) => shown,
                }
            }
            // Forget what the drop was, so the banner says "Connecting"
            // until this try has an answer and the click shows. Start
            // runner's launch is still under way, though: it keeps
            // spinning, and can't be pressed again, until that answers.
            Event::TryAgain | Event::RunnerStarted => match phase {
                connected @ P::Connected { .. } => connected,
                P::StartingRunner { reason } if event == Event::TryAgain => {
                    P::StartingRunner { reason }
                }
                P::Quiet { quiet_until, .. } => P::Quiet {
                    gone: None,
                    quiet_until,
                },
                P::Restarting {
                    ends, quiet_until, ..
                } => P::Restarting {
                    ends,
                    gone: None,
                    quiet_until,
                },
                P::Refused { quiet_until, .. } => P::Quiet {
                    gone: None,
                    quiet_until,
                },
                P::Connecting
                | P::Unreachable { .. }
                | P::StartingRunner { .. }
                | P::Lost { .. } => P::Connecting,
            },
            Event::StartRunner => match phase {
                P::Unreachable { reason } => P::StartingRunner { reason },
                other @ (P::Connected { .. }
                | P::Quiet { .. }
                | P::Restarting { .. }
                | P::Connecting
                | P::StartingRunner { .. }
                | P::Lost { .. }
                | P::Refused { .. }) => other,
            },
        };
        moved.at(now)
    }

    /// When the phase next moves by itself, for the app to deliver
    /// `Event::Clock` then.
    pub fn deadline(&self) -> Option<Instant> {
        match self {
            ConnectionPhase::Connected { restart_ends } => *restart_ends,
            ConnectionPhase::Quiet { quiet_until, .. } => Some(*quiet_until),
            ConnectionPhase::Restarting { ends, .. } => Some(*ends),
            ConnectionPhase::Connecting
            | ConnectionPhase::Unreachable { .. }
            | ConnectionPhase::StartingRunner { .. }
            | ConnectionPhase::Lost { .. }
            | ConnectionPhase::Refused { .. } => None,
        }
    }

    /// The automation dump's name for it (the Swift app's
    /// `connectionName`), which the specs read: what the connection is,
    /// whether or not the banner says so yet.
    pub fn name(&self) -> &'static str {
        if self.is_connected() {
            return "connected";
        }
        match self.gone().map(|g| g.cause) {
            None => "connecting",
            Some(Cause::Down) => "down",
            Some(Cause::Lost) => "lost",
            Some(Cause::Refused) => "unauthorized",
        }
    }

    /// Not connected: a try begun (`gone` None) or one that failed.
    fn away(self, heard: Option<Gone>, restart_ends: Option<Instant>, now: Instant) -> Self {
        use ConnectionPhase as P;
        let restart = restart_ends.filter(|e| *e > now);
        match self {
            P::Connected { restart_ends: was } => {
                let quiet_until = now + DROP_GRACE;
                match restart.or(was.filter(|e| *e > now)) {
                    Some(ends) => P::Restarting {
                        ends,
                        gone: heard,
                        quiet_until,
                    },
                    None => settle(heard, quiet_until, now),
                }
            }
            P::Quiet { gone, quiet_until } => {
                let gone = heard.or(gone);
                match restart {
                    Some(ends) => P::Restarting {
                        ends,
                        gone,
                        quiet_until,
                    },
                    None => settle(gone, quiet_until, now),
                }
            }
            // Down because of a restart counts until the app has seen it
            // connected, whatever the client says about the restart meanwhile.
            P::Restarting {
                ends,
                gone,
                quiet_until,
            } => P::Restarting {
                ends,
                gone: heard.or(gone),
                quiet_until,
            },
            shown @ (P::Connecting
            | P::Unreachable { .. }
            | P::StartingRunner { .. }
            | P::Lost { .. }
            | P::Refused { .. }) => {
                let quiet_until = shown.quiet_until(now);
                let starting = matches!(shown, P::StartingRunner { .. });
                let gone = heard.or(shown.gone());
                match (restart, gone) {
                    (Some(ends), gone) => P::Restarting {
                        ends,
                        gone,
                        quiet_until,
                    },
                    // Start runner keeps spinning while its runner is still
                    // out of reach (or went before saying hello).
                    (
                        None,
                        Some(Gone {
                            cause: Cause::Down | Cause::Lost,
                            reason,
                        }),
                    ) if starting => P::StartingRunner { reason },
                    (None, gone) => settle(gone, quiet_until, now),
                }
            }
        }
    }

    /// As it is at `now`: the deadlines that have passed, passed.
    fn at(self, now: Instant) -> Self {
        use ConnectionPhase as P;
        match self {
            P::Connected {
                restart_ends: Some(ends),
            } if ends <= now => P::Connected { restart_ends: None },
            P::Quiet { gone, quiet_until } => settle(gone, quiet_until, now),
            P::Restarting {
                ends,
                gone,
                quiet_until,
            } if ends <= now => settle(gone, quiet_until, now),
            other @ (P::Connected { .. }
            | P::Restarting { .. }
            | P::Connecting
            | P::Unreachable { .. }
            | P::StartingRunner { .. }
            | P::Lost { .. }
            | P::Refused { .. }) => other,
        }
    }

    /// What the last drop was, while not connected.
    fn gone(&self) -> Option<Gone> {
        let gone = |cause, reason: &String| {
            Some(Gone {
                cause,
                reason: reason.clone(),
            })
        };
        match self {
            ConnectionPhase::Connected { .. } | ConnectionPhase::Connecting => None,
            ConnectionPhase::Quiet { gone, .. } | ConnectionPhase::Restarting { gone, .. } => {
                gone.clone()
            }
            ConnectionPhase::Unreachable { reason }
            | ConnectionPhase::StartingRunner { reason } => gone(Cause::Down, reason),
            ConnectionPhase::Lost { reason } => gone(Cause::Lost, reason),
            ConnectionPhase::Refused { reason, .. } => gone(Cause::Refused, reason),
        }
    }

    /// The drop's grace, where the phase keeps it; one already shown is
    /// over.
    fn quiet_until(&self, now: Instant) -> Instant {
        match self {
            ConnectionPhase::Quiet { quiet_until, .. }
            | ConnectionPhase::Restarting { quiet_until, .. }
            | ConnectionPhase::Refused { quiet_until, .. } => *quiet_until,
            ConnectionPhase::Connected { .. }
            | ConnectionPhase::Connecting
            | ConnectionPhase::Unreachable { .. }
            | ConnectionPhase::StartingRunner { .. }
            | ConnectionPhase::Lost { .. } => now,
        }
    }
}

/// Not connected and not restarting: quiet for the grace, then what the
/// drop was. A refused token is said at once.
fn settle(gone: Option<Gone>, quiet_until: Instant, now: Instant) -> ConnectionPhase {
    match gone {
        Some(Gone {
            cause: Cause::Refused,
            reason,
        }) => ConnectionPhase::Refused {
            reason,
            quiet_until,
        },
        gone if now < quiet_until => ConnectionPhase::Quiet { gone, quiet_until },
        None => ConnectionPhase::Connecting,
        Some(Gone {
            cause: Cause::Down,
            reason,
        }) => ConnectionPhase::Unreachable { reason },
        Some(Gone {
            cause: Cause::Lost,
            reason,
        }) => ConnectionPhase::Lost { reason },
    }
}

/// What the banner says about the connection at `now`, if anything. While
/// connected and with no restart under way that's nothing: the app's own
/// notes (a click from a menu, a pending restart, a CLI update) go there.
pub fn banner(phase: &ConnectionPhase, now: Instant) -> Option<Banner> {
    let warning = |icon, text, reason: &str, buttons| Banner {
        quiet: false,
        icon: Some(icon),
        text,
        detail: Some(reason.to_owned()).filter(|d| !d.is_empty()),
        buttons,
    };
    let restarting = |text| Banner {
        quiet: true,
        icon: None,
        text,
        detail: None,
        buttons: Buttons::None,
    };
    let down = |reason, starting| {
        warning(
            "bolt.horizontal.circle",
            "Can't reach the runner.",
            reason,
            Buttons::StartRunnerAndTryAgain { starting },
        )
    };
    match phase.clone().at(now) {
        ConnectionPhase::Connected {
            restart_ends: Some(_),
        } => Some(restarting("The runner is restarting now.")),
        ConnectionPhase::Connected { restart_ends: None } | ConnectionPhase::Quiet { .. } => None,
        // Meant to be down for a moment: said quietly, with nothing to press.
        ConnectionPhase::Restarting { .. } => {
            Some(restarting("The runner is restarting. Reconnecting…"))
        }
        ConnectionPhase::Connecting => Some(warning(
            "bolt.horizontal",
            "Connecting to the runner…",
            "",
            Buttons::TryAgain,
        )),
        ConnectionPhase::Unreachable { reason } => Some(down(&reason, false)),
        ConnectionPhase::StartingRunner { reason } => Some(down(&reason, true)),
        ConnectionPhase::Lost { reason } => Some(warning(
            "bolt.horizontal",
            "Lost the connection to the runner. Reconnecting…",
            &reason,
            Buttons::TryAgain,
        )),
        ConnectionPhase::Refused { reason, .. } => Some(warning(
            "lock",
            "The runner didn't accept the token in secrets/runner-token.",
            &reason,
            Buttons::TryAgain,
        )),
    }
}

#[cfg(test)]
mod tests;
