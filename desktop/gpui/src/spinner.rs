// The turning arc a working thread shows in the sidebar (Spinner.swift's
// SpinnerView): three quarters of a ring with round ends, once round every
// 0.9 s, clockwise.
//
// The Swift app turns it in the render server, with nothing for the main
// thread to do. GPUI turns a thing by drawing it again, and a request for the
// next frame from inside a view has that view and every view it's in (the
// sidebar, the dock, the window, the open transcript) draw again. The kit's
// spinner asks every frame, so while any thread worked the whole window drew
// at the screen's rate, 120 times a second on Mike's MacBook, and a debug
// build spent all its time there. This one waits 20 ms after it's drawn
// before asking again, one timer for all the arcs a view has: with the wait
// for the screen's next frame on top, about 30 frames a second, which reads
// as smooth at this size. (33 ms came to 20 a second, a visible step.)
//
// Even at that rate a turn redrew the whole sidebar, building every row: a
// third of a core while any thread worked (Mike, 13 Nov: "everything does
// seem to slow down a bit once the system loads up"). So the sidebar's arcs
// (`layered`) aren't drawn where they sit. Each notes its place, clip, colour
// and opacity as its row is drawn, and the window's `ArcLayer`, a small view
// of its own drawn last at the window's root as the archive flight is, turns
// them all. A turn asks only that view to draw again: the root draws with it,
// and the sidebar's cached drawing is used as it was. (Asking the app's own
// view would have the sidebar, which watches it, draw again every turn too.)
//
// A sidebar drawing again forgets its arcs and places the ones it still has,
// so a row whose arc goes (its thread done, hovered) loses it then. One taken
// off screen never draws to say so; the layer sees that in the dock (see
// `ArcLayer`). Asking the sidebar to draw to show it's still there didn't
// work: GPUI passes an ask on only to a window it knows shows the view, and
// can lose track of a cached one (Codex, 14 Nov).
use crate::style::{self, px};
use gpui_kit::*;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const TURN_SECONDS: f32 = 0.9;
const FRAME: Duration = Duration::from_millis(20);
/// How much of the sidebar list's foot fades into the background
/// (row_motion.rs's FOOT_FADE): an arc in it fades as its row does.
const FOOT_FADE: f32 = 34.;
/// A window whose layer hasn't drawn for this long has closed: its arcs go.
const WINDOW_GONE: Duration = Duration::from_secs(10);

#[derive(IntoElement)]
pub(crate) struct TurningArc {
    side: f32,
    color: Hsla,
    layered: bool,
}

impl TurningArc {
    /// `side` in points, before the zoom.
    pub(crate) fn new(side: f32, color: Hsla) -> Self {
        Self { side, color, layered: false }
    }

    /// Turned by the window's layer rather than by drawing its view again:
    /// for a row in the sidebar's list, whose foot fades. Not for an arc in
    /// something drawn over the window's content (a card, a menu), which the
    /// layer would turn under it, and only in a view that calls
    /// `view_drawing` as it draws.
    pub(crate) fn layered(mut self) -> Self {
        self.layered = true;
        self
    }
}

impl RenderOnce for TurningArc {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let (color, layered) = (self.color, self.layered);
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                let id = window.window_handle().window_id();
                // Layered only where its view has said it's drawing this frame
                // (`view_drawing`), so it clears them next time: not in the
                // dock's drag ghost, which draws the sidebar under the dock's
                // name and turns its arcs itself as it's drawn every frame.
                if layered && LAYERED.with(|l| l.borrow().contains_key(&id)) && drawing_now(id, window.current_view()) {
                    // `opacity` scales the alpha: the row's own opacity, once.
                    let color = color.opacity(window.element_opacity());
                    place(id, window.current_view(), bounds, window.content_mask(), color);
                } else {
                    // A window with no layer (a panel in one of its own)
                    // turns its arcs itself, redrawing their view.
                    paint_arc(bounds, color, window);
                    next_frame(window, cx);
                }
            },
        )
        .flex_none()
        .size(px(self.side))
    }
}

fn paint_arc(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    static START: OnceLock<Instant> = OnceLock::new();
    let turned = (START.get_or_init(Instant::now).elapsed().as_secs_f32() / TURN_SECONDS).fract();
    // The ring as Swift's: 1.6 wide, 3 in from the sides, zoomed like an
    // icon's strokes.
    let width = style::zoomed(1.6);
    let side = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
    let radius = ((side - style::zoomed(3.)) / 2.).max(1.);
    let center = bounds.center();
    let at = |angle: f32| point(center.x + gpui_kit::px(radius * angle.cos()), center.y + gpui_kit::px(radius * angle.sin()));
    let start = turned * std::f32::consts::TAU;
    let end = start + 0.75 * std::f32::consts::TAU;
    let mut path = PathBuilder::stroke(gpui_kit::px(width));
    path.move_to(at(start));
    // Clockwise on screen (y runs down), the long way round.
    path.arc_to(point(gpui_kit::px(radius), gpui_kit::px(radius)), gpui_kit::px(0.), true, true, at(end));
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
    // Round ends: lyon's caps aren't GPUI's to set, so a dot at each.
    for angle in [start, end] {
        let c = at(angle);
        let dot = Bounds { origin: point(c.x - gpui_kit::px(width / 2.), c.y - gpui_kit::px(width / 2.)), size: size(gpui_kit::px(width), gpui_kit::px(width)) };
        window.paint_quad(fill(dot, color).corner_radii(gpui_kit::px(width / 2.)));
    }
}

thread_local! {
    /// The views with a frame on its way for their arcs.
    static TICKING: RefCell<HashSet<EntityId>> = RefCell::new(HashSet::new());
    /// The windows with a layer, and when it last drew.
    static LAYERED: RefCell<HashMap<WindowId, Instant>> = RefCell::new(HashMap::new());
    /// The arcs each window's layer draws.
    static PLACED: RefCell<HashMap<WindowId, Vec<Placed>>> = RefCell::new(HashMap::new());
    /// Counts the frames layers draw: one ends as its layer's paint does.
    static FRAMES: Cell<u64> = const { Cell::new(0) };
    /// The frame each view last said it was drawing in, by window (the
    /// same sidebar can be in a window of its own).
    static DRAWN: RefCell<HashMap<(WindowId, EntityId), u64>> = RefCell::new(HashMap::new());
}

/// An arc as its view last drew it: where, clipped to what, in what colour
/// (its row's opacity in it).
#[derive(Clone, Debug, PartialEq)]
struct Placed {
    view: EntityId,
    bounds: Bounds<Pixels>,
    mask: ContentMask<Pixels>,
    color: Hsla,
}

/// A view with layered arcs is drawing: it places the ones it still has as it
/// paints, so the ones from before go. Call it from the view's render.
pub(crate) fn view_drawing(window: &Window) {
    let (id, view) = (window.window_handle().window_id(), window.current_view());
    DRAWN.with(|d| d.borrow_mut().insert((id, view), FRAMES.get()));
    PLACED.with(|p| {
        if let Some(arcs) = p.borrow_mut().get_mut(&id) {
            arcs.retain(|a| a.view != view);
        }
    });
}

/// Whether `view` has said it's drawing in this window in this frame.
fn drawing_now(window: WindowId, view: EntityId) -> bool {
    DRAWN.with(|d| d.borrow().get(&(window, view)).is_some_and(|frame| *frame == FRAMES.get()))
}

fn place(window: WindowId, view: EntityId, bounds: Bounds<Pixels>, mask: ContentMask<Pixels>, color: Hsla) {
    PLACED.with(|p| p.borrow_mut().entry(window).or_default().push(Placed { view, bounds, mask, color }));
}

/// The window's arcs, turned: drawn last over the window's own content, and
/// under anything deferred (menus, tooltips, the archive flight). One per
/// window, after the dock in its root view.
///
/// The sidebar stops being drawn only when the dock changes, and it can't
/// say so, so the layer looks at the dock as it paints: with the Threads
/// panel not in front in this window (another tab, closed, or out in a window
/// of its own) the window's arcs go. A sidebar moved or resized draws again
/// and places its own. While a panel's dragged, or its ghost lands, the arcs
/// aren't drawn: the ghost is drawn in the dock, under them.
pub(crate) struct ArcLayer {
    dock: Entity<threadbear_dock::DockModel>,
    dock_view: Entity<threadbear_dock::DockView>,
    /// The panel the arcs are in.
    panel: &'static str,
}

impl ArcLayer {
    pub(crate) fn new(dock: Entity<threadbear_dock::DockModel>, dock_view: Entity<threadbear_dock::DockView>, panel: &'static str) -> Self {
        Self { dock, dock_view, panel }
    }
}

impl Render for ArcLayer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let (dock, dock_view, panel) = (self.dock.clone(), self.dock_view.clone(), self.panel);
        canvas(
            |_, window, _| {
                LAYERED.with(|l| l.borrow_mut().insert(window.window_handle().window_id(), Instant::now()));
            },
            move |_, _, window, cx| {
                // As the dock draws it: a collapsed sidebar (⌘/) is left out,
                // and a tab with nothing to show gives way to the next.
                let in_front = dock_view.read(cx).shows(panel, cx);
                let dragging = dock.read(cx).controller.drag.is_some() || dock_view.read(cx).is_landing();
                if !in_front {
                    PLACED.with(|p| p.borrow_mut().remove(&window.window_handle().window_id()));
                }
                paint_layer(!dragging, window, cx)
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// How much of an arc shows at the sidebar list's foot, where its rows fade
/// into the background: `bottom` is the list's, `y` the arc's centre.
fn foot_shown(bottom: f32, y: f32) -> f32 {
    ((bottom - y) / FOOT_FADE).clamp(0., 1.)
}

fn paint_layer(draw: bool, window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    let now = Instant::now();
    let frame = FRAMES.get();
    // Closed windows' arcs go.
    let open: HashSet<WindowId> = LAYERED.with(|l| {
        let mut l = l.borrow_mut();
        l.retain(|_, at| now.duration_since(*at) < WINDOW_GONE);
        l.keys().copied().collect()
    });
    let arcs = PLACED.with(|p| {
        let mut p = p.borrow_mut();
        p.retain(|w, _| open.contains(w));
        p.get(&id).cloned().unwrap_or_default()
    });
    // What's kept of views that drew no arcs, or not lately, goes.
    let placed: HashSet<(WindowId, EntityId)> = PLACED.with(|p| p.borrow().iter().flat_map(|(w, arcs)| arcs.iter().map(move |a| (*w, a.view))).collect());
    DRAWN.with(|d| d.borrow_mut().retain(|key, drew| *drew == frame || placed.contains(key)));
    for arc in arcs.iter().filter(|_| draw) {
        let shown = foot_shown(f32::from(arc.mask.bounds.bottom()), f32::from(arc.bounds.center().y));
        let color = arc.color.opacity(shown);
        window.with_content_mask(Some(arc.mask.clone()), |window| paint_arc(arc.bounds, color, window));
    }
    FRAMES.set(frame + 1);
    // The next turn: this layer's view draws again (and the root with it),
    // not the sidebar.
    if !arcs.is_empty() {
        next_frame(window, cx);
    }
}

/// The view this arc is in draws again in a moment, once for all its arcs.
fn next_frame(window: &mut Window, cx: &mut App) {
    let view = window.current_view();
    if !TICKING.with(|t| t.borrow_mut().insert(view)) {
        return;
    }
    cx.spawn(async move |cx| {
        cx.background_executor().timer(FRAME).await;
        TICKING.with(|t| t.borrow_mut().remove(&view));
        let _ = cx.update(|cx| cx.notify(view));
    })
    .detach();
}

#[cfg(test)]
mod tests {
    // By name: a glob would bring in GPUI's own `test` attribute in place of Rust's.
    use super::{foot_shown, FOOT_FADE};

    #[test]
    fn an_arc_fades_with_its_row_at_the_lists_foot() {
        assert_eq!(foot_shown(500., 400.), 1., "well above the foot: all there");
        assert_eq!(foot_shown(500., 500. - FOOT_FADE / 2.), 0.5);
        assert_eq!(foot_shown(500., 500.), 0., "at the very bottom: gone into the background");
    }
}
