// The small motions' timings and curves: the Swift app's `Juice` and the
// keyframes its views animate with (app/Sources/Threadbear/Views/Juice.swift,
// SidebarView, ComposerControls, WavingBearView, InkLayers), as plain numbers
// the GPUI app draws from (row_motion.rs, rails.rs, composer_card.rs and the
// rest that name it). Everything
// here is a function of the time since the motion started, so a frame the
// main thread misses is skipped rather than slowing the motion down.
use std::time::Duration;

/// A CSS-style cubic Bézier timing curve through (0,0), (x1,y1), (x2,y2),
/// (1,1): how far along at `t` of the time, both 0 to 1.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    if t == 0. || t == 1. {
        return t;
    }
    let curve = |a: f32, b: f32, s: f32| {
        let u = 1. - s;
        3. * u * u * s * a + 3. * u * s * s * b + s * s * s
    };
    // Finds the curve's own parameter whose x is `t`: Newton's steps, then
    // halving if they wander off.
    let mut s = t;
    for _ in 0..8 {
        let x = curve(x1, x2, s) - t;
        if x.abs() < 1e-5 {
            return curve(y1, y2, s);
        }
        let u = 1. - s;
        let dx = 3. * u * u * x1 + 6. * u * s * (x2 - x1) + 3. * s * s * (1. - x2);
        if dx.abs() < 1e-6 {
            break;
        }
        s = (s - x / dx).clamp(0., 1.);
    }
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..30 {
        s = (lo + hi) / 2.;
        if curve(x1, x2, s) < t {
            lo = s;
        } else {
            hi = s;
        }
    }
    curve(y1, y2, s)
}

/// `CAMediaTimingFunction(controlPoints: 0, 0, 0.2, 1)`: quick out of the
/// blocks, settling gently. The send lift and the card settling in use it.
pub fn ease_out_settle(t: f32) -> f32 {
    cubic_bezier(0., 0., 0.2, 1., t)
}

/// A spring from 0 to 1 after `t` seconds, as SwiftUI's
/// `.spring(response:dampingFraction:)`: under 1 it overshoots and settles.
pub fn spring(t: f32, response: f32, damping: f32) -> f32 {
    if t <= 0. {
        return 0.;
    }
    let omega = std::f32::consts::TAU / response;
    if damping >= 1. {
        return 1. - (1. + omega * t) * (-omega * t).exp();
    }
    let root = (1. - damping * damping).sqrt();
    let damped = omega * root;
    1. - (-damping * omega * t).exp() * ((damped * t).cos() + damping / root * (damped * t).sin())
}

/// SwiftUI's `.snappy(duration:)`: a spring with a little bounce whose
/// response is the duration.
pub fn snappy(t: f32, duration: f32) -> f32 {
    spring(t, duration, 0.85)
}

/// A run of keyframes, each `(seconds to get there, value)`, from `start`:
/// eased in and out between each, as SwiftUI's `CubicKeyframe` near enough
/// for motions this small. Past the end it holds the last value.
#[derive(Clone, Copy, Debug)]
pub struct Track<'a> {
    pub start: f32,
    pub keys: &'a [(f32, f32)],
}

impl Track<'_> {
    pub fn duration(&self) -> f32 {
        self.keys.iter().map(|k| k.0).sum()
    }

    pub fn at(&self, t: f32) -> f32 {
        let (mut from, mut elapsed) = (self.start, 0.);
        for &(length, to) in self.keys {
            if t < elapsed + length {
                let u = ((t - elapsed) / length).clamp(0., 1.);
                return from + (to - from) * u * u * (3. - 2. * u);
            }
            elapsed += length;
            from = to;
        }
        from
    }
}

/// Keyframes at set times, each `(seconds from the start, value)`, eased in
/// and out between, as Core Animation's keyframe animations with
/// `keyTimes` (the working bear's tracks). Before the first, its value.
pub fn timed(keys: &[(f32, f32)], t: f32) -> f32 {
    let Some(&(_, first)) = keys.first() else { return 0. };
    let mut before = (0f32, first);
    for &(at, value) in keys {
        if t < at {
            let span = (at - before.0).max(1e-6);
            let u = ((t - before.0) / span).clamp(0., 1.);
            return before.1 + (value - before.1) * u * u * (3. - 2. * u);
        }
        before = (at, value);
    }
    before.1
}

/// How far along a motion of `length` is after `elapsed`, 0 to 1.
pub fn progress(elapsed: Duration, length: Duration) -> f32 {
    (elapsed.as_secs_f32() / length.as_secs_f32().max(1e-6)).clamp(0., 1.)
}

// MARK: The sidebar's selection

/// The selected row's highlight sliding to the next one: 160 ms on
/// `cubic-bezier(.2, .9, .25, 1)`, the curve Mike picked from the juice
/// mockups (13 Nov); none at all under Reduce Motion.
pub const SELECTION_SLIDE: Duration = Duration::from_millis(160);

pub fn selection_slide(t: f32) -> f32 {
    cubic_bezier(0.2, 0.9, 0.25, 1., t)
}

// MARK: The activity bar

/// The lit square sliding between the view buttons (`Juice.selection`:
/// snappy, 0.2 s), and how long it's given to settle.
pub const LIT_RESPONSE: f32 = 0.2;
pub const LIT_SLIDE: Duration = Duration::from_millis(400);

/// A button's icon after a click: pressed in to 0.82 in 0.08 s, then a
/// bouncy spring home (`.bouncy(duration: 0.35, extraBounce: 0.25)`).
pub const RAIL_BOUNCE: Duration = Duration::from_millis(500);

/// Its scale `t` seconds after the click.
pub fn rail_bounce(t: f32) -> f32 {
    const PRESS: f32 = 0.08;
    if t < PRESS {
        return Track { start: 1., keys: &[(PRESS, 0.82)] }.at(t);
    }
    0.82 + 0.18 * spring(t - PRESS, 0.35, 0.45)
}

/// The sidebar's new view settling in as the activity bar switches it: up
/// 6 points as it fades in, snappy over 0.22 s; a 0.12 s fade under Reduce
/// Motion (SidebarView's transition).
pub const VIEW_SETTLE_RISE: f32 = 6.;
pub const VIEW_SETTLE: Duration = Duration::from_millis(400);

/// The new view's (opacity, distance below its place) `t` seconds in.
pub fn view_settle(t: f32, reduce: bool) -> (f32, f32) {
    if reduce {
        return ((t / 0.12).clamp(0., 1.), 0.);
    }
    let p = snappy(t, 0.22);
    (p.clamp(0., 1.), VIEW_SETTLE_RISE * (1. - p))
}

// MARK: The Librarian's picture

/// The picture's wobble when poked: a squash (x by this, y by 2 minus it)
/// and a tilt from its feet, in degrees (HomePage's keyframes).
pub const WOBBLE: Duration = Duration::from_millis(450);

/// Its (squash, sideways sway in points) `t` seconds after the poke, for a
/// picture `height` tall: the sway is how far its middle moves as it tilts.
pub fn wobble(t: f32, height: f32) -> (f32, f32) {
    let squash = Track { start: 1., keys: &[(0.045, 1.02), (0.11, 1.)] }.at(t);
    let angle = Track { start: 0., keys: &[(0.16, -2.), (0.11, 1.5), (0.1, -0.8), (0.08, 0.)] }.at(t);
    (squash, angle.to_radians().sin() * height / 2.)
}

// MARK: Sending

/// A sent message lifting off the composer into the thread (`SendLift`):
/// it starts a moment after Return, so its first frame is seen, and rises
/// this far as it fades in, on `ease_out_settle`. Under Reduce Motion, a
/// 100 ms fade.
pub const SEND_LIFT_RISE: f32 = 14.;
pub const SEND_LIFT_DELAY: Duration = Duration::from_millis(60);
pub const SEND_LIFT: Duration = Duration::from_millis(170);
pub const SEND_LIFT_REDUCED: Duration = Duration::from_millis(100);

/// The lifting message's (opacity, distance below its place) at `elapsed`
/// since Return.
pub fn send_lift(elapsed: Duration, reduce: bool) -> (f32, f32) {
    if reduce {
        return (progress(elapsed, SEND_LIFT_REDUCED), 0.);
    }
    let t = progress(elapsed.saturating_sub(SEND_LIFT_DELAY), SEND_LIFT);
    let eased = ease_out_settle(t);
    (eased, SEND_LIFT_RISE * (1. - eased))
}

/// Whether a lift started at `elapsed` ago is still going.
pub fn send_lifting(elapsed: Duration, reduce: bool) -> bool {
    elapsed < if reduce { SEND_LIFT_REDUCED } else { SEND_LIFT_DELAY + SEND_LIFT }
}

/// The send arrow's hop as Return lands: up 3 points and back.
pub const SEND_HOP: Duration = Duration::from_millis(120);

/// The arrow's offset (negative is up) `t` seconds after Return.
pub fn send_hop(t: f32) -> f32 {
    Track { start: 0., keys: &[(0.05, -3.), (0.07, 0.)] }.at(t)
}

// MARK: The composer's card

/// A card arriving while the thread's on screen comes up from this far below
/// as it fades in, over 0.2 s on `ease_out_settle` (`ComposerCard`'s
/// arriving card); under Reduce Motion, a 0.15 s fade.
pub const CARD_SETTLE_RISE: f32 = 6.;
pub const CARD_SETTLE: Duration = Duration::from_millis(200);
pub const CARD_SETTLE_REDUCED: Duration = Duration::from_millis(150);

/// The arriving card's (opacity, distance below its place).
pub fn card_settle(elapsed: Duration, reduce: bool) -> (f32, f32) {
    if reduce {
        return (progress(elapsed, CARD_SETTLE_REDUCED), 0.);
    }
    let eased = ease_out_settle(progress(elapsed, CARD_SETTLE));
    (eased, CARD_SETTLE_RISE * (1. - eased))
}

pub fn card_settling(elapsed: Duration, reduce: bool) -> bool {
    elapsed < if reduce { CARD_SETTLE_REDUCED } else { CARD_SETTLE }
}

/// The done card's tick drawing itself on as the card arrives: a beat in,
/// then along its strokes on `cubic-bezier(.3, 0, .2, 1)`; the tick as ever
/// from `TICK_DRAW_END`. Not under Reduce Motion.
pub const TICK_DRAW_DELAY: Duration = Duration::from_millis(40);
pub const TICK_DRAW: Duration = Duration::from_millis(260);
pub const TICK_DRAW_END: Duration = Duration::from_millis(320);

/// How much of the tick's drawn, 0 to 1.
pub fn tick_drawn(elapsed: Duration) -> f32 {
    cubic_bezier(0.3, 0., 0.2, 1., progress(elapsed.saturating_sub(TICK_DRAW_DELAY), TICK_DRAW))
}

// MARK: Picking an answer

/// An answer picked on a card: its button fills with the accent from the
/// left, the tick with it, then hops (Mike picked this from clips on 18 Nov:
/// it's the button he presses most, and it only changed colour). The fill
/// is over before the hop peaks, and both before a paged card moves on to
/// its next ask (300 ms after the click). Not under Reduce Motion.
pub const PICK_FILL: Duration = Duration::from_millis(160);
pub const PICK_HOP_DELAY: Duration = Duration::from_millis(110);
pub const PICK: Duration = Duration::from_millis(270);

/// How much of the button is filled, 0 to 1, from its left edge.
pub fn pick_fill(elapsed: Duration) -> f32 {
    cubic_bezier(0.3, 0., 0.2, 1., progress(elapsed, PICK_FILL))
}

/// The button's offset (negative is up): up 3 points and back.
pub fn pick_hop(elapsed: Duration) -> f32 {
    Track { start: 0., keys: &[(0.06, -3.), (0.09, 0.)] }.at(elapsed.saturating_sub(PICK_HOP_DELAY).as_secs_f32())
}

/// A row's circle ticked (an answer in a list of rows, a follow-up on the
/// done card): its ring pops, a little over its size and back, as the tick
/// draws itself in.
pub const TICK_POP: Duration = Duration::from_millis(240);

/// The ring's size against its own (1 at rest) and how much of the tick is
/// drawn, 0 to 1.
pub fn tick_pop(elapsed: Duration) -> (f32, f32) {
    let t = elapsed.as_secs_f32();
    let scale = timed(&[(0., 0.55), (0.12, 1.18), (0.24, 1.)], t);
    let drawn = cubic_bezier(0.3, 0., 0.2, 1., ((t - 0.05) / 0.16).clamp(0., 1.));
    (scale, drawn)
}

// MARK: A picture pasted or dropped in the box

/// A picture arriving in the message box: the strip over the words opens
/// to its height, and the picture drops into it from above, a touch past
/// its place and back, fading in as it comes (18 Nov, with the answer's
/// fill). Under Reduce Motion it's there at once.
pub const STRIP_OPEN: Duration = Duration::from_millis(150);
pub const PICTURE_DROP_DELAY: Duration = Duration::from_millis(60);
pub const PICTURE_DROP: Duration = Duration::from_millis(320);
pub const PICTURE_DROP_FROM: f32 = -22.;

/// How open the strip is, 0 to 1, when its first picture arrives.
pub fn strip_open(elapsed: Duration) -> f32 {
    ease_out_settle(progress(elapsed, STRIP_OPEN))
}

/// The arriving picture's (opacity, offset from its place; negative is up).
pub fn picture_drop(elapsed: Duration) -> (f32, f32) {
    let t = elapsed.saturating_sub(PICTURE_DROP_DELAY).as_secs_f32();
    if elapsed < PICTURE_DROP_DELAY {
        return (0., PICTURE_DROP_FROM);
    }
    let offset = timed(&[(0., PICTURE_DROP_FROM), (0.17, 3.), (0.25, -1.), (0.32, 0.)], t);
    ((t / 0.12).clamp(0., 1.), offset)
}

pub fn picture_dropping(elapsed: Duration) -> bool {
    elapsed < PICTURE_DROP_DELAY + PICTURE_DROP
}

// MARK: A reply streaming in

/// Each piece of a reply fades in as it lands rather than popping onto the
/// page: over `REPLY_FADE`, each further word of a piece starting
/// `REPLY_FADE_WORD` after the one before (the text view's own stream fade,
/// rows/markdown.rs; 18 Nov). Not under Reduce Motion.
pub const REPLY_FADE: Duration = Duration::from_millis(170);
pub const REPLY_FADE_WORD: Duration = Duration::from_millis(14);

// MARK: The working line's paw

/// While a turn runs, the paw by "Bear with me" does something every
/// `PAW_EVERY`, the first a moment in: one of five moves picked at random
/// each time, never the same twice running (Mike, 13 Nov: "Randomly pick one
/// of those each time", from the paw mockups in place of the old bear).
pub const PAW_EVERY: f32 = 2.4;
pub const PAW_FIRST: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PawMove {
    /// Turns over like a coin.
    Flip,
    /// One quick turn.
    Spin,
    /// Presses down twice, like a cat kneading.
    Knead,
    /// Tilts from its heel.
    Wave,
    /// Three small prints step in and fade, the paw gone meanwhile.
    Prints,
}

impl PawMove {
    const ALL: [PawMove; 5] = [PawMove::Flip, PawMove::Spin, PawMove::Knead, PawMove::Wave, PawMove::Prints];

    /// How long it takes, in seconds.
    pub fn length(self) -> f32 {
        match self {
            PawMove::Flip | PawMove::Wave => 0.9,
            PawMove::Spin => 0.8,
            PawMove::Knead => 0.82,
            PawMove::Prints => 1.5,
        }
    }
}

/// A cheap hash for picking: the same turn picks the same moves however
/// often it's drawn, and the next turn picks others.
fn mix(mut x: u64) -> u64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    x ^ (x >> 33)
}

/// The move the paw makes the `n`th time, for a turn whose seed is `seed`
/// (when it started): random, but never the one before.
///
/// Worked out from `n` alone, at the same small cost however long the turn:
/// each even step is a free pick, and each odd step picks from the moves its
/// two even neighbours didn't, so no two running are the same. It used to
/// walk every step since the turn began, so a turn start years back (a
/// secondary runner can write one, Daybreak 147) froze the app's UI thread.
pub fn paw_move(seed: u64, n: u64) -> PawMove {
    let pick = |i: u64| mix(seed ^ i.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(1));
    let free = |i: u64| PawMove::ALL[(pick(i) % 5) as usize];
    if n % 2 == 0 {
        return free(n);
    }
    let (before, after) = (free(n - 1), free(n.wrapping_add(1)));
    let open: Vec<PawMove> = PawMove::ALL.into_iter().filter(|m| *m != before && *m != after).collect();
    open[(pick(n) % open.len() as u64) as usize]
}

/// The longest a turn's working line counts up from (a week): anything
/// older isn't a turn this app could have watched start, so it's taken as
/// not known.
pub const TURN_START_MAX_AGE: f64 = 7. * 24. * 3600.;
/// How far ahead of this Mac's clock a turn's start may be (another
/// machine's clock running fast) before it's taken as not known.
pub const TURN_START_SKEW: f64 = 5. * 60.;

/// A turn's start (seconds since 1970) as the working line may use it, or
/// None when it can't be real: in the future, older than a week, or before
/// the thread was made (`created`, when known). The start comes from the
/// transcript, which another runner writes for its own threads, so the app
/// checks it against its own clock before timing anything from it.
pub fn turn_start(started: f64, now: f64, created: Option<f64>) -> Option<f64> {
    let real = started.is_finite()
        && started <= now + TURN_START_SKEW
        && started >= now - TURN_START_MAX_AGE
        && created.is_none_or(|c| started >= c - TURN_START_SKEW);
    real.then_some(started)
}

/// Where the paw is: turned (degrees, clockwise), squashed (x, y) and moved
/// (a fraction of its size; down is positive), how much of it shows, and for
/// `Prints` each small print's (opacity, scale) instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PawPose {
    pub angle: f32,
    pub scale: (f32, f32),
    pub shift: (f32, f32),
    pub opacity: f32,
    pub prints: Option<[(f32, f32); 3]>,
}

impl PawPose {
    pub const STILL: PawPose = PawPose { angle: 0., scale: (1., 1.), shift: (0., 0.), opacity: 1., prints: None };
}

/// The move under way `t` seconds into a turn, if any, and how far in.
pub fn paw_now(seed: u64, t: f32) -> Option<(PawMove, f32)> {
    if t < PAW_FIRST {
        return None;
    }
    let n = ((t - PAW_FIRST) / PAW_EVERY).floor();
    let into = t - PAW_FIRST - n * PAW_EVERY;
    let step = paw_move(seed, n as u64);
    (into < step.length()).then_some((step, into))
}

/// The paw `t` seconds into a turn.
pub fn paw_pose(seed: u64, t: f32) -> PawPose {
    let Some((step, into)) = paw_now(seed, t) else { return PawPose::STILL };
    let u = (into / step.length()).clamp(0., 1.);
    // A turn about a point other than the middle (which GPUI turns icons
    // about): the move that puts that point back, as a fraction of the size.
    let about = |angle: f32, (px, py): (f32, f32)| {
        let (vx, vy) = (px - 0.5, py - 0.5);
        let (s, c) = angle.to_radians().sin_cos();
        (vx - (c * vx - s * vy), vy - (s * vx + c * vy))
    };
    match step {
        PawMove::Flip => {
            let turn = (u * std::f32::consts::TAU).cos();
            PawPose { scale: (turn, 1.), opacity: 0.6 + 0.4 * turn.abs(), ..PawPose::STILL }
        }
        PawMove::Spin => PawPose { angle: 360. * cubic_bezier(0.45, 0., 0.25, 1., u), ..PawPose::STILL },
        PawMove::Knead => {
            const KEYS_X: [(f32, f32); 7] = [(0., 1.), (0.18, 1.12), (0.34, 0.96), (0.46, 1.), (0.64, 1.12), (0.82, 0.96), (1., 1.)];
            const KEYS_Y: [(f32, f32); 7] = [(0., 1.), (0.18, 0.8), (0.34, 1.06), (0.46, 1.), (0.64, 0.8), (0.82, 1.06), (1., 1.)];
            let (sx, sy) = (timed(&KEYS_X, u), timed(&KEYS_Y, u));
            // Squashed from its bottom edge, which stays put.
            PawPose { scale: (sx, sy), shift: (0., 0.5 * (1. - sy)), ..PawPose::STILL }
        }
        PawMove::Wave => {
            let angle = timed(&[(0., 0.), (0.2, -18.), (0.45, 14.), (0.7, -9.), (1., 0.)], u);
            PawPose { angle, shift: about(angle, (0.4, 0.95)), ..PawPose::STILL }
        }
        PawMove::Prints => {
            let mut prints = [(0., 1.); 3];
            for (i, print) in prints.iter_mut().enumerate() {
                let (delay, length) = (i as f32 * 0.26, 1.5 - i as f32 * 0.26);
                let v = ((into - delay) / length).clamp(0., 1.);
                *print = if into < delay {
                    (0., 0.6)
                } else if v < 0.12 {
                    let w = v / 0.12;
                    (w, 0.6 + 0.4 * w)
                } else if v < 0.7 {
                    (1., 1.)
                } else {
                    (1. - (v - 0.7) / 0.3, 1.)
                };
            }
            // The paw fades out as the first print comes, and back as the
            // last ones go.
            let out = 1. - (into / 0.15).clamp(0., 1.);
            let back = ((into - (step.length() - 0.3)) / 0.3).clamp(0., 1.);
            PawPose { opacity: out.max(back), prints: Some(prints), ..PawPose::STILL }
        }
    }
}

/// Something small turning up: the activity bar's count or dot
/// (`Juice.popIn` under `Juice.pop`). It grows from a fifth of its size on a
/// bouncy spring (response 0.3, damping 0.55), fading in as it starts, and
/// under Reduce Motion only fades (0.12 s). Mike left the pick to us, 14 Nov:
/// ported as the Swift app does it.
pub const POP: Duration = Duration::from_millis(600);
pub const POP_REDUCED: Duration = Duration::from_millis(120);

/// The (scale, opacity) of something popping in, `elapsed` after it turned up.
pub fn pop_in(elapsed: Duration, reduce: bool) -> (f32, f32) {
    if reduce {
        return (1., progress(elapsed, POP_REDUCED));
    }
    let t = elapsed.as_secs_f32();
    (0.2 + 0.8 * spring(t, 0.3, 0.55), (t / 0.075).min(1.))
}

/// A row's status words changing ("Working 41s" to "now"), lighter than the
/// Swift app's blur, which GPUI can't draw: the old words fade out and the new
/// ones fade up from 3 pt above. Mike left the pick to us, 14 Nov. None under
/// Reduce Motion, as `Juice.swap` has none.
pub const STATUS_OUT: Duration = Duration::from_millis(120);
pub const STATUS_IN: Duration = Duration::from_millis(180);
pub const STATUS_DROP: f32 = 3.;

/// The new words' (opacity, distance above their place), and the old words'
/// opacity, `elapsed` after the status changed.
pub fn status_swap(elapsed: Duration) -> (f32, f32, f32) {
    let incoming = ease_out_settle(progress(elapsed, STATUS_IN));
    (incoming, STATUS_DROP * (1. - incoming), 1. - progress(elapsed, STATUS_OUT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_badge_pops_from_a_fifth_with_a_bounce() {
        let ms = Duration::from_millis;
        assert_eq!(pop_in(ms(0), false), (0.2, 0.));
        assert!((0..60).any(|i| pop_in(ms(i * 10), false).0 > 1.05), "it overshoots, as Swift's spring does");
        let (end, shown) = pop_in(POP, false);
        assert!((end - 1.).abs() < 0.02 && shown == 1., "settled by the end ({end})");
        // Reduce Motion: no growing, only a short fade.
        assert_eq!(pop_in(ms(0), true), (1., 0.));
        assert_eq!(pop_in(POP_REDUCED, true), (1., 1.));
    }

    #[test]
    fn status_words_swap_quickly() {
        let ms = Duration::from_millis;
        assert_eq!(status_swap(ms(0)), (0., STATUS_DROP, 1.));
        let (_, _, old) = status_swap(STATUS_OUT);
        assert_eq!(old, 0., "the old words are gone before the new are all there");
        let (shown, above, old) = status_swap(STATUS_IN);
        assert!((shown - 1.).abs() < 1e-4 && above.abs() < 1e-3 && old == 0., "settled: ({shown}, {above}, {old})");
    }

    #[test]
    fn bezier_ends_and_shape() {
        assert_eq!(cubic_bezier(0.2, 0.9, 0.25, 1., 0.), 0.);
        assert_eq!(cubic_bezier(0.2, 0.9, 0.25, 1., 1.), 1.);
        // That curve is most of the way there by a third of the time.
        assert!(selection_slide(0.33) > 0.8, "{}", selection_slide(0.33));
        // A straight line stays one.
        for i in 0..=10 {
            let t = i as f32 / 10.;
            assert!((cubic_bezier(1. / 3., 1. / 3., 2. / 3., 2. / 3., t) - t).abs() < 1e-3);
        }
        // Never runs backwards.
        let mut last = 0.;
        for i in 0..=100 {
            let v = ease_out_settle(i as f32 / 100.);
            assert!(v + 1e-4 >= last);
            last = v;
        }
    }

    #[test]
    fn springs_settle() {
        assert_eq!(spring(0., 0.3, 0.55), 0.);
        assert!((spring(2., 0.3, 0.55) - 1.).abs() < 1e-3);
        // A bouncy one goes past the end on its way.
        assert!((0..100).any(|i| spring(i as f32 / 100., 0.3, 0.55) > 1.05));
        assert!((snappy(1., 0.2) - 1.).abs() < 1e-3);
        assert!((spring(1., 0.3, 1.) - 1.).abs() < 1e-3);
    }

    #[test]
    fn tracks_hit_their_keys() {
        let wave = Track { start: 0., keys: &[(0.25, 0.), (0.14, -9.), (0.16, 7.), (0.14, -5.), (0.2, 0.)] };
        assert!((wave.duration() - 0.89).abs() < 1e-5);
        assert_eq!(wave.at(0.1), 0.);
        assert!((wave.at(0.39) - -9.).abs() < 1e-3);
        assert!((wave.at(0.55) - 7.).abs() < 1e-3);
        assert_eq!(wave.at(5.), 0.);
        assert!((timed(&[(0., 0.), (0.16, 14.), (0.38, 3.)], 0.16) - 14.).abs() < 1e-3);
        assert_eq!(timed(&[(0., 1.), (1., 2.)], 9.), 2.);
    }

    #[test]
    fn the_paw_picks_a_new_move_each_time() {
        for seed in [0u64, 1, 1_731_480_000, u64::MAX] {
            let moves: Vec<PawMove> = (0..40).map(|n| paw_move(seed, n)).collect();
            assert!(moves.windows(2).all(|w| w[0] != w[1]), "{seed}: {moves:?}");
            // All five turn up over a long turn.
            for m in PawMove::ALL {
                assert!(moves.contains(&m), "{seed}: no {m:?} in {moves:?}");
            }
            // The same turn picks the same moves each time it's drawn.
            assert_eq!(paw_move(seed, 7), moves[7]);
        }
        assert_ne!((0..10).map(|n| paw_move(1, n)).collect::<Vec<_>>(), (0..10).map(|n| paw_move(2, n)).collect::<Vec<_>>());
    }

    #[test]
    fn the_paw_costs_the_same_however_old_the_turn() {
        // Daybreak 147: a secondary runner's turn.started at 0001-01-01 put
        // ~26.6 billion steps behind the paw, walked twice a frame.
        let started = -62_135_596_800.; // 0001-01-01T00:00:00Z
        let t = (1_763_400_000. - started) as f32;
        let clock = std::time::Instant::now();
        for seed in [0u64, 1, u64::MAX] {
            let _ = paw_pose(seed, t);
            let _ = paw_now(seed, t);
            let _ = paw_move(seed, u64::MAX);
            let _ = paw_move(seed, u64::MAX - 1);
        }
        assert!(clock.elapsed() < std::time::Duration::from_millis(50), "{:?}", clock.elapsed());
        // Far along a turn the moves still never repeat.
        let far: Vec<PawMove> = (0..40).map(|n| paw_move(9, u64::MAX - 40 + n)).collect();
        assert!(far.windows(2).all(|w| w[0] != w[1]), "{far:?}");
    }

    #[test]
    fn a_turn_start_the_app_cant_have_seen_isnt_timed() {
        let now = 1_763_400_000.;
        assert_eq!(turn_start(now - 41., now, None), Some(now - 41.));
        assert_eq!(turn_start(now - 3. * 3600., now, Some(now - 4. * 3600.)), Some(now - 3. * 3600.));
        // A little clock skew between machines is fine.
        assert_eq!(turn_start(now + 30., now, Some(now + 60.)), Some(now + 30.));
        // Year 1, the future, before the thread, older than a week, not a number.
        assert_eq!(turn_start(-62_135_596_800., now, None), None);
        assert_eq!(turn_start(now + 3600., now, None), None);
        assert_eq!(turn_start(now - 3600., now, Some(now - 60.)), None);
        assert_eq!(turn_start(now - 8. * 24. * 3600., now, None), None);
        assert_eq!(turn_start(f64::NAN, now, None), None);
        assert_eq!(turn_start(f64::NEG_INFINITY, now, None), None);
    }

    #[test]
    fn the_paw_rests_between_moves_and_ends_where_it_started() {
        assert_eq!(paw_pose(3, 0.2), PawPose::STILL);
        assert_eq!(paw_now(3, PAW_FIRST + 2.), None);
        for n in 0..12u64 {
            let start = PAW_FIRST + n as f32 * PAW_EVERY;
            let step = paw_move(3, n);
            assert_eq!(paw_now(3, start + 0.01).map(|m| m.0), Some(step));
            let end = paw_pose(3, start + step.length() - 1e-4);
            assert!((end.angle % 360.).abs() < 0.5 || (end.angle - 360.).abs() < 0.5, "{step:?} {end:?}");
            assert!((end.scale.0.abs() - 1.).abs() < 0.02 && (end.scale.1 - 1.).abs() < 0.02, "{step:?} {end:?}");
            assert!(end.shift.0.abs() < 0.02 && end.shift.1.abs() < 0.02, "{step:?} {end:?}");
            assert!(end.opacity > 0.98, "{step:?} {end:?}");
        }
        // Mid-move, each one is somewhere else.
        let mid = |m: PawMove| (0..40).map(|n| (n, paw_move(5, n))).find(|(_, s)| *s == m).map(|(n, _)| paw_pose(5, PAW_FIRST + n as f32 * PAW_EVERY + m.length() * 0.3)).unwrap();
        assert!(mid(PawMove::Flip).scale.0.abs() < 0.5);
        assert!(mid(PawMove::Spin).angle > 30.);
        assert!(mid(PawMove::Wave).angle.abs() > 3.);
        assert!(mid(PawMove::Prints).prints.unwrap()[0].0 > 0.9);
        // The heel stays put as the paw tilts: (0.4, 0.95) of the box.
        let wave = mid(PawMove::Wave);
        let (s, c) = wave.angle.to_radians().sin_cos();
        let (vx, vy) = (-0.1f32, 0.45f32);
        let heel = (c * vx - s * vy + wave.shift.0, s * vx + c * vy + wave.shift.1);
        assert!((heel.0 - vx).abs() < 1e-4 && (heel.1 - vy).abs() < 1e-4);
    }

    #[test]
    fn the_rail_bounces_home() {
        assert_eq!(rail_bounce(0.), 1.);
        assert!((rail_bounce(0.08) - 0.82).abs() < 1e-3);
        assert!((0..50).any(|i| rail_bounce(0.08 + i as f32 / 100.) > 1.01));
        assert!((rail_bounce(RAIL_BOUNCE.as_secs_f32()) - 1.).abs() < 0.03);
        assert_eq!(view_settle(0., false), (0., VIEW_SETTLE_RISE));
        assert!(view_settle(VIEW_SETTLE.as_secs_f32(), false).1.abs() < 0.1);
        assert_eq!(view_settle(1., true), (1., 0.));
    }

    #[test]
    fn a_picked_answer_fills_then_hops_before_the_card_moves_on() {
        assert_eq!(pick_fill(Duration::ZERO), 0.);
        assert_eq!(pick_fill(PICK_FILL), 1.);
        assert_eq!(pick_hop(PICK_HOP_DELAY), 0.);
        assert!((pick_hop(PICK_HOP_DELAY + Duration::from_millis(60)) + 3.).abs() < 1e-3);
        assert_eq!(pick_hop(PICK), 0.);
        // The card pages on 300 ms after the click.
        assert!(PICK < Duration::from_millis(300));
        let (scale, drawn) = tick_pop(Duration::ZERO);
        assert!(scale < 0.6 && drawn == 0.);
        assert!((0..24).any(|i| tick_pop(Duration::from_millis(i * 10)).0 > 1.1));
        assert_eq!(tick_pop(TICK_POP), (1., 1.));
    }

    #[test]
    fn a_pasted_picture_drops_in_past_its_place_and_back() {
        assert_eq!(strip_open(Duration::ZERO), 0.);
        assert_eq!(strip_open(STRIP_OPEN), 1.);
        assert_eq!(picture_drop(Duration::ZERO), (0., PICTURE_DROP_FROM));
        assert!((0..32).any(|i| picture_drop(PICTURE_DROP_DELAY + Duration::from_millis(i * 10)).1 > 1.));
        assert_eq!(picture_drop(PICTURE_DROP_DELAY + PICTURE_DROP), (1., 0.));
        assert!(picture_dropping(Duration::from_millis(100)) && !picture_dropping(PICTURE_DROP_DELAY + PICTURE_DROP));
    }

    #[test]
    fn the_card_settles_and_its_tick_draws() {
        assert_eq!(card_settle(Duration::ZERO, false), (0., CARD_SETTLE_RISE));
        assert_eq!(card_settle(CARD_SETTLE, false), (1., 0.));
        assert_eq!(card_settle(Duration::from_millis(75), true).1, 0.);
        assert_eq!(tick_drawn(Duration::from_millis(20)), 0.);
        assert_eq!(tick_drawn(TICK_DRAW_DELAY + TICK_DRAW), 1.);
        assert!(TICK_DRAW_END >= TICK_DRAW_DELAY + TICK_DRAW);
    }

    #[test]
    fn the_lift_starts_late_and_lands() {
        let (fade, below) = send_lift(Duration::from_millis(30), false);
        assert_eq!((fade, below), (0., SEND_LIFT_RISE));
        let (fade, below) = send_lift(SEND_LIFT_DELAY + SEND_LIFT, false);
        assert_eq!((fade, below), (1., 0.));
        assert!(!send_lifting(SEND_LIFT_DELAY + SEND_LIFT, false));
        assert_eq!(send_lift(Duration::from_millis(50), true), (0.5, 0.));
    }
}
