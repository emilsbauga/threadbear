//! Threadbear's: a press on a link in text sends a soft sheen through the
//! link's own words, rippling out both ways from where it was pressed, so
//! the click shows straight away even when what it opens (a browser,
//! another thread) takes a moment. Mike picked it from four mockups on 19
//! Nov 2026 ("Glint", `~/dev/me/misc/threadbear-juice-mockups/
//! link-click-glint.html`, which swept left to right) and asked on 20 Nov
//! for it to ripple out from the press instead.
//!
//! It draws over the words, never re-lays them out: the link's text is
//! shaped again in a lighter color (GPUI's shaping cache ignores color, so
//! that is a lookup) and painted through thin vertical masks, each a little
//! less lit towards the band's edges, which makes the soft edge GPUI can't
//! draw as a gradient on text. The colors are mixed solid ([`lit`]), not
//! see-through: translucent text painted over the same text didn't show at
//! all on the Linux build (19 Nov), though the shapes lined up exactly. One link glints at a time, and
//! nothing plays with Reduce Motion on.

#[cfg(not(target_family = "wasm"))]
use std::time::Instant;
use std::{
    ops::Range,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
#[cfg(target_family = "wasm")]
use web_time::Instant;

use gpui::{App, Global, Hsla, Pixels, Point, px};

use super::inline::InlineState;

/// How long the ripple takes to leave a link.
pub(super) const DURATION: Duration = Duration::from_millis(340);
/// How many strips the band is painted in; more is a smoother edge.
pub(super) const STRIPS: usize = 10;
/// The most the whole link lightens, at the middle of the glint.
const LIFT: f32 = 0.5;

struct LinkGlint {
    text: Weak<Mutex<InlineState>>,
    range: Range<usize>,
    /// Where it was pressed, in the window.
    at: Point<Pixels>,
    started: Instant,
}

impl Global for LinkGlint {}

/// Starts the glint on `range` of the text whose state is `text`, from the
/// press at `at` in the window, replacing any glint still playing.
pub(super) fn start(
    text: &Arc<Mutex<InlineState>>,
    range: Range<usize>,
    at: Point<Pixels>,
    cx: &mut App,
) {
    if cx.reduce_motion() || range.is_empty() {
        return;
    }
    cx.set_global(LinkGlint {
        text: Arc::downgrade(text),
        range,
        at,
        started: Instant::now(),
    });
}

/// The range glinting in the text whose state is `text`, where in the
/// window it was pressed, and how far through it is (0 to 1), while it plays.
pub(super) fn playing(
    text: &Arc<Mutex<InlineState>>,
    cx: &App,
) -> Option<(Range<usize>, Point<Pixels>, f32)> {
    let glint = cx.try_global::<LinkGlint>()?;
    if !std::ptr::eq(glint.text.as_ptr(), Arc::as_ptr(text)) {
        return None;
    }
    let t = glint.started.elapsed().as_secs_f32() / DURATION.as_secs_f32();
    (t < 1.).then(|| (glint.range.clone(), glint.at, t))
}

/// Whether a glint is on, wherever it is, for tests.
#[cfg(test)]
pub(super) fn active(cx: &App) -> Option<Range<usize>> {
    cx.try_global::<LinkGlint>()
        .filter(|glint| glint.started.elapsed() < DURATION)
        .map(|glint| glint.range.clone())
}

/// The link's color at the band's middle: most of the way to white.
pub(super) fn shine(color: Hsla) -> Hsla {
    Hsla {
        l: color.l + (1. - color.l) * 0.8,
        s: color.s * 0.9,
        ..color
    }
}

/// `color` taken `strength` (0 to 1) of the way to [`shine`], solid: the
/// copy covers the words' own glyphs exactly, so mixing here looks the same
/// as a see-through shine over them, and a renderer that draws translucent
/// text over text differently can't lose it (the Linux build showed none).
pub(super) fn lit(color: Hsla, strength: f32) -> Hsla {
    let (from, to) = (gpui::Rgba::from(color), gpui::Rgba::from(shine(color)));
    let k = strength.clamp(0., 1.);
    let mix = |a: f32, b: f32| a + (b - a) * k;
    Hsla::from(gpui::Rgba { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b), a: from.a })
}

/// What to paint at `t` (0 to 1) of a glint across a link `width` wide,
/// pressed `at` along it, both measured along the link as it reads (its
/// rows laid end to end): how strongly the whole link lightens, and the lit
/// strips, each a span along the link with how strongly it shines. The band
/// starts on the press and spreads out as a ring, a crest going each way,
/// fading a little as it goes, until both have left the link's ends.
pub(super) fn frame(t: f32, width: Pixels, at: Pixels) -> (f32, Vec<(Pixels, Pixels, f32)>) {
    let t = t.clamp(0., 1.);
    let whole = LIFT * (std::f32::consts::PI * t).sin();
    let half = (width * 0.25).max(px(14.)).min(px(32.));
    let at = at.max(Pixels::ZERO).min(width);
    // CSS's ease (0.4, 0, 0.2, 1), near enough: quick out, gentle in.
    let eased = 1. - (1. - t).powf(2.6);
    // The ring's radius, in half-bands: from the press to past the far end.
    let reach = (at.max(width - at) + half) / half;
    let radius = reach * eased;
    let fade = 1. - 0.3 * eased;
    let strip = half * 2. / STRIPS as f32;
    let count = (width / strip).ceil() as usize;
    let strips = (0..count)
        .map(|i| {
            let from = strip * i as f32;
            let to = (from + strip).min(width);
            let off = (((from + to) / 2. - at) / half).abs();
            let off = (off - radius).abs().min(1.);
            let strength = (std::f32::consts::FRAC_PI_2 * off).cos().powi(2) * fade;
            (from, to, strength)
        })
        .filter(|(from, to, strength)| *strength > 0.02 && to > from)
        .collect();
    (whole, strips)
}

/// How far along a link, its `rows` (a row, and the left and right of the
/// link on it, relative to the text) laid end to end, the point `at` is,
/// for text whose rows are `line_height` tall from `origin`: on the row it
/// is on, or the nearest.
pub(super) fn along(
    rows: &[(usize, Pixels, Pixels)],
    origin: Point<Pixels>,
    line_height: Pixels,
    at: Point<Pixels>,
) -> Pixels {
    let distance = |row: usize| {
        let top = origin.y + line_height * row as f32;
        if at.y < top {
            top - at.y
        } else if at.y >= top + line_height {
            at.y - (top + line_height)
        } else {
            Pixels::ZERO
        }
    };
    let Some(nearest) = (0..rows.len()).min_by(|a, b| {
        distance(rows[*a].0)
            .partial_cmp(&distance(rows[*b].0))
            .unwrap_or(std::cmp::Ordering::Equal)
    }) else {
        return Pixels::ZERO;
    };
    let before = rows[..nearest]
        .iter()
        .fold(Pixels::ZERO, |sum, (_, left, right)| sum + (*right - *left));
    let (_, left, right) = rows[nearest];
    before + (at.x - origin.x - left).max(Pixels::ZERO).min(right - left)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brightest(strips: &[(Pixels, Pixels, f32)]) -> (Pixels, Pixels, f32) {
        *strips.iter().max_by(|a, b| a.2.partial_cmp(&b.2).unwrap()).unwrap()
    }

    #[test]
    fn the_ripple_starts_on_the_press_and_spreads_both_ways() {
        let (width, at) = (px(200.), px(60.));
        let (start, strips) = frame(0., width, at);
        assert_eq!(start, 0., "no lift before it starts");
        let first = brightest(&strips);
        assert!(first.0 <= at && first.1 >= at && first.2 > 0.9, "lit where pressed: {strips:?}");

        let (_, strips) = frame(0.15, width, at);
        let left = brightest(&strips.iter().copied().filter(|s| s.1 <= at).collect::<Vec<_>>());
        let right = brightest(&strips.iter().copied().filter(|s| s.0 >= at).collect::<Vec<_>>());
        assert!(left.2 > 0.6 && right.2 > 0.6, "a crest each way: {strips:?}");
        let middle = strips.iter().find(|s| s.0 <= at && s.1 >= at).map_or(0., |s| s.2);
        assert!(middle < 0.3, "the press point has dimmed again: {strips:?}");

        let (half, _) = frame(0.5, width, at);
        assert!((half - LIFT).abs() < 1e-4, "the most lift halfway: {half}");

        let (end, strips) = frame(1., width, at);
        assert!(end.abs() < 1e-4, "the lift is gone at the end: {end}");
        assert!(strips.is_empty(), "both crests have left the ends: {strips:?}");
    }

    #[test]
    fn the_band_is_soft_at_its_edges() {
        let (_, strips) = frame(0.5, px(400.), px(0.));
        let first = strips.first().unwrap().2;
        let last = strips.last().unwrap().2;
        let most = strips.iter().map(|s| s.2).fold(0., f32::max);
        assert!(first < most * 0.5 && last < most * 0.5, "{strips:?}");
    }

    #[test]
    fn along_lays_the_rows_end_to_end() {
        let rows = [(0, px(100.), px(180.)), (1, px(0.), px(50.))];
        let origin = gpui::point(px(10.), px(20.));
        let along = |x: f32, y: f32| along(&rows, origin, px(16.), gpui::point(px(x), px(y)));
        assert_eq!(along(130., 25.), px(20.), "on the first row");
        assert_eq!(along(40., 40.), px(110.), "on the second row, after the first");
        assert_eq!(along(500., 40.), px(130.), "past the end keeps to it");
        assert_eq!(along(130., -50.), px(20.), "above it takes the nearest row");
    }

    #[test]
    fn shine_lightens_towards_white_and_keeps_the_hue() {
        let blue = gpui::hsla(0.59, 1., 0.63, 1.);
        let light = shine(blue);
        assert!(light.l > 0.9 && light.l < 1.);
        assert_eq!(light.h, blue.h);
        assert_eq!(light.a, 1.);
    }

    #[test]
    fn lit_mixes_solid_from_the_link_to_the_shine() {
        let blue = gpui::hsla(0.59, 1., 0.63, 1.);
        let none = gpui::Rgba::from(lit(blue, 0.));
        let full = gpui::Rgba::from(lit(blue, 1.));
        let half = gpui::Rgba::from(lit(blue, 0.5));
        let (b, s) = (gpui::Rgba::from(blue), gpui::Rgba::from(shine(blue)));
        assert!((none.r - b.r).abs() < 0.01 && (full.r - s.r).abs() < 0.01);
        assert!(half.r > b.r && half.r < s.r);
        assert_eq!(half.a, 1.);
    }
}
