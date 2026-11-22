// Confetti for the rare wins: a burst of small coloured bits that pops out
// of where something good just happened, falls and fades. Mike picked it
// from three directions on 18 Nov (a quiet tick and glow, a paw stamp,
// confetti), for the year-long token landing on a login's Usage row and
// the inbox reaching zero, and only for wins that rare: on every thread
// finishing it would soon be noise. The same day he added a thread
// milestone, a login signed back in and Finish setting up's last tick.
//
// Everything here is a function of the time since the burst started, so a
// frame the main thread misses is skipped rather than slowing it down, and
// the same seed always throws the same bits.
use std::time::Duration;

/// How long a burst lasts, its slowest bit included.
pub const CONFETTI: Duration = Duration::from_millis(1700);

/// How many bits, and how far they fly (1 is the inbox's; the token's row is
/// smaller, so its burst is too).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Burst {
    pub count: usize,
    pub spread: f32,
}

/// A login getting its year-long token: a burst from its row.
pub const TOKEN_BURST: Burst = Burst {
    count: 46,
    spread: 0.75,
};
/// The last thread leaving the inbox: a bigger one from the empty inbox.
pub const INBOX_BURST: Burst = Burst {
    count: 90,
    spread: 1.1,
};
/// A thread milestone (100 threads, then each thousand): from its note.
pub const MILESTONE_BURST: Burst = INBOX_BURST;
/// A login signed back in after being signed out: from its row, as a token.
pub const SIGNED_IN_BURST: Burst = TOKEN_BURST;
/// The last item of Finish setting up ticking itself: from "All set."
pub const SETUP_BURST: Burst = INBOX_BURST;

/// Whether Finish setting up has just been finished: something was left the
/// last time it was looked at and nothing is now. Never when it was already
/// done the first time it's seen (someone long set up opening the list).
pub fn setup_finished(before: Option<usize>, left: usize) -> bool {
    left == 0 && before.is_some_and(|b| b > 0)
}

/// The colours a bit can be, as hex: the accent blue, green, honey, pink,
/// purple and yellow (the mockup's).
pub const COLOURS: [u32; 6] = [0x0a84ff, 0x32d74b, 0xf2a93b, 0xff375f, 0xbf5af2, 0xffd60a];

/// One bit: how it leaves (points a second, up is negative), how fast it
/// turns (degrees a second), its size in points, its colour (an index into
/// `COLOURS`), whether it's round, a moment's delay and how long it lasts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bit {
    pub vx: f32,
    pub vy: f32,
    pub gravity: f32,
    pub spin: f32,
    pub width: f32,
    pub height: f32,
    pub colour: usize,
    pub round: bool,
    pub delay: f32,
    pub life: f32,
}

/// Where a bit is `t` seconds into the burst: its offset from where the
/// burst started, in points, turned `angle` degrees, at `opacity`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BitAt {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub opacity: f32,
}

/// A small seeded random (a Lehmer generator), so a burst is the same
/// every frame it's drawn.
struct Random(u64);

impl Random {
    fn new(seed: u64) -> Self {
        Random(seed % 2_147_483_646 + 1)
    }
    fn next(&mut self) -> f32 {
        self.0 = self.0 * 16_807 % 2_147_483_647;
        self.0 as f32 / 2_147_483_647.
    }
}

/// The bits of a burst. They leave upwards in a fan about 225 degrees wide,
/// so most rise first and then fall past where they started.
pub fn bits(seed: u64, burst: Burst) -> Vec<Bit> {
    let mut r = Random::new(seed);
    (0..burst.count)
        .map(|i| {
            let width = 2. + r.next() * 2.2;
            let height = width * (1. + r.next() * 1.4);
            let round = r.next() < 0.3;
            let angle =
                -std::f32::consts::FRAC_PI_2 + (r.next() - 0.5) * std::f32::consts::PI * 1.25;
            let speed = (60. + r.next() * 110.) * burst.spread;
            let spin = (r.next() - 0.5) * 1440.;
            let life = 1.1 + r.next() * 0.5;
            let delay = r.next() * 0.04;
            Bit {
                vx: angle.cos() * speed,
                vy: angle.sin() * speed,
                gravity: 260. * burst.spread,
                spin,
                width,
                height,
                colour: i % COLOURS.len(),
                round,
                delay,
                life,
            }
        })
        .collect()
}

/// A bit `t` seconds into the burst, or None before it leaves and once it's
/// gone. It's whole for its first two thirds and fades over the last.
pub fn bit_at(bit: &Bit, t: f32) -> Option<BitAt> {
    let t = t - bit.delay;
    if t < 0. || t >= bit.life {
        return None;
    }
    let fade_from = bit.life * 2. / 3.;
    let opacity = if t < fade_from {
        1.
    } else {
        1. - (t - fade_from) / (bit.life - fade_from)
    };
    Some(BitAt {
        x: bit.vx * t,
        y: bit.vy * t + 0.5 * bit.gravity * t * t,
        angle: bit.spin * t,
        opacity,
    })
}

/// Whether a burst `t` seconds in still has anything to draw.
pub fn going(t: f32) -> bool {
    t < CONFETTI.as_secs_f32()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_throws_the_same_bits() {
        assert_eq!(bits(42, INBOX_BURST), bits(42, INBOX_BURST));
        assert_ne!(bits(42, INBOX_BURST), bits(43, INBOX_BURST));
        assert_eq!(bits(0, TOKEN_BURST).len(), TOKEN_BURST.count);
    }

    #[test]
    fn bits_rise_then_fall_and_fade_out_within_the_burst() {
        let all = bits(7, INBOX_BURST);
        // Most leave upwards.
        assert!(all.iter().filter(|b| b.vy < 0.).count() > all.len() * 2 / 3);
        for b in &all {
            assert!(bit_at(b, 0.).is_none_or(|a| a.x == 0. && a.y == 0.));
            assert!(b.delay + b.life <= CONFETTI.as_secs_f32());
            let late = bit_at(b, b.delay + b.life * 0.6).unwrap();
            assert_eq!(late.opacity, 1.);
            let end = bit_at(b, b.delay + b.life * 0.99).unwrap();
            assert!(end.opacity < 0.1);
            assert!(bit_at(b, CONFETTI.as_secs_f32()).is_none());
        }
        // By the end, gravity has them on their way down.
        let falling = all
            .iter()
            .filter(|b| b.vy + b.gravity * b.life * 0.9 > 0.)
            .count();
        assert_eq!(falling, all.len());
        assert!(!going(CONFETTI.as_secs_f32()));
    }

    #[test]
    fn setup_is_finished_only_when_something_was_left_before() {
        assert!(setup_finished(Some(1), 0));
        assert!(!setup_finished(None, 0));
        assert!(!setup_finished(Some(0), 0));
        assert!(!setup_finished(Some(2), 1));
    }

    #[test]
    fn the_token_burst_is_smaller_than_the_inbox_one() {
        let reach = |burst: Burst| {
            bits(3, burst)
                .iter()
                .map(|b| b.vx.hypot(b.vy))
                .fold(0., f32::max)
        };
        assert!(reach(TOKEN_BURST) < reach(INBOX_BURST));
        const { assert!(TOKEN_BURST.count < INBOX_BURST.count) };
    }
}
