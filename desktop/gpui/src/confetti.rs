// Confetti for the rare wins (threadbear_core::confetti has the bits and
// why): a login getting its year-long token, and the last thread leaving
// the inbox. Nothing under Reduce Motion.
//
// A burst comes from an anchor: a mark painted where the good thing shows
// (the token's line on the Usage row, the empty inbox's note), so it pops
// from the words that changed, and only if they're on screen. One asked for
// waits a moment for its anchor to be drawn (the change and the burst
// arrive together) and is dropped if it never is, so a token made with the
// Usage panel shut throws nothing.
//
// It's drawn by a view of its own over the whole window, as the archive
// flight is (archive_flight.rs), so its frames redraw only that view and
// the window's root, never the sidebar or the transcript. Where each bit is
// comes from the clock, so a frame the main thread misses is skipped rather
// than slowing the burst down.
use crate::app::Threadbear;
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use threadbear_core::confetti::{self as rules, Burst};

/// How long a burst waits for its anchor to be drawn before it's dropped.
const ANCHOR_WAIT: Duration = Duration::from_millis(1500);

thread_local! {
    // The window draws on one thread, and these are read on it too: each
    // anchor's bounds and when they were last painted.
    static ANCHORS: RefCell<HashMap<String, (Bounds<Pixels>, Instant)>> = RefCell::default();
}

/// Marks where a burst named `key` comes from: the middle of its parent,
/// which should be `relative()`. Only an anchor in sight counts.
pub(crate) fn anchor(key: impl Into<String>) -> impl IntoElement {
    let key = key.into();
    canvas(
        move |bounds, window, _| {
            if bounds.intersects(&window.content_mask().bounds) {
                ANCHORS.with(|a| a.borrow_mut().insert(key.clone(), (bounds, Instant::now())));
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// An anchor painted since `since`, if there's one.
fn anchored(key: &str, since: Instant) -> Option<Bounds<Pixels>> {
    ANCHORS.with(|a| {
        a.borrow()
            .get(key)
            .filter(|(_, at)| *at >= since)
            .map(|(b, _)| *b)
    })
}

struct Thrown {
    /// Where it may pop from: the first of these that's drawn.
    anchors: Vec<String>,
    asked: Instant,
    bits: Vec<rules::Bit>,
    /// Where it pops from and when it did, once its anchor's drawn.
    from: Option<(Point<Pixels>, Instant)>,
}

/// The app's side: the view, and the last burst for scripts (`dump`'s
/// `juice.confetti`).
#[derive(Default)]
pub(crate) struct Confetti {
    view: Option<Entity<ConfettiView>>,
    serial: u64,
}

impl Confetti {
    /// The bursts, over the whole window. Drawn by the shell.
    pub(crate) fn overlay(&mut self, cx: &mut App) -> AnyElement {
        let view = self
            .view
            .get_or_insert_with(|| cx.new(|_| ConfettiView::default()))
            .clone();
        deferred(div().absolute().top_0().left_0().size_full().child(view))
            .with_priority(1)
            .into_any_element()
    }

    pub(crate) fn dump(&self, cx: &App) -> Value {
        self.view
            .as_ref()
            .and_then(|v| v.read(cx).last.clone())
            .unwrap_or(Value::Null)
    }
}

impl Threadbear {
    /// The Inbox's threads as the sidebar shows them, or None while a
    /// search is filtering the list (the empty inbox's note isn't shown).
    fn inbox_rows(&self, cx: &App) -> Option<Vec<String>> {
        if !self.search.read(cx).value().trim().is_empty() {
            return None;
        }
        let sections = self.shown_sections(cx, crate::now_ms());
        Some(
            sections
                .iter()
                .find(|s| s.key == "inbox")
                .map(|s| s.rows.iter().map(|t| t.id.clone()).collect())
                .unwrap_or_default(),
        )
    }

    /// Whether a thread's in the Inbox, before Mike archives or hibernates it.
    pub(crate) fn in_inbox(&self, id: &str, cx: &App) -> bool {
        self.inbox_rows(cx)
            .is_some_and(|rows| rows.iter().any(|r| r == id))
    }

    /// After archiving or hibernating a thread that was in the Inbox: if
    /// that was its last, confetti from the empty inbox's note.
    pub(crate) fn cheer_if_inbox_cleared(&mut self, from_inbox: bool, cx: &mut Context<Self>) {
        if from_inbox && self.inbox_rows(cx).is_some_and(|rows| rows.is_empty()) {
            self.throw_confetti("inbox-empty", rules::INBOX_BURST, cx);
        }
    }

    /// A burst from the anchor `key`, unless Reduce Motion is on.
    pub(crate) fn throw_confetti(
        &mut self,
        key: impl Into<String>,
        burst: Burst,
        cx: &mut Context<Self>,
    ) {
        self.throw_confetti_from(vec![key.into()], burst, cx);
    }

    /// A burst from the first of these anchors that's on screen (a login's
    /// Usage row, or the open thread's sign-in line).
    pub(crate) fn throw_confetti_from(
        &mut self,
        anchors: Vec<String>,
        burst: Burst,
        cx: &mut Context<Self>,
    ) {
        if cx.reduce_motion() || anchors.is_empty() {
            return;
        }
        let key = anchors[0].clone();
        self.confetti.serial += 1;
        let seed = self.confetti.serial.wrapping_mul(0x9e37_79b9)
            ^ key
                .bytes()
                .fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
        let view = self
            .confetti
            .view
            .get_or_insert_with(|| cx.new(|_| ConfettiView::default()))
            .clone();
        view.update(cx, |v, cx| {
            v.last = Some(json!({ "anchor": key, "popped": false }));
            v.thrown.push(Thrown {
                anchors,
                asked: Instant::now(),
                bits: rules::bits(seed, burst),
                from: None,
            });
            cx.notify();
        });
    }
}

#[derive(Default)]
pub(crate) struct ConfettiView {
    thrown: Vec<Thrown>,
    last: Option<Value>,
}

impl Render for ConfettiView {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let mut popped = None;
        for t in &mut self.thrown {
            if t.from.is_none() {
                if let Some((anchor, b)) = t
                    .anchors
                    .iter()
                    .find_map(|a| anchored(a, t.asked).map(|b| (a.clone(), b)))
                {
                    t.from = Some((b.center(), now));
                    popped = Some((anchor, b));
                }
            }
        }
        if let Some((anchor, b)) = popped {
            self.last = Some(
                json!({ "anchor": anchor, "popped": true, "at": { "x": f32::from(b.center().x).round(), "y": f32::from(b.center().y).round() } }),
            );
        }
        self.thrown.retain(|t| match t.from {
            Some((_, at)) => rules::going(now.duration_since(at).as_secs_f32()),
            None => now.duration_since(t.asked) < ANCHOR_WAIT,
        });
        if self.thrown.is_empty() {
            return div().into_any_element();
        }
        // Waiting for an anchor needs frames too: it's drawn by another view.
        window.request_animation_frame();
        let bursts: Vec<(Point<Pixels>, f32, Vec<rules::Bit>)> = self
            .thrown
            .iter()
            .filter_map(|t| {
                t.from
                    .map(|(p, at)| (p, now.duration_since(at).as_secs_f32(), t.bits.clone()))
            })
            .collect();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| paint_bursts(&bursts, window),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element()
    }
}

fn paint_bursts(bursts: &[(Point<Pixels>, f32, Vec<rules::Bit>)], window: &mut Window) {
    for (from, t, bits) in bursts {
        let (x0, y0) = (f32::from(from.x), f32::from(from.y));
        for bit in bits {
            let Some(at) = rules::bit_at(bit, *t) else {
                continue;
            };
            let colour = Hsla::from(rgb(rules::COLOURS[bit.colour])).opacity(at.opacity);
            let (cx, cy) = (x0 + at.x, y0 + at.y);
            if bit.round {
                let r = bit.width / 2.;
                let dot = Bounds {
                    origin: point(px(cx - r), px(cy - r)),
                    size: size(px(bit.width), px(bit.width)),
                };
                window.paint_quad(fill(dot, colour).corner_radii(px(r)));
                continue;
            }
            // A turned rectangle: GPUI can't turn a quad, so it's a path.
            let (s, c) = at.angle.to_radians().sin_cos();
            let (hw, hh) = (bit.width / 2., bit.height / 2.);
            let corner =
                |dx: f32, dy: f32| point(px(cx + dx * c - dy * s), px(cy + dx * s + dy * c));
            let mut path = PathBuilder::fill();
            path.move_to(corner(-hw, -hh));
            path.line_to(corner(hw, -hh));
            path.line_to(corner(hw, hh));
            path.line_to(corner(-hw, hh));
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, colour);
            }
        }
    }
}
