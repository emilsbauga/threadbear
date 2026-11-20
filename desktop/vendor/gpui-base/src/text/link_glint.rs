//! Threadbear's: a press on a link in text sends a soft sheen across the
//! link's own words, left to right, so the click shows straight away even
//! when what it opens (a browser, another thread) takes a moment. Mike
//! picked it from four mockups on 19 Nov 2026 ("Glint",
//! `~/dev/me/misc/threadbear-juice-mockups/link-click-glint.html`).
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

use gpui::{App, Global, Hsla, Pixels, px};

use super::inline::InlineState;

/// How long the sheen takes to cross a link.
pub(super) const DURATION: Duration = Duration::from_millis(340);
/// How many strips the band is painted in; more is a smoother edge.
pub(super) const STRIPS: usize = 10;
/// The most the whole link lightens, at the middle of the glint.
const LIFT: f32 = 0.5;

struct LinkGlint {
    text: Weak<Mutex<InlineState>>,
    range: Range<usize>,
    started: Instant,
}

impl Global for LinkGlint {}

/// Starts the glint on `range` of the text whose state is `text`, replacing
/// any glint still playing.
pub(super) fn start(text: &Arc<Mutex<InlineState>>, range: Range<usize>, cx: &mut App) {
    if cx.reduce_motion() || range.is_empty() {
        return;
    }
    cx.set_global(LinkGlint {
        text: Arc::downgrade(text),
        range,
        started: Instant::now(),
    });
}

/// The range glinting in the text whose state is `text`, and how far
/// through it is (0 to 1), while it plays.
pub(super) fn playing(text: &Arc<Mutex<InlineState>>, cx: &App) -> Option<(Range<usize>, f32)> {
    let glint = cx.try_global::<LinkGlint>()?;
    if !std::ptr::eq(glint.text.as_ptr(), Arc::as_ptr(text)) {
        return None;
    }
    let t = glint.started.elapsed().as_secs_f32() / DURATION.as_secs_f32();
    (t < 1.).then(|| (glint.range.clone(), t))
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
/// measured along the link as it reads (its rows laid end to end): how
/// strongly the whole link lightens, and the band's strips, each a span
/// along the link with how strongly it shines.
pub(super) fn frame(t: f32, width: Pixels) -> (f32, Vec<(Pixels, Pixels, f32)>) {
    let t = t.clamp(0., 1.);
    let whole = LIFT * (std::f32::consts::PI * t).sin();
    let half = (width * 0.25).max(px(14.)).min(px(32.));
    // CSS's ease (0.4, 0, 0.2, 1), near enough: quick out, gentle in.
    let eased = 1. - (1. - t).powf(2.6);
    let middle = -half + (width + half * 2.) * eased;
    let strip = half * 2. / STRIPS as f32;
    let strips = (0..STRIPS)
        .map(|i| {
            let from = middle - half + strip * i as f32;
            let off = ((from + strip / 2. - middle) / half).abs().min(1.);
            let strength = (std::f32::consts::FRAC_PI_2 * off).cos().powi(2);
            (from, from + strip, strength)
        })
        .filter(|(from, to, strength)| *strength > 0.02 && *to > px(0.5) && *from < width - px(0.5))
        .collect();
    (whole, strips)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_band_crosses_the_whole_link_and_the_lift_comes_and_goes() {
        let width = px(200.);
        let (start, strips) = frame(0., width);
        assert_eq!(start, 0., "no lift before it starts");
        assert!(strips.is_empty(), "the band starts off the left edge: {strips:?}");

        let (middle, strips) = frame(0.5, width);
        assert!((middle - LIFT).abs() < 1e-4, "the most lift halfway: {middle}");
        let brightest = strips
            .iter()
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
            .unwrap();
        assert!(brightest.2 > 0.9, "the band's middle shines: {strips:?}");
        assert!(brightest.0 > px(0.) && brightest.1 < width, "inside the link halfway: {brightest:?}");

        let (end, strips) = frame(1., width);
        assert!(end.abs() < 1e-4, "the lift is gone at the end: {end}");
        assert!(strips.is_empty(), "the band has left by the right edge: {strips:?}");
    }

    #[test]
    fn the_band_is_soft_at_its_edges() {
        let (_, strips) = frame(0.5, px(400.));
        let first = strips.first().unwrap().2;
        let last = strips.last().unwrap().2;
        let most = strips.iter().map(|s| s.2).fold(0., f32::max);
        assert!(first < most * 0.5 && last < most * 0.5, "{strips:?}");
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
