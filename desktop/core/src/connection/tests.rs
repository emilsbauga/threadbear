// The connection's phase: every phase/event pair, the two races the old
// fields recorded, the specs (features/connection.feature) as event
// sequences, and the old logic kept as a reference (`legacy`) with the same
// sequences run through both.
use super::*;

const PATIENCE: Duration = Duration::from_secs(90);

fn s(secs: u64) -> Duration {
    Duration::from_secs(secs)
}

fn gone(cause: Cause, reason: &str) -> Gone {
    Gone {
        cause,
        reason: reason.into(),
    }
}

fn text(phase: &ConnectionPhase, now: Instant) -> Option<&'static str> {
    banner(phase, now).map(|b| b.text)
}

/// Every phase with every event, from one moment: the phases' own
/// deadlines are a little after it, so none passes by itself.
#[test]
fn every_phase_with_every_event() {
    use ConnectionPhase as P;
    let now = Instant::now() + s(10);
    let (soon, later, grace) = (now + s(30), now + s(60), now + s(2));
    let down = |r: &str| Some(gone(Cause::Down, r));
    let phases = [
        P::Connected { restart_ends: None },
        P::Connected {
            restart_ends: Some(later),
        },
        P::Quiet {
            gone: down("x"),
            quiet_until: grace,
        },
        P::Restarting {
            ends: later,
            gone: Some(gone(Cause::Lost, "y")),
            quiet_until: grace,
        },
        P::Connecting,
        P::Unreachable { reason: "x".into() },
        P::StartingRunner { reason: "x".into() },
        P::Lost { reason: "y".into() },
        P::Refused {
            reason: "z".into(),
            quiet_until: grace,
        },
    ];
    let events = [
        Event::Connecting { restart_ends: None },
        Event::Connecting {
            restart_ends: Some(soon),
        },
        Event::Connected { restart_ends: None },
        Event::Disconnected {
            gone: gone(Cause::Down, "d"),
            restart_ends: None,
        },
        Event::Disconnected {
            gone: gone(Cause::Refused, "r"),
            restart_ends: None,
        },
        Event::Restart { ends: Some(soon) },
        Event::Restart { ends: None },
        Event::Clock,
        Event::TryAgain,
        Event::StartRunner,
        Event::RunnerStarted,
    ];
    let connected = P::Connected { restart_ends: None };
    let quiet = |gone, quiet_until| P::Quiet { gone, quiet_until };
    let restarting = |ends, gone, quiet_until| P::Restarting {
        ends,
        gone,
        quiet_until,
    };
    let refused = |r: &str, quiet_until| P::Refused {
        reason: r.into(),
        quiet_until,
    };
    let unreachable = |r: &str| P::Unreachable { reason: r.into() };
    let starting = |r: &str| P::StartingRunner { reason: r.into() };
    let lost = |r: &str| P::Lost { reason: r.into() };
    let fresh = now + DROP_GRACE;
    let (lost_y, refused_z) = (
        Some(gone(Cause::Lost, "y")),
        Some(gone(Cause::Refused, "z")),
    );
    // One row a phase, one column an event, in the orders above.
    let expected: [[ConnectionPhase; 11]; 9] = [
        [
            quiet(None, fresh),
            restarting(soon, None, fresh),
            connected.clone(),
            quiet(down("d"), fresh),
            refused("r", fresh),
            P::Connected {
                restart_ends: Some(soon),
            },
            connected.clone(),
            connected.clone(),
            connected.clone(),
            connected.clone(),
            connected.clone(),
        ],
        [
            restarting(later, None, fresh),
            restarting(soon, None, fresh),
            connected.clone(),
            restarting(later, down("d"), fresh),
            restarting(later, Some(gone(Cause::Refused, "r")), fresh),
            P::Connected {
                restart_ends: Some(soon),
            },
            connected.clone(),
            phases[1].clone(),
            phases[1].clone(),
            phases[1].clone(),
            phases[1].clone(),
        ],
        [
            phases[2].clone(),
            restarting(soon, down("x"), grace),
            connected.clone(),
            quiet(down("d"), grace),
            refused("r", grace),
            restarting(soon, down("x"), grace),
            phases[2].clone(),
            phases[2].clone(),
            quiet(None, grace),
            phases[2].clone(),
            quiet(None, grace),
        ],
        [
            phases[3].clone(),
            phases[3].clone(),
            connected.clone(),
            restarting(later, down("d"), grace),
            restarting(later, Some(gone(Cause::Refused, "r")), grace),
            phases[3].clone(),
            phases[3].clone(),
            phases[3].clone(),
            restarting(later, None, grace),
            phases[3].clone(),
            restarting(later, None, grace),
        ],
        [
            P::Connecting,
            restarting(soon, None, now),
            connected.clone(),
            unreachable("d"),
            refused("r", now),
            restarting(soon, None, now),
            P::Connecting,
            P::Connecting,
            P::Connecting,
            P::Connecting,
            P::Connecting,
        ],
        [
            unreachable("x"),
            restarting(soon, down("x"), now),
            connected.clone(),
            unreachable("d"),
            refused("r", now),
            restarting(soon, down("x"), now),
            unreachable("x"),
            unreachable("x"),
            P::Connecting,
            starting("x"),
            P::Connecting,
        ],
        [
            starting("x"),
            restarting(soon, down("x"), now),
            connected.clone(),
            starting("d"),
            refused("r", now),
            restarting(soon, down("x"), now),
            starting("x"),
            starting("x"),
            // Try again while launchctl works: it keeps spinning.
            starting("x"),
            starting("x"),
            P::Connecting,
        ],
        [
            lost("y"),
            restarting(soon, lost_y.clone(), now),
            connected.clone(),
            unreachable("d"),
            refused("r", now),
            restarting(soon, lost_y, now),
            lost("y"),
            lost("y"),
            P::Connecting,
            lost("y"),
            P::Connecting,
        ],
        [
            refused("z", grace),
            restarting(soon, refused_z.clone(), grace),
            connected,
            quiet(down("d"), grace),
            refused("r", grace),
            restarting(soon, refused_z, grace),
            refused("z", grace),
            refused("z", grace),
            quiet(None, grace),
            refused("z", grace),
            quiet(None, grace),
        ],
    ];
    for (phase, row) in phases.iter().zip(expected.iter()) {
        for (event, want) in events.iter().zip(row.iter()) {
            assert_eq!(
                &phase.clone().next(event.clone(), now),
                want,
                "{phase:?} with {event:?}"
            );
        }
    }
}

/// Each deadline, once it's passed: what the phase becomes.
#[test]
fn each_deadline_moves_the_phase_on() {
    use ConnectionPhase as P;
    let t = Instant::now();
    let clock = |p: P, at| p.next(Event::Clock, at);
    let restarting = P::Connected {
        restart_ends: Some(t + s(5)),
    };
    assert_eq!(restarting.deadline(), Some(t + s(5)));
    assert_eq!(
        clock(restarting, t + s(5)),
        P::Connected { restart_ends: None }
    );
    let quiet = |g| P::Quiet {
        gone: g,
        quiet_until: t + s(3),
    };
    assert_eq!(quiet(None).deadline(), Some(t + s(3)));
    assert_eq!(clock(quiet(None), t + s(2)), quiet(None));
    assert_eq!(clock(quiet(None), t + s(3)), P::Connecting);
    assert_eq!(
        clock(quiet(Some(gone(Cause::Down, "x"))), t + s(3)),
        P::Unreachable { reason: "x".into() }
    );
    assert_eq!(
        clock(quiet(Some(gone(Cause::Lost, "y"))), t + s(3)),
        P::Lost { reason: "y".into() }
    );
    // A restart that runs out inside the drop's grace is quiet until that's
    // over too.
    let r = P::Restarting {
        ends: t + s(90),
        gone: Some(gone(Cause::Down, "x")),
        quiet_until: t + s(92),
    };
    assert_eq!(r.deadline(), Some(t + s(90)));
    let after = clock(r, t + s(90));
    assert_eq!(
        after,
        quiet(Some(gone(Cause::Down, "x"))).with_quiet_until(t + s(92))
    );
    assert_eq!(
        clock(after, t + s(92)),
        P::Unreachable { reason: "x".into() }
    );
    for shown in [
        P::Connected { restart_ends: None },
        P::Connecting,
        P::Unreachable { reason: "x".into() },
        P::StartingRunner { reason: "x".into() },
        P::Lost { reason: "y".into() },
        P::Refused {
            reason: "z".into(),
            quiet_until: t,
        },
    ] {
        assert_eq!(shown.deadline(), None, "{shown:?}");
    }
}

impl ConnectionPhase {
    fn with_quiet_until(self, at: Instant) -> ConnectionPhase {
        match self {
            ConnectionPhase::Quiet { gone, .. } => ConnectionPhase::Quiet {
                gone,
                quiet_until: at,
            },
            other => other,
        }
    }
}

#[test]
fn what_each_phase_says() {
    use ConnectionPhase as P;
    let t = Instant::now();
    let b = |p: P| banner(&p, t);
    assert_eq!(b(P::Connected { restart_ends: None }), None);
    assert_eq!(
        b(P::Quiet {
            gone: None,
            quiet_until: t + s(1)
        }),
        None
    );
    let now = b(P::Connected {
        restart_ends: Some(t + s(1)),
    })
    .unwrap();
    assert_eq!(
        (now.quiet, now.icon, now.text, now.buttons),
        (true, None, "The runner is restarting now.", Buttons::None)
    );
    let back = b(P::Restarting {
        ends: t + s(1),
        gone: Some(gone(Cause::Refused, "r")),
        quiet_until: t,
    })
    .unwrap();
    assert_eq!(
        (back.quiet, back.text, back.detail, back.buttons),
        (
            true,
            "The runner is restarting. Reconnecting…",
            None,
            Buttons::None
        )
    );
    let connecting = b(P::Connecting).unwrap();
    assert_eq!(
        (
            connecting.quiet,
            connecting.icon,
            connecting.text,
            connecting.detail
        ),
        (
            false,
            Some("bolt.horizontal"),
            "Connecting to the runner…",
            None
        )
    );
    assert_eq!(connecting.buttons, Buttons::TryAgain);
    let down = b(P::Unreachable {
        reason: "Nothing is answering.".into(),
    })
    .unwrap();
    assert_eq!(
        (down.icon, down.text, down.detail.as_deref(), down.buttons),
        (
            Some("bolt.horizontal.circle"),
            "Can't reach the runner.",
            Some("Nothing is answering."),
            Buttons::StartRunnerAndTryAgain { starting: false }
        )
    );
    assert_eq!(
        b(P::StartingRunner { reason: "x".into() }).unwrap().buttons,
        Buttons::StartRunnerAndTryAgain { starting: true }
    );
    let lost = b(P::Lost {
        reason: String::new(),
    })
    .unwrap();
    assert_eq!(
        (lost.text, lost.detail, lost.buttons),
        (
            "Lost the connection to the runner. Reconnecting…",
            None,
            Buttons::TryAgain
        )
    );
    let refused = b(P::Refused {
        reason: "The runner turned down the sign-in: bad token".into(),
        quiet_until: t + s(3),
    })
    .unwrap();
    assert_eq!(
        (refused.icon, refused.text, refused.buttons),
        (
            Some("lock"),
            "The runner didn't accept the token in secrets/runner-token.",
            Buttons::TryAgain
        )
    );
}

/// A banner drawn late, after a deadline whose Clock hasn't come yet, is
/// already what the Clock will make it.
#[test]
fn the_banner_goes_by_the_time_its_drawn() {
    let t = Instant::now();
    let quiet = ConnectionPhase::opening(t);
    assert_eq!(text(&quiet, t + s(2)), None);
    assert_eq!(text(&quiet, t + s(4)), Some("Connecting to the runner…"));
}

/// The two races the old fields recorded in their comments, replayed.
mod races {
    use super::*;

    /// app.rs's `restart_outage` (13 Nov, red on all three CI systems): the
    /// client ends its restart as soon as the new runner says hello, a
    /// moment before that Connected reaches the app. Read live in between,
    /// the banner saw no restart, a runner down past the grace, and said
    /// "Can't reach the runner." at the very end of a restart.
    #[test]
    fn the_end_of_a_restart_is_still_a_restart() {
        let t = Instant::now();
        let ends = Some(t + PATIENCE);
        let mut p = ConnectionPhase::Connected { restart_ends: None };
        p = p.next(Event::Restart { ends }, t);
        assert_eq!(text(&p, t), Some("The runner is restarting now."));
        p = p.next(
            Event::Disconnected {
                gone: gone(Cause::Lost, "closed"),
                restart_ends: ends,
            },
            t + s(1),
        );
        for at in [2, 4, 6] {
            p = p.next(
                Event::Disconnected {
                    gone: gone(Cause::Down, "refused"),
                    restart_ends: ends,
                },
                t + s(at),
            );
        }
        // The client has its new runner and has dropped its restart; the
        // last try's failure, or the next try, reaches the app first.
        p = p.next(Event::Connecting { restart_ends: None }, t + s(7));
        p = p.next(Event::Clock, t + s(8));
        assert_eq!(
            text(&p, t + s(8)),
            Some("The runner is restarting. Reconnecting…")
        );
        p = p.next(Event::Connected { restart_ends: None }, t + s(8));
        assert_eq!(text(&p, t + s(8)), None);
    }

    /// header.rs's banner (13 Nov): back already, as the client has it,
    /// while the app hasn't taken in the news. The old banner read the
    /// client's status and restart live to get past this; the phase only
    /// moves on what the app has heard, so a draw in between is still the
    /// restart's.
    #[test]
    fn a_draw_before_the_app_hears_its_connected() {
        let t = Instant::now();
        let ends = Some(t + PATIENCE);
        let p = ConnectionPhase::Connected { restart_ends: None }
            .next(Event::Restart { ends }, t)
            .next(
                Event::Disconnected {
                    gone: gone(Cause::Lost, "closed"),
                    restart_ends: ends,
                },
                t + s(1),
            );
        // The client is connected and its restart is over; nothing has
        // reached the app. Every draw from here says the same.
        for at in [2, 5, 30, 89] {
            assert_eq!(
                text(&p, t + s(at)),
                Some("The runner is restarting. Reconnecting…")
            );
        }
    }
}

/// features/connection.feature's scenarios, as the events the app hears.
mod specs {
    use super::*;

    fn connected() -> ConnectionPhase {
        ConnectionPhase::Connected { restart_ends: None }
    }

    fn drop_with(p: ConnectionPhase, cause: Cause, at: Instant) -> ConnectionPhase {
        p.next(
            Event::Disconnected {
                gone: gone(cause, "why"),
                restart_ends: None,
            },
            at,
        )
    }

    /// "The bar says when the runner can't be reached, and goes once it's
    /// back", and "A runner that goes without a word is mentioned only after
    /// a few seconds, in plain words".
    #[test]
    fn a_runner_gone_without_a_word() {
        let t = Instant::now();
        let mut p = drop_with(connected(), Cause::Lost, t);
        for at in [0, 1, 2] {
            p = drop_with(
                p.next(Event::Connecting { restart_ends: None }, t + s(at)),
                Cause::Down,
                t + s(at),
            );
            assert_eq!(text(&p, t + s(at)), None, "{at}s in");
        }
        assert_eq!(p.deadline(), Some(t + DROP_GRACE));
        p = p.next(Event::Clock, t + DROP_GRACE);
        let b = banner(&p, t + DROP_GRACE).unwrap();
        assert_eq!(b.text, "Can't reach the runner.");
        assert_eq!(b.detail.as_deref(), Some("why"));
        p = p.next(Event::Connected { restart_ends: None }, t + s(8));
        assert_eq!(banner(&p, t + s(8)), None);
        assert_eq!(p.name(), "connected");
    }

    /// "While the runner restarts, the only word is that it's restarting".
    #[test]
    fn a_restart_is_quiet_from_start_to_end() {
        let t = Instant::now();
        let ends = Some(t + PATIENCE);
        let mut p = connected().next(Event::Restart { ends }, t);
        assert_eq!(text(&p, t), Some("The runner is restarting now."));
        p = p.next(
            Event::Disconnected {
                gone: gone(Cause::Lost, "closed"),
                restart_ends: ends,
            },
            t,
        );
        for at in 1..=5 {
            p = p
                .next(Event::Connecting { restart_ends: ends }, t + s(at))
                .next(
                    Event::Disconnected {
                        gone: gone(Cause::Down, "refused"),
                        restart_ends: ends,
                    },
                    t + s(at),
                );
            let b = banner(&p, t + s(at)).unwrap();
            assert!(b.quiet && b.buttons == Buttons::None && b.detail.is_none());
        }
        assert_eq!(
            p.next(Event::Connected { restart_ends: None }, t + s(6)),
            connected()
        );
    }

    /// A restart whose "restarting now" went down with the socket: the
    /// client turns its pending restart into one under way as it drops.
    #[test]
    fn a_pending_restart_that_drops_is_under_way() {
        let t = Instant::now();
        let p = drop_with(connected(), Cause::Lost, t);
        assert_eq!(
            text(&p, t + s(5)),
            Some("Lost the connection to the runner. Reconnecting…")
        );
        let p = connected().next(
            Event::Disconnected {
                gone: gone(Cause::Lost, "closed"),
                restart_ends: Some(t + PATIENCE),
            },
            t,
        );
        assert_eq!(
            text(&p, t + s(5)),
            Some("The runner is restarting. Reconnecting…")
        );
    }

    /// A restart that goes on past its patience is a runner that's down.
    #[test]
    fn a_restart_that_never_ends_is_a_runner_down() {
        let t = Instant::now();
        let ends = Some(t + PATIENCE);
        let mut p = connected().next(Event::Restart { ends }, t).next(
            Event::Disconnected {
                gone: gone(Cause::Down, "Nothing is answering."),
                restart_ends: ends,
            },
            t,
        );
        assert_eq!(p.deadline(), Some(t + PATIENCE));
        p = p.next(Event::Clock, t + PATIENCE);
        assert_eq!(
            p,
            ConnectionPhase::Unreachable {
                reason: "Nothing is answering.".into()
            }
        );
        // The client's restart is still the old one; it's over.
        p = p.next(
            Event::Disconnected {
                gone: gone(Cause::Down, "Nothing is answering."),
                restart_ends: ends,
            },
            t + s(100),
        );
        assert_eq!(text(&p, t + s(100)), Some("Can't reach the runner."));
    }

    /// Opening with no runner: quiet for the grace, then Start runner, which
    /// spins until launchctl has answered, then Connecting until that try
    /// has an answer.
    #[test]
    fn opening_with_no_runner_and_starting_it() {
        let t = Instant::now();
        let mut p = ConnectionPhase::opening(t)
            .next(Event::Connecting { restart_ends: None }, t)
            .next(
                Event::Disconnected {
                    gone: gone(Cause::Down, "x"),
                    restart_ends: None,
                },
                t,
            );
        assert_eq!(text(&p, t + s(2)), None);
        p = p.next(Event::Clock, t + DROP_GRACE);
        assert_eq!(p.name(), "down");
        p = p.next(Event::StartRunner, t + s(4));
        assert_eq!(
            banner(&p, t + s(4)).unwrap().buttons,
            Buttons::StartRunnerAndTryAgain { starting: true }
        );
        // Its tries go on failing while launchctl works; it keeps spinning.
        p = p
            .next(Event::Connecting { restart_ends: None }, t + s(4))
            .next(
                Event::Disconnected {
                    gone: gone(Cause::Down, "x"),
                    restart_ends: None,
                },
                t + s(4),
            );
        assert!(matches!(p, ConnectionPhase::StartingRunner { .. }));
        // A second press does nothing.
        assert_eq!(p.clone().next(Event::StartRunner, t + s(4)), p);
        p = p.next(Event::RunnerStarted, t + s(5));
        assert_eq!(text(&p, t + s(5)), Some("Connecting to the runner…"));
        assert_eq!(
            p.next(Event::Connected { restart_ends: None }, t + s(5)),
            connected()
        );
    }

    /// A refused token is said at once: it won't put itself right.
    #[test]
    fn a_refused_token_is_said_at_once() {
        let t = Instant::now();
        let p = drop_with(connected(), Cause::Refused, t);
        assert_eq!(
            text(&p, t),
            Some("The runner didn't accept the token in secrets/runner-token.")
        );
        assert_eq!(p.name(), "unauthorized");
        // Try again: Connecting, once the drop's grace is over.
        let again = p.next(Event::TryAgain, t + s(10));
        assert_eq!(again, ConnectionPhase::Connecting);
    }

    /// The restart a `runner.status` answer starts while connected runs out
    /// too: before, only a notice's restart had a redraw at its end, so a
    /// line from `runner.status` stayed up until something else redrew.
    #[test]
    fn a_restart_runner_status_started_has_a_deadline() {
        let t = Instant::now();
        let p = connected().next(
            Event::Restart {
                ends: Some(t + PATIENCE),
            },
            t,
        );
        assert_eq!(p.deadline(), Some(t + PATIENCE));
        let p = p.next(Event::Clock, t + PATIENCE);
        assert_eq!(text(&p, t + PATIENCE), None);
        assert_eq!(p.deadline(), None);
    }
}

/// What the other labs' reviews of the phase found (20 Nov), replayed.
mod reviews {
    use super::*;

    /// Codex: the new runner's "restarting now" can reach the app before
    /// the Connected it follows; Connected brings the client's restart.
    #[test]
    fn a_restart_heard_before_connected_survives_it() {
        let t = Instant::now();
        let ends = Some(t + PATIENCE);
        let p = ConnectionPhase::opening(t)
            .next(Event::Restart { ends }, t)
            .next(Event::Connected { restart_ends: ends }, t);
        assert_eq!(text(&p, t + s(1)), Some("The runner is restarting now."));
    }

    /// Codex and Gemini: Try again, or a try that goes before hello, while
    /// launchctl works left Start runner pressable again.
    #[test]
    fn start_runner_stays_spinning_until_its_launch_answers() {
        let t = Instant::now();
        let mut p = ConnectionPhase::Unreachable { reason: "x".into() }
            .next(Event::StartRunner, t)
            .next(Event::TryAgain, t);
        for gone_ in [gone(Cause::Lost, "closed"), gone(Cause::Down, "x")] {
            p = p.next(Event::Connecting { restart_ends: None }, t).next(
                Event::Disconnected {
                    gone: gone_,
                    restart_ends: None,
                },
                t,
            );
            assert_eq!(
                banner(&p, t).map(|b| b.buttons),
                Some(Buttons::StartRunnerAndTryAgain { starting: true })
            );
        }
        assert_eq!(p.next(Event::RunnerStarted, t), ConnectionPhase::Connecting);
    }

    /// Gemini: an event that beats a late Clock finds the phase as the
    /// banner already showed it. Start runner, drawn once the grace is
    /// over, starts it.
    #[test]
    fn an_event_before_a_late_clock_sees_the_deadline_passed() {
        let t = Instant::now();
        let quiet = ConnectionPhase::Quiet {
            gone: Some(gone(Cause::Down, "x")),
            quiet_until: t + DROP_GRACE,
        };
        let late = t + DROP_GRACE + Duration::from_millis(10);
        assert_eq!(
            quiet.next(Event::StartRunner, late),
            ConnectionPhase::StartingRunner { reason: "x".into() }
        );
        // And a restart past its patience gives way to a new one.
        let old = ConnectionPhase::Restarting {
            ends: t + s(90),
            gone: Some(gone(Cause::Down, "x")),
            quiet_until: t,
        };
        let new = Some(t + s(200));
        assert!(matches!(
            old.next(Event::Restart { ends: new }, t + s(100)),
            ConnectionPhase::Restarting { ends, .. } if Some(ends) == new
        ));
    }
}

/// The app's connection fields and banner before the phase (desktop/gpui's
/// app.rs and header.rs at 981960460), kept to run the same sequences
/// through both.
mod legacy {
    use super::*;

    pub enum St {
        Connected,
        Connecting,
        Gone(Gone),
    }

    /// What the old banner read from the client live.
    pub struct Live {
        pub connected: bool,
        pub restart_ends: Option<Instant>,
    }

    pub struct Legacy {
        status_connected: bool,
        status_gone: Option<Gone>,
        last_drop: Option<Gone>,
        dropped_at: Option<Instant>,
        restart_outage: Option<Instant>,
        pub starting_runner: bool,
    }

    impl Legacy {
        pub fn new(now: Instant) -> Legacy {
            Legacy {
                status_connected: false,
                status_gone: None,
                last_drop: None,
                dropped_at: Some(now),
                restart_outage: None,
                starting_runner: false,
            }
        }

        fn note_restart_outage(&mut self, restart_ends: Option<Instant>) {
            if let Some(ends) = restart_ends {
                self.restart_outage.get_or_insert(ends);
            }
        }

        /// `on_seen`'s `Seen::Status`, with the client's restart then.
        pub fn status(&mut self, status: &St, now: Instant, restart_ends: Option<Instant>) {
            match status {
                St::Connected => {
                    self.last_drop = None;
                    self.dropped_at = None;
                    self.restart_outage = None;
                }
                St::Gone(g) => {
                    self.last_drop = Some(g.clone());
                    self.note_restart_outage(restart_ends);
                    self.dropped_at.get_or_insert(now);
                }
                St::Connecting => {
                    self.note_restart_outage(restart_ends);
                    self.dropped_at.get_or_insert(now);
                }
            }
            self.status_connected = matches!(status, St::Connected);
            self.status_gone = match status {
                St::Gone(g) => Some(g.clone()),
                St::Connected | St::Connecting => None,
            };
        }

        /// A restart notice, or `runner.status`'s answer.
        pub fn restart(&mut self, restart_ends: Option<Instant>) {
            if !self.status_connected {
                self.note_restart_outage(restart_ends);
            }
        }

        pub fn try_again(&mut self) {
            self.last_drop = None;
        }

        /// `connection()`.
        fn connection(&self) -> Option<Option<Gone>> {
            if self.status_connected {
                return None;
            }
            Some(self.status_gone.clone().or_else(|| self.last_drop.clone()))
        }

        /// The dump's `connection`.
        pub fn name(&self) -> &'static str {
            match self.connection() {
                None => "connected",
                Some(None) => "connecting",
                Some(Some(g)) => match g.cause {
                    Cause::Down => "down",
                    Cause::Lost => "lost",
                    Cause::Refused => "unauthorized",
                },
            }
        }

        /// `connection_banner`, the connection's part.
        pub fn banner(&self, now: Instant, live: &Live) -> Option<Banner> {
            let restarting = live.restart_ends.is_some_and(|e| now < e);
            let mut connection = self.connection();
            if connection.is_some() && live.connected {
                connection = None;
            }
            let quiet = |text| Banner {
                quiet: true,
                icon: None,
                text,
                detail: None,
                buttons: Buttons::None,
            };
            let Some(connection) = connection else {
                return restarting.then(|| quiet("The runner is restarting now."));
            };
            let outage = self.restart_outage.is_some_and(|e| now < e);
            if restarting || outage {
                return Some(quiet("The runner is restarting. Reconnecting…"));
            }
            let refused = matches!(&connection, Some(g) if g.cause == Cause::Refused);
            if !refused && self.dropped_at.is_some_and(|at| now < at + DROP_GRACE) {
                return None;
            }
            let warning = |icon, text, detail: Option<&str>, buttons| Banner {
                quiet: false,
                icon: Some(icon),
                text,
                detail: detail.filter(|d| !d.is_empty()).map(str::to_owned),
                buttons,
            };
            Some(match connection {
                Some(Gone {
                    cause: Cause::Down,
                    reason,
                }) => warning(
                    "bolt.horizontal.circle",
                    "Can't reach the runner.",
                    Some(&reason),
                    Buttons::StartRunnerAndTryAgain {
                        starting: self.starting_runner,
                    },
                ),
                Some(Gone {
                    cause: Cause::Lost,
                    reason,
                }) => warning(
                    "bolt.horizontal",
                    "Lost the connection to the runner. Reconnecting…",
                    Some(&reason),
                    Buttons::TryAgain,
                ),
                Some(Gone {
                    cause: Cause::Refused,
                    reason,
                }) => warning(
                    "lock",
                    "The runner didn't accept the token in secrets/runner-token.",
                    Some(&reason),
                    Buttons::TryAgain,
                ),
                None => warning(
                    "bolt.horizontal",
                    "Connecting to the runner…",
                    None,
                    Buttons::TryAgain,
                ),
            })
        }
    }
}

/// The client as these tests drive it: connected or not, and its restart
/// (client/src/restart.rs's `Phase`, by when it ends).
#[derive(Clone, Copy, PartialEq)]
enum Restart {
    None,
    Pending,
    Under(Instant),
}

#[derive(Clone, Copy, Debug)]
enum Step {
    Wait(u64),
    /// The runner said hello: the client's restart is over first.
    Connect,
    /// The connection went (Lost) or a try failed (Down or Refused).
    Drop(Cause),
    /// The client begins a try.
    Try,
    /// A notice, while connected: pending, restarting now, cancelled.
    Pending,
    RestartingNow,
    Cancelled,
    /// `runner.status`'s answer says the restart is now.
    StatusNow,
    TryAgain,
    /// The runner said hello, and the new runner's "restarting now" reached
    /// the app first.
    ConnectAndRestart,
    /// Start runner, launchctl taking `.0` ms, and meanwhile: 0 nothing, 1
    /// a failed try, 2 Try again and a failed try, 3 a try that went before
    /// hello and a failed one.
    StartRunner(u64, u8),
}

/// Old and new side by side, every event delivered as the app hears it.
struct Both {
    now: Instant,
    connected: bool,
    restart: Restart,
    old: legacy::Legacy,
    new: ConnectionPhase,
}

impl Both {
    fn new(t: Instant) -> Both {
        Both {
            now: t,
            connected: false,
            restart: Restart::None,
            old: legacy::Legacy::new(t),
            new: ConnectionPhase::opening(t),
        }
    }

    fn ends(&self) -> Option<Instant> {
        match self.restart {
            Restart::Under(since) => Some(since + PATIENCE),
            Restart::None | Restart::Pending => None,
        }
    }

    fn deliver(&mut self, event: Event) {
        self.new = self.new.clone().next(event, self.now);
    }

    fn status(&mut self, status: legacy::St) {
        let ends = self.ends();
        self.old.status(&status, self.now, ends);
        self.deliver(match status {
            legacy::St::Connected => Event::Connected { restart_ends: None },
            legacy::St::Connecting => Event::Connecting { restart_ends: ends },
            legacy::St::Gone(gone) => Event::Disconnected {
                gone,
                restart_ends: ends,
            },
        });
    }

    fn restart_news(&mut self) {
        let ends = self.ends();
        self.old.restart(ends);
        self.deliver(Event::Restart { ends });
    }

    /// The app's timers: a Clock at each deadline on the way.
    fn wait(&mut self, ms: u64) {
        let until = self.now + Duration::from_millis(ms);
        while let Some(at) = self.new.deadline().filter(|at| *at <= until) {
            self.now = at;
            self.deliver(Event::Clock);
        }
        self.now = until;
    }

    fn step(&mut self, step: Step) {
        match step {
            Step::Wait(ms) => self.wait(ms),
            Step::Connect => {
                self.restart = Restart::None;
                self.connected = true;
                self.status(legacy::St::Connected);
            }
            Step::ConnectAndRestart => {
                self.connected = true;
                self.restart = Restart::Under(self.now);
                let ends = self.ends();
                self.deliver(Event::Restart { ends });
                self.old.status(&legacy::St::Connected, self.now, ends);
                self.deliver(Event::Connected { restart_ends: ends });
            }
            Step::Drop(cause) => {
                let cause = if self.connected { Cause::Lost } else { cause };
                if self.restart == Restart::Pending {
                    self.restart = Restart::Under(self.now);
                }
                self.connected = false;
                self.status(legacy::St::Gone(gone(cause, "why")));
            }
            Step::Try => {
                if !self.connected {
                    self.status(legacy::St::Connecting);
                }
            }
            Step::Pending | Step::RestartingNow | Step::Cancelled | Step::StatusNow => {
                if !self.connected {
                    return;
                }
                self.restart = match (step, self.restart) {
                    (Step::Pending, _) => Restart::Pending,
                    (Step::Cancelled, _) => Restart::None,
                    (_, Restart::Under(since)) => Restart::Under(since),
                    (_, Restart::None | Restart::Pending) => Restart::Under(self.now),
                };
                self.restart_news();
            }
            Step::TryAgain => {
                if self.connected {
                    return;
                }
                self.old.try_again();
                self.deliver(Event::TryAgain);
                // The client stops waiting and tries.
                self.status(legacy::St::Connecting);
            }
            Step::StartRunner(ms, meanwhile) => {
                let shown = banner(&self.new, self.now);
                if !matches!(
                    shown.map(|b| b.buttons),
                    Some(Buttons::StartRunnerAndTryAgain { starting: false })
                ) {
                    return;
                }
                self.old.starting_runner = true;
                self.deliver(Event::StartRunner);
                self.compare("pressed Start runner");
                match meanwhile {
                    1 => {
                        self.step(Step::Try);
                        self.step(Step::Drop(Cause::Down));
                    }
                    2 => {
                        self.step(Step::TryAgain);
                        self.step(Step::Drop(Cause::Down));
                    }
                    3 => {
                        self.step(Step::Try);
                        self.status(legacy::St::Gone(gone(Cause::Lost, "closed")));
                        self.step(Step::Try);
                        self.step(Step::Drop(Cause::Down));
                    }
                    _ => {}
                }
                self.wait(ms);
                self.compare("launchctl working");
                self.old.starting_runner = false;
                self.old.try_again();
                self.deliver(Event::RunnerStarted);
                self.status(legacy::St::Connecting);
            }
        }
    }

    fn compare(&self, after: &str) {
        let live = legacy::Live {
            connected: self.connected,
            restart_ends: self.ends(),
        };
        assert_eq!(
            banner(&self.new, self.now),
            self.old.banner(self.now, &live),
            "the banners differ after {after}, in {:?}",
            self.new
        );
        assert_eq!(
            self.new.name(),
            self.old.name(),
            "the names differ after {after}"
        );
    }
}

fn run(steps: &[Step]) {
    let mut both = Both::new(Instant::now());
    for (i, step) in steps.iter().enumerate() {
        both.step(*step);
        both.compare(&format!("step {i} ({step:?}) of {steps:?}"));
    }
}

/// The specs' and races' sequences, old and new.
#[test]
fn old_and_new_say_the_same_for_the_spec_sequences() {
    use Step::*;
    let down = Drop(Cause::Down);
    // Gone without a word.
    run(&[
        Connect,
        Drop(Cause::Lost),
        Wait(500),
        Try,
        down,
        Wait(1000),
        Try,
        down,
        Wait(1000),
        Try,
        down,
        Wait(600),
        Try,
        down,
        Wait(5000),
        Try,
        Connect,
    ]);
    // A restart, with its notice first.
    run(&[
        Connect,
        Pending,
        Wait(2000),
        RestartingNow,
        Wait(100),
        Drop(Cause::Lost),
        Try,
        down,
        Wait(500),
        Try,
        down,
        Wait(4000),
        Try,
        Connect,
        Wait(100),
    ]);
    // One whose notice went down with the socket.
    run(&[
        Connect,
        Pending,
        Drop(Cause::Lost),
        Wait(4000),
        Try,
        down,
        Wait(500),
        Connect,
    ]);
    // One that never ends.
    run(&[
        Connect,
        StatusNow,
        Drop(Cause::Lost),
        Wait(60_000),
        Try,
        down,
        Wait(31_000),
        Try,
        down,
        Wait(1000),
        TryAgain,
        Wait(100),
        down,
        Wait(1000),
        Connect,
    ]);
    // Opening with no runner, then Start runner.
    run(&[
        Try,
        down,
        Wait(1000),
        Try,
        down,
        Wait(2500),
        Try,
        down,
        StartRunner(700, 1),
        Wait(100),
        down,
        Wait(500),
        Connect,
    ]);
    // Refused, and Try again.
    run(&[
        Try,
        Drop(Cause::Refused),
        Wait(1000),
        Try,
        Drop(Cause::Refused),
        TryAgain,
        Drop(Cause::Refused),
        Wait(5000),
        TryAgain,
        Drop(Cause::Refused),
        Connect,
    ]);
    // A cancelled restart while connected.
    run(&[
        Connect,
        StatusNow,
        Wait(1000),
        Cancelled,
        Wait(100),
        RestartingNow,
        Wait(91_000),
    ]);
}

/// Thousands of made-up sequences, old and new.
#[test]
fn old_and_new_say_the_same_for_made_up_sequences() {
    // A small fixed generator, so a failure is the same every run.
    let mut seed: u64 = 0x5eed_c0de;
    let mut next = move |n: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let waits = [50, 500, 1000, 2900, 3100, 10_000, 45_000, 89_000, 91_000];
    let causes = [Cause::Down, Cause::Down, Cause::Refused];
    for _ in 0..3000 {
        let len = 4 + next(24) as usize;
        let steps: Vec<Step> = (0..len)
            .map(|_| match next(14) {
                0 | 1 => Step::Wait(waits[next(waits.len() as u64) as usize]),
                2 => Step::Connect,
                3 | 4 => Step::Drop(causes[next(3) as usize]),
                5 | 6 => Step::Try,
                7 => Step::Pending,
                8 => Step::RestartingNow,
                9 => Step::Cancelled,
                10 => Step::StatusNow,
                11 => Step::TryAgain,
                12 => Step::ConnectAndRestart,
                _ => Step::StartRunner(200 + next(1500), next(4) as u8),
            })
            .collect();
        run(&steps);
    }
}
