// The Canvas page (the `threadCanvas` experiment): every live thread as a
// miniature of its window on one board, each project an area with a fixed
// place, arrows from each thread to the ones it started, labelled with why in
// a handwritten font. A click on a miniature flies the camera in until it
// fills the view, where the real thread takes over in the same spot; ⌘ and
// the wheel, a pinch out or Esc fly back out. Where everything sits is
// threadbear_core::thread_canvas; this draws it and takes the mouse.
//
// Mike, 24 Nov 2026, from prototypes (~/dev/me/misc/thread-canvas, `zoom`
// and `live/a-islands`): "Let's try this way first, see how it goes."
//
// GPUI has no transform for a tree of elements, so the miniatures aren't the
// real transcript scaled down: each is drawn at the camera's scale from the
// thread's summary (its title, what Mike last asked, the agent's latest words
// and its question). Once a flight in lands at full size the real thread view
// (the same pane the main panel shows) is put exactly where the miniature
// was, and a flight out puts the miniature back first.
use crate::app::Threadbear;
use crate::tips::Tip as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
#[cfg(feature = "automation")]
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;
use threadbear_core::thread_canvas::{
    self as board, ease, Camera, Curve, Entry, Layout, Rect, GHOST_H, HEADER_H, WIN_H, WIN_W,
};

/// How long the camera takes to fly in to a thread or back out.
const FLY_MS: f32 = 450.;
/// A new thread growing into place, an archived one collapsing to its pill,
/// and Tidy's slide.
const ARRIVE_MS: f32 = 600.;
const COLLAPSE_MS: f32 = 500.;
const TIDY_MS: f32 = 450.;
/// An area glowing after something arrived in it.
const GLOW_MS: f32 = 2600.;
/// What isn't in the spotlight, faded back in place.
const DIMMED: f32 = 0.22;
/// Text smaller than this on screen is drawn as grey lines.
const SMALLEST_TEXT: f32 = 2.5;
/// Between these scales each window's title is written above it, readable;
/// further out only the areas' names are, as the windows' would crowd them.
const TITLES_BELOW: f32 = 0.42;
const TITLES_ABOVE: f32 = 0.14;
const MIN_ZOOM: f32 = 0.03;
const MAX_ZOOM: f32 = 2.5;
/// How far a press moves before it's a drag rather than a click.
const DRAG_SLOP: f32 = 4.;
/// The strip of automated threads along the bottom.
const STRIP_H: f32 = 30.;
/// The ink of the arrows and their words (the prototype's).
const INK: u32 = 0x9C937F;
const INK_WORDS: u32 = 0xCFC6B2;
const AMBER: u32 = 0xF0A23A;

struct Flight {
    from: Camera,
    to: Camera,
    start: Instant,
}

struct Press {
    from: (f32, f32),
    camera: Camera,
    /// The window it started on, and where that was.
    window: Option<(String, (f32, f32))>,
    moved: bool,
}

/// What the page holds between frames (`Threadbear::thread_canvas`).
#[derive(Default)]
pub(crate) struct CanvasPage {
    /// The page is up, in place of the threads list and the thread.
    pub(crate) showing: bool,
    /// Loaded from the settings file the first time it's shown.
    layout: Option<Layout>,
    entries: Vec<Entry>,
    /// The thread list's change count when the board was last brought up to date.
    synced: Option<u64>,
    synced_at: Option<Instant>,
    camera: Option<Camera>,
    flight: Option<Flight>,
    /// The thread the camera's flying in to, then the one shown for real.
    entering: Option<String>,
    pub(crate) entered: Option<String>,
    /// Where the camera was before it flew in, to fly back to.
    before: Option<Camera>,
    /// The area whose name was clicked; the others dim.
    spotlight: Option<String>,
    press: Option<Press>,
    arrived: HashMap<String, Instant>,
    collapsed: HashMap<String, Instant>,
    glowing: HashMap<String, Instant>,
    /// Where Tidy moved things from.
    tidied: Option<(HashMap<String, Rect>, Instant)>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    focus: Option<FocusHandle>,
    /// The thread list has come at least once: until then every thread
    /// would look archived.
    pub(crate) listed: bool,
    /// `open` came from here: it doesn't take the page down.
    pub(crate) opening: bool,
    dirty: bool,
}

impl CanvasPage {
    fn viewport(&self) -> Option<(f32, f32)> {
        self.bounds
            .get()
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
    }

    /// The camera now, partway through a flight or not.
    fn camera_now(&mut self) -> Camera {
        let cam = self.camera.unwrap_or_default();
        let Some((from, to, start)) = self.flight.as_ref().map(|f| (f.from, f.to, f.start)) else {
            return cam;
        };
        let k = start.elapsed().as_secs_f32() * 1000. / FLY_MS;
        if k >= 1. {
            self.camera = Some(to);
            self.flight = None;
            if let Some(id) = self.entering.take() {
                self.entered = Some(id);
            }
            return to;
        }
        let (vw, vh) = self.viewport().unwrap_or((1200., 800.));
        from.toward(&to, ease(k), vw, vh)
    }

    fn fly(&mut self, to: Camera) {
        let from = self.camera_now();
        self.camera = Some(to);
        self.flight = Some(Flight {
            from,
            to,
            start: Instant::now(),
        });
    }

    /// Stops a flight where it is, for a hand on the board.
    fn hold(&mut self) -> Camera {
        let cam = self.camera_now();
        self.flight = None;
        self.camera = Some(cam);
        cam
    }

    fn fit_all(&self) -> Option<Camera> {
        let (vw, vh) = self.viewport()?;
        let all = self.layout.as_ref()?.bounds()?;
        // Room above for the areas' names, below for the strip.
        let all = Rect::new(all.x, all.y - 260., all.w, all.h + 260.);
        let mut cam = Camera::fit(all, vw, vh - STRIP_H, 40., 1.);
        cam.s = cam.s.clamp(MIN_ZOOM, MAX_ZOOM);
        Some(cam)
    }

    /// The camera that fills the view with a thread's window: no bigger than
    /// its real size, so the thread that takes over is drawn as it was.
    fn camera_for(&self, id: &str) -> Option<Camera> {
        let (vw, vh) = self.viewport()?;
        let r = self.layout.as_ref()?.rect(id)?;
        let s = ((vw - 24.) / WIN_W).min((vh - 24.) / WIN_H).min(1.);
        let (cx, cy) = r.center();
        Some(Camera {
            s,
            tx: vw / 2. - cx * s,
            ty: vh / 2. - cy * s,
        })
    }

    fn moving(&self) -> bool {
        let busy = |m: &HashMap<String, Instant>, ms: f32| {
            m.values().any(|t| t.elapsed().as_secs_f32() * 1000. < ms)
        };
        self.flight.is_some()
            || busy(&self.arrived, ARRIVE_MS)
            || busy(&self.collapsed, COLLAPSE_MS)
            || busy(&self.glowing, GLOW_MS)
            || self
                .tidied
                .as_ref()
                .is_some_and(|(_, t)| t.elapsed().as_secs_f32() * 1000. < TIDY_MS)
    }

    /// Two fingers or a wheel belong to the board, not Back and Forward,
    /// while it's up and no thread is open in it.
    pub(crate) fn takes_scroll(&self) -> bool {
        self.showing && self.entered.is_none()
    }

    /// Whether the board's camera or anything on it is still moving, for the
    /// specs' settle.
    pub(crate) fn in_motion(&self) -> bool {
        self.showing && self.moving()
    }
}

fn k_of(t: Instant, ms: f32) -> f32 {
    (t.elapsed().as_secs_f32() * 1000. / ms).min(1.)
}

fn lerp(a: f32, b: f32, k: f32) -> f32 {
    a + (b - a) * k
}

fn lerp_rect(a: &Rect, b: &Rect, k: f32) -> Rect {
    Rect::new(
        lerp(a.x, b.x, k),
        lerp(a.y, b.y, k),
        lerp(a.w, b.w, k),
        lerp(a.h, b.h, k),
    )
}

/// The colours, dark and light.
#[derive(Clone, Copy)]
struct Look {
    dark: bool,
    canvas: Hsla,
    dots: Hsla,
    ground: Hsla,
    ground_edge: Hsla,
    window: Hsla,
    window_edge: Hsla,
    line: Hsla,
    text: Hsla,
    muted: Hsla,
    faint: Hsla,
    bubble: Hsla,
    composer: Hsla,
    composer_edge: Hsla,
}

impl Look {
    fn new(dark: bool) -> Look {
        let c = |d: u32, l: u32| -> Hsla { rgb(if dark { d } else { l }).into() };
        Look {
            dark,
            canvas: c(0x151515, 0xEDEDF0),
            dots: c(0x262626, 0xCFCFD6),
            ground: c(0x1A1A1A, 0xF6F6F8),
            ground_edge: c(0x212121, 0xE2E2E6),
            window: c(0x1E1E1E, 0xFFFFFF),
            window_edge: c(0x2E2E2E, 0xDCDCE0),
            line: c(0x2B2B2B, 0xE8E8EC),
            text: c(0xE4E4E4, 0x1E1E22),
            muted: c(0x8B8B8B, 0x7A7A80),
            faint: c(0x6C6C6C, 0x9A9AA0),
            bubble: c(0x1F2C3B, 0xE4EEFA),
            composer: c(0x232323, 0xF7F7F9),
            composer_edge: c(0x333333, 0xDCDCE0),
        }
    }
}

/// One frame's camera, view, spotlight and colours.
struct Frame {
    cam: Camera,
    view: (f32, f32),
    spot: Option<String>,
    look: Look,
}

impl Frame {
    fn visible(&self, r: &Rect) -> bool {
        let s = self.cam.rect(r);
        let (vw, vh) = self.view;
        s.right() > -60. && s.x < vw + 60. && s.bottom() > -60. && s.y < vh + 60.
    }

    /// An area out of the spotlight fades back.
    fn dim(&self, area: &str) -> f32 {
        if self.spot.as_deref().is_some_and(|s| s != area) {
            DIMMED
        } else {
            1.
        }
    }

    /// Where each window is this frame: Tidy's slide, an arrival growing in
    /// from its left edge, a ghost collapsing.
    fn placed(&self, page: &CanvasPage, layout: &Layout) -> Vec<Placed> {
        let mut placed = Vec::new();
        for (id, spot_of) in &layout.spots {
            let Some(mut r) = layout.rect(id) else {
                continue;
            };
            let ghost = spot_of.ghost.is_some();
            if let Some((from, at)) = &page.tidied {
                if let Some(f) = from.get(id) {
                    let k = ease(k_of(*at, TIDY_MS));
                    r = lerp_rect(&Rect::new(f.x, f.y, r.w, r.h), &r, k);
                }
            }
            let mut collapse = if ghost { 1. } else { 0. };
            if let Some(t) = page.collapsed.get(id) {
                collapse = ease(k_of(*t, COLLAPSE_MS));
                r.h = lerp(WIN_H, GHOST_H, collapse);
            }
            let (mut scale, mut alpha) = (1., if ghost { 0.7 } else { 1. });
            if let Some(t) = page.arrived.get(id) {
                let k = ease(k_of(*t, ARRIVE_MS));
                scale = lerp(0.55, 1., k);
                alpha = k;
                let h = r.h * scale;
                r = Rect::new(r.x, r.y + (r.h - h) / 2., r.w * scale, h);
            }
            if !self.visible(&r) {
                continue;
            }
            placed.push(Placed {
                id: id.clone(),
                rect: r,
                scale,
                alpha: alpha * self.dim(&spot_of.area),
                ghost,
                collapse,
            });
        }
        placed
    }

    /// The areas' ground, glowing a while after something arrives.
    fn grounds(&self, page: &CanvasPage, layout: &Layout) -> Vec<AnyElement> {
        let (cam, look) = (self.cam, self.look);
        let mut out = Vec::new();
        for key in layout.areas.keys() {
            let Some(g) = layout.ground(key) else {
                continue;
            };
            if !self.visible(&g) {
                continue;
            }
            let s = cam.rect(&g);
            let has = layout.spots.values().any(|sp| sp.area == *key);
            let glow = page.glowing.get(key).map_or(0., |t| 1. - k_of(*t, GLOW_MS));
            let mut ground = div()
                .absolute()
                .left(gpui_kit::px(s.x))
                .top(gpui_kit::px(s.y))
                .w(gpui_kit::px(s.w))
                .h(gpui_kit::px(s.h))
                .rounded(gpui_kit::px(70. * cam.s))
                .bg(look.ground)
                .border_2()
                .border_color(look.ground_edge)
                .opacity((if has { 1. } else { 0.35 }) * self.dim(key));
            if glow > 0. {
                ground = ground.shadow(vec![BoxShadow {
                    color: hsla(0., 0., if look.dark { 1. } else { 0.4 }, 0.16 * glow),
                    offset: point(gpui_kit::px(0.), gpui_kit::px(0.)),
                    blur_radius: gpui_kit::px(40.),
                    spread_radius: gpui_kit::px(4.),
                    inset: false,
                }]);
            }
            out.push(ground.into_any_element());
        }
        out
    }

    /// The arrows, drawn under the windows, and why each was started in
    /// handwriting, which goes over them, so a window never hides it.
    fn arrows(&self, page: &CanvasPage, layout: &Layout) -> (AnyElement, Vec<AnyElement>) {
        let cam = self.cam;
        let inv = (0.55 / cam.s).clamp(1., 3.);
        let mut pens: Vec<(Curve, f32, Hsla)> = Vec::new();
        let mut words: Vec<AnyElement> = Vec::new();
        let ghostly = |id: &str| layout.spots.get(id).is_some_and(|s| s.ghost.is_some());
        for edge in layout.edges() {
            let Some(curve) = layout.curve(&edge, inv) else {
                continue;
            };
            let reach = Rect::new(
                curve.start.0.min(curve.end.0),
                curve.start.1.min(curve.end.1),
                (curve.end.0 - curve.start.0).abs(),
                (curve.end.1 - curve.start.1).abs(),
            );
            if !self.visible(&reach) {
                continue;
            }
            let child = layout.spots.get(&edge.child);
            let area = child.map(|s| s.area.as_str()).unwrap_or_default();
            let fresh = page
                .arrived
                .get(&edge.child)
                .map_or(1., |t| k_of(*t, ARRIVE_MS));
            let alpha = match (ghostly(&edge.parent), ghostly(&edge.child)) {
                (true, true) => 0.35,
                (false, false) => 1.,
                _ => 0.6,
            } * self.dim(area)
                * fresh;
            let screen = Curve {
                start: cam.to_screen(curve.start),
                c1: cam.to_screen(curve.c1),
                c2: cam.to_screen(curve.c2),
                end: cam.to_screen(curve.end),
                mid: cam.to_screen(curve.mid),
            };
            pens.push((
                screen,
                2.2 * inv * cam.s,
                Hsla::from(rgb(INK)).opacity(alpha),
            ));
            let why = child.and_then(|s| s.why.clone()).unwrap_or_default();
            let size = 26. * inv * cam.s;
            if cam.s > 0.16 && !why.is_empty() && size >= 6. {
                let width = 22. * 13. * inv * cam.s;
                let (mx, my) = screen.mid;
                words.push(
                    v_flex()
                        .absolute()
                        .left(gpui_kit::px(mx - width / 2.))
                        .top(gpui_kit::px(my + 8. * inv * cam.s))
                        .w(gpui_kit::px(width))
                        .items_center()
                        .font_family(crate::fonts::HANDWRITING)
                        .font_weight(FontWeight::BOLD)
                        .text_size(gpui_kit::px(size))
                        .line_height(gpui_kit::px(size * 1.05))
                        .text_color(Hsla::from(rgb(INK_WORDS)).opacity(alpha))
                        .children(
                            board::wrap_words(&why, 22)
                                .into_iter()
                                .map(|l| div().child(l)),
                        )
                        .into_any_element(),
                );
            }
        }
        let painter = canvas(
            |_, _, _| {},
            move |bounds, _, window, _| paint_arrows(&pens, bounds.origin, window),
        )
        .absolute()
        .inset_0()
        .into_any_element();
        (painter, words)
    }

    /// The miniatures, and their titles above them when they're too small
    /// to read. The open thread's is the real one instead.
    fn windows(
        &self,
        placed: &[Placed],
        layout: &Layout,
        threads: &crate::thread_map::ThreadMap,
        inside: Option<&str>,
    ) -> Vec<AnyElement> {
        let (cam, look) = (self.cam, self.look);
        let mut out = Vec::new();
        let mut titles = Vec::new();
        for p in placed {
            if inside == Some(p.id.as_str()) {
                continue;
            }
            let summary = threads.get(&p.id).cloned();
            let title = summary
                .as_ref()
                .map(|t| t.title.clone())
                .or_else(|| layout.spots.get(&p.id).map(|s| s.title.clone()))
                .unwrap_or_default();
            let waiting = summary.as_ref().is_some_and(|t| t.wants_you());
            out.push(miniature(
                p,
                &cam,
                summary.as_deref(),
                &title,
                waiting,
                look,
            ));
            let screen = cam.rect(&p.rect);
            // Further out, a dot on the window's corner for one waiting on Mike.
            if cam.s < TITLES_ABOVE && waiting && !p.ghost {
                titles.push(
                    dot(8.)
                        .absolute()
                        .left(gpui_kit::px(screen.right() - 4.))
                        .top(gpui_kit::px(screen.y - 4.))
                        .into_any_element(),
                );
            }
            if (TITLES_ABOVE..TITLES_BELOW).contains(&cam.s) && screen.w > 28. {
                let size = 12.;
                titles.push(
                    h_flex()
                        .absolute()
                        .left(gpui_kit::px(screen.x + 2.))
                        .top(gpui_kit::px(screen.y - size * 1.7))
                        .w(gpui_kit::px(screen.w + board::GAP_X * cam.s * 0.3))
                        .gap(gpui_kit::px(5.))
                        .items_center()
                        .opacity(p.alpha.min(1.))
                        .text_size(gpui_kit::px(size))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(look.muted)
                        .when(waiting && !p.ghost, |d| d.child(dot(8.)))
                        .child(div().min_w_0().truncate().child(title))
                        .into_any_element(),
                );
            }
        }
        out.extend(titles);
        out
    }
}

/// One window on screen: where, at what scale, how faded.
struct Placed {
    id: String,
    rect: Rect,
    scale: f32,
    alpha: f32,
    ghost: bool,
    /// Collapsing to its pill: 0 as a window, 1 as the pill.
    collapse: f32,
}

impl Threadbear {
    /// Whether the runner has the experiment on.
    pub(crate) fn thread_canvas_on(&self) -> bool {
        self.experiment_on(board::EXPERIMENT)
    }

    /// The rail's Canvas button: the page in place of the list and the thread.
    pub(crate) fn show_thread_canvas(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let page = &mut self.thread_canvas;
        if page.showing && page.entered.is_some() {
            self.canvas_leave_thread(window, cx);
            return;
        }
        page.showing = true;
        page.synced = None;
        let focus = page.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        window.focus(&focus, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    /// Anything else in the rail, or a thread opened from elsewhere.
    pub(crate) fn hide_thread_canvas(&mut self) {
        let page = &mut self.thread_canvas;
        page.showing = false;
        page.entered = None;
        page.entering = None;
        page.flight = None;
        page.press = None;
    }

    fn canvas_layout_mut(&mut self) -> &mut Layout {
        let saved = self.settings.saved.thread_canvas.clone();
        self.thread_canvas
            .layout
            .get_or_insert_with(|| saved.as_ref().map(Layout::from_json).unwrap_or_default())
    }

    /// The board brought up to date with the threads, when they've changed
    /// (or every half minute, for ghosts whose grace has run out).
    fn canvas_sync(&mut self, cx: &mut Context<Self>) {
        if !self.thread_canvas.listed {
            // Still the saved board, as it was, till the list comes.
            self.canvas_layout_mut();
            return;
        }
        let changes = self.threads.changes();
        let stale = self
            .thread_canvas
            .synced_at
            .is_none_or(|t| t.elapsed().as_secs() >= 30);
        if self.thread_canvas.synced == Some(changes) && !stale {
            return;
        }
        let entries = board::entries(self.threads.values().map(|t| t.as_ref()));
        let projects: Vec<(String, String, bool)> = self
            .projects
            .list
            .iter()
            .map(|p| (p.id.clone(), p.title.clone(), p.archived))
            .collect();
        let now = crate::now_ms();
        let layout = self.canvas_layout_mut();
        let before = layout.clone();
        let made = layout.sync(&entries, &projects, now);
        let changed = *layout != before;
        let page = &mut self.thread_canvas;
        let at = Instant::now();
        for id in made.arrived {
            page.arrived.insert(id, at);
        }
        for id in made.archived {
            page.collapsed.insert(id, at);
        }
        for area in made.glow {
            page.glowing.insert(area, at);
        }
        page.arrived.retain(|_, t| k_of(*t, ARRIVE_MS) < 1.);
        page.collapsed.retain(|_, t| k_of(*t, COLLAPSE_MS) < 1.);
        page.glowing.retain(|_, t| k_of(*t, GLOW_MS) < 1.);
        page.entries = entries;
        page.synced = Some(changes);
        page.synced_at = Some(at);
        if changed {
            self.canvas_save(cx);
        }
    }

    fn canvas_save(&mut self, cx: &mut Context<Self>) {
        let page = &mut self.thread_canvas;
        let Some(layout) = page.layout.as_mut() else {
            return;
        };
        // The camera as it is, and never inside a thread: back out to where
        // it flew in from.
        let cam = if page.entered.is_some() || page.entering.is_some() {
            page.before
        } else {
            page.camera
        };
        if let Some(c) = cam {
            layout.camera = Some([c.s, c.tx, c.ty]);
        }
        self.settings.saved.thread_canvas = Some(layout.to_json());
        page.dirty = false;
        self.save_settings_soon(cx);
    }

    /// The page, drawn in place of the dock.
    pub(crate) fn render_thread_canvas(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.canvas_sync(cx);
        let look = Look::new(cx.theme().is_dark());
        let focus = self
            .thread_canvas
            .focus
            .get_or_insert_with(|| cx.focus_handle())
            .clone();
        // The first frame: the camera it was left at, or everything in view,
        // once the page knows its size.
        if self.thread_canvas.camera.is_none() {
            let saved = self
                .thread_canvas
                .layout
                .as_ref()
                .and_then(|l| l.camera)
                .map(|[s, tx, ty]| Camera { s, tx, ty });
            match saved.or_else(|| self.thread_canvas.fit_all()) {
                Some(c) => self.thread_canvas.camera = Some(c),
                None => window.request_animation_frame(),
            }
        }
        let cam = self.thread_canvas.camera_now();
        if self.thread_canvas.moving() {
            window.request_animation_frame();
        }
        if std::mem::take(&mut self.thread_canvas.dirty) {
            self.canvas_save(cx);
        }
        let page = &self.thread_canvas;
        let Some(layout) = page.layout.clone() else {
            return div().into_any_element();
        };
        let frame = Frame {
            cam,
            view: page.viewport().unwrap_or((1600., 1000.)),
            spot: page.spotlight.clone(),
            look,
        };
        let inside = page.entered.clone();
        let placed = frame.placed(page, &layout);
        let (arrows, why) = frame.arrows(page, &layout);
        let layer = div()
            .absolute()
            .inset_0()
            .children(frame.grounds(page, &layout))
            .child(arrows)
            .children(frame.windows(&placed, &layout, &self.threads, inside.as_deref()))
            .children(why)
            .children(self.canvas_area_names(&frame, &layout, cx))
            .children(self.canvas_open_thread(&frame, &layout));
        let strip = self.canvas_strip(look, cx);
        let tools = self.canvas_tools(look, inside.is_some(), cx);
        div()
            .id("thread-canvas")
            .track_focus(&focus)
            .key_context("ThreadCanvas")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(look.canvas)
            .child(self.canvas_backdrop(&frame, cx))
            .child(layer)
            .child(tools)
            .children(strip)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    this.canvas_pressed(ev, window, cx)
                }),
            )
            .on_mouse_move(
                cx.listener(|this, ev: &MouseMoveEvent, _, cx| this.canvas_moved(ev, cx)),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseUpEvent, window, cx| {
                    this.canvas_released(ev, window, cx)
                }),
            )
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" && this.canvas_escape(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .into_any_element()
    }

    /// The dots behind the board, which also note where the page is and hear
    /// ⌘ and the wheel, and a pinch, before the thread under the pointer
    /// scrolls: they zoom the board, or fly out of a thread.
    fn canvas_backdrop(&self, frame: &Frame, cx: &mut Context<Self>) -> AnyElement {
        let bounds_cell = self.thread_canvas.bounds.clone();
        let cam = frame.cam;
        let colour = frame.look.dots;
        let me = cx.entity().downgrade();
        canvas(
            move |bounds, _, _| bounds_cell.set(Some(bounds)),
            move |bounds, _, window, _| {
                paint_dots(&cam, colour, bounds, window);
                let pinch = me.clone();
                window.on_mouse_event(move |ev: &ScrollEvent, phase, window, cx| {
                    if phase != DispatchPhase::Capture || !bounds.contains(&ev.position) {
                        return;
                    }
                    me.update(cx, |this, cx| this.canvas_scrolled(ev, window, cx))
                        .ok();
                });
                window.on_mouse_event(move |ev: &PinchEvent, phase, window, cx| {
                    if phase != DispatchPhase::Capture || !bounds.contains(&ev.position) {
                        return;
                    }
                    pinch
                        .update(cx, |this, cx| this.canvas_pinched(ev, window, cx))
                        .ok();
                });
            },
        )
        .absolute()
        .inset_0()
        .into_any_element()
    }

    /// Each area's name, faint, above its ground; a click spotlights it.
    fn canvas_area_names(
        &self,
        frame: &Frame,
        layout: &Layout,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let (cam, view, look) = (frame.cam, frame.view, frame.look);
        let mut out = Vec::new();
        for (key, area) in &layout.areas {
            let Some(g) = layout.ground(key) else {
                continue;
            };
            let s = cam.rect(&g);
            if s.right() < 0. || s.x > view.0 || s.bottom() < 0. || s.y - 40. > view.1 {
                continue;
            }
            let size = (60. * cam.s).clamp(13., 24.);
            let lit = frame.spot.as_deref() == Some(key.as_str());
            let has = layout.spots.values().any(|sp| sp.area == *key);
            let key_click = key.clone();
            out.push(
                div()
                    .id(SharedString::from(format!("canvas-area-{key}")))
                    .role(Role::Button)
                    .aria_label(SharedString::from(format!("Spotlight {}", area.title)))
                    .absolute()
                    .left(gpui_kit::px(s.x - 6.))
                    .top(gpui_kit::px(s.y - size * 2.))
                    .max_w(gpui_kit::px(s.w.max(60.)))
                    .px(gpui_kit::px(6.))
                    .py(gpui_kit::px(2.))
                    .rounded(gpui_kit::px(6.))
                    .truncate()
                    .text_size(gpui_kit::px(size))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if lit {
                        look.text
                    } else if has {
                        look.muted
                    } else {
                        look.faint
                    })
                    .opacity(frame.dim(key).max(0.5))
                    .cursor_pointer()
                    .hover(|d| d.bg(hsla(0., 0., 0.5, 0.08)))
                    .child(area.title.clone())
                    .tip(if lit {
                        "Show every project again (Esc)".to_owned()
                    } else {
                        format!("Spotlight {}: the other projects fade back", area.title)
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        let page = &mut this.thread_canvas;
                        page.spotlight = if page.spotlight.as_deref() == Some(key_click.as_str()) {
                            None
                        } else {
                            Some(key_click.clone())
                        };
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        out
    }

    /// The thread itself, where its miniature was, once the flight's in: the
    /// same pane the main panel shows, under the miniature's title bar.
    fn canvas_open_thread(&self, frame: &Frame, layout: &Layout) -> Option<AnyElement> {
        let id = self.thread_canvas.entered.as_deref()?;
        let pane = self.pane.clone()?;
        if self.selected.as_deref() != Some(id) {
            return None;
        }
        let (cam, look) = (frame.cam, frame.look);
        let s = cam.rect(&layout.rect(id)?);
        let summary = self.threads.get(id).cloned();
        let title = summary
            .as_ref()
            .map(|t| t.title.clone())
            .unwrap_or_default();
        Some(
            v_flex()
                .id("canvas-thread")
                .absolute()
                .left(gpui_kit::px(s.x))
                .top(gpui_kit::px(s.y))
                .w(gpui_kit::px(s.w))
                .h(gpui_kit::px(s.h))
                .rounded(gpui_kit::px(12. * cam.s))
                .bg(look.window)
                .border_1()
                .border_color(look.window_edge)
                .overflow_hidden()
                .shadow(window_shadow())
                .child(header(&cam, &title, false, false, 1., look))
                .child(div().flex_1().min_h_0().child(pane))
                .into_any_element(),
        )
    }

    /// Tidy and See everything, top right; faint while a thread's open.
    fn canvas_tools(&mut self, look: Look, inside: bool, cx: &mut Context<Self>) -> AnyElement {
        let ghosts = self
            .thread_canvas
            .layout
            .as_ref()
            .is_some_and(|l| l.spots.values().any(|s| s.ghost.is_some()));
        let button = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .role(Role::Button)
                .aria_label(label)
                .px(gpui_kit::px(10.))
                .py(gpui_kit::px(4.))
                .rounded(gpui_kit::px(8.))
                .text_size(gpui_kit::px(12.))
                .text_color(look.muted)
                .cursor_pointer()
                .hover(|d| d.bg(hsla(0., 0., 0.5, 0.12)).text_color(look.text))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(label)
        };
        h_flex()
            .absolute()
            .top(gpui_kit::px(10.))
            .right(gpui_kit::px(12.))
            .gap(gpui_kit::px(2.))
            .p(gpui_kit::px(3.))
            .rounded(gpui_kit::px(10.))
            .bg(look.window.opacity(0.85))
            .border_1()
            .border_color(look.line)
            .opacity(if inside { 0.3 } else { 1. })
            .child(
                button("canvas-fit", "See everything")
                    .tip("See everything (0)")
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.canvas_see_all(window, cx)
                    })),
            )
            .when(ghosts, |d| {
                d.child(
                    button("canvas-tidy", "Tidy")
                        .tip("Tidy: clear the archived threads' ghosts and close the gaps")
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.canvas_tidy(cx))),
                )
            })
            .into_any_element()
    }

    /// Threads a schedule, a tool or the runner started, waiting off the
    /// board until they need Mike. A click opens one as a thread.
    fn canvas_strip(&mut self, look: Look, cx: &mut Context<Self>) -> Option<AnyElement> {
        let page = &self.thread_canvas;
        let layout = page.layout.as_ref()?;
        let strip = layout.strip(&page.entries);
        if strip.is_empty() {
            return None;
        }
        let running = |id: &str| self.threads.get(id).is_some_and(|t| t.status == "running");
        let chips: Vec<AnyElement> = strip
            .iter()
            .take(40)
            .map(|e| {
                let id = e.id.clone();
                let on = running(&e.id);
                div()
                    .id(SharedString::from(format!("canvas-strip-{}", e.id)))
                    .role(Role::Button)
                    .aria_label(SharedString::from(format!("Open {}", e.title)))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(gpui_kit::px(6.))
                    .max_w(gpui_kit::px(200.))
                    .h(gpui_kit::px(20.))
                    .px(gpui_kit::px(9.))
                    .rounded(gpui_kit::px(10.))
                    .bg(look.ground)
                    .text_size(gpui_kit::px(11.))
                    .text_color(look.muted)
                    .cursor_pointer()
                    .hover(|d| d.text_color(look.text))
                    .child(
                        div()
                            .flex_none()
                            .size(gpui_kit::px(5.))
                            .rounded_full()
                            .bg(if on { look.text } else { look.faint }),
                    )
                    .child(div().min_w_0().truncate().child(e.title.clone()))
                    .tip(format!("Open {}", e.title))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.hide_thread_canvas();
                        this.set_mode(crate::shell::SidebarMode::Inbox, cx);
                        this.open(id.clone(), window, cx);
                    }))
                    .into_any_element()
            })
            .collect();
        Some(
            h_flex()
                .id("canvas-strip")
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(gpui_kit::px(STRIP_H))
                .px(gpui_kit::px(14.))
                .gap(gpui_kit::px(6.))
                .items_center()
                .overflow_hidden()
                .bg(look.canvas.opacity(0.92))
                .border_t_1()
                .border_color(look.line)
                .opacity(if page.entered.is_some() { 0.3 } else { 1. })
                .children(chips)
                .into_any_element(),
        )
    }

    fn canvas_point(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let b = self.thread_canvas.bounds.get()?;
        Some((f32::from(at.x - b.origin.x), f32::from(at.y - b.origin.y)))
    }

    /// Whether a point on the page is on the thread open in it.
    fn on_open_thread(&self, at: (f32, f32)) -> bool {
        let page = &self.thread_canvas;
        let (Some(id), Some(layout), Some(cam)) = (&page.entered, &page.layout, page.camera) else {
            return false;
        };
        layout.rect(id).is_some_and(|r| cam.rect(&r).contains(at))
    }

    fn canvas_pressed(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        if self.thread_canvas.entered.is_some() {
            // A press beside the open thread flies back out.
            if !self.on_open_thread(at) {
                self.canvas_leave_thread(window, cx);
            }
            return;
        }
        let page = &mut self.thread_canvas;
        let cam = page.hold();
        let world = cam.to_world(at);
        let hit = page.layout.as_ref().and_then(|l| {
            let id = l.at(world)?;
            let r = l.rect(&id)?;
            Some((id, (r.x, r.y)))
        });
        page.press = Some(Press {
            from: at,
            camera: cam,
            window: hit,
            moved: false,
        });
        if let Some(f) = &page.focus {
            window.focus(f, cx);
            crate::web_panels::keyboard_to_app(window);
        }
        cx.notify();
    }

    fn canvas_moved(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let page = &mut self.thread_canvas;
        let Some(press) = page.press.as_mut() else {
            return;
        };
        if ev.pressed_button != Some(MouseButton::Left) {
            page.press = None;
            return;
        }
        let (dx, dy) = (at.0 - press.from.0, at.1 - press.from.1);
        if !press.moved && (dx * dx + dy * dy).sqrt() < DRAG_SLOP {
            return;
        }
        press.moved = true;
        match &press.window {
            // Dragging a miniature moves it, and it stays there.
            Some((id, (x, y))) => {
                let s = press.camera.s;
                let to = (x + dx / s, y + dy / s);
                let id = id.clone();
                if let Some(l) = page.layout.as_mut() {
                    l.move_to(&id, to);
                }
            }
            None => page.camera = Some(press.camera.pan(dx, dy)),
        }
        cx.notify();
    }

    fn canvas_released(&mut self, _ev: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(press) = self.thread_canvas.press.take() else {
            return;
        };
        match (press.moved, press.window) {
            (false, Some((id, _))) => self.canvas_enter_thread(id, window, cx),
            // A click on the empty board ends a spotlight.
            (false, None) => {
                self.thread_canvas.spotlight = None;
                cx.notify();
            }
            (true, _) => self.canvas_save(cx),
        }
    }

    /// ⌘ or Control and the wheel zoom round the pointer (and fly out of an
    /// open thread); the plain wheel and two fingers move the board, and
    /// scroll an open thread as usual.
    fn canvas_scrolled(&mut self, ev: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let zoom = ev.modifiers.platform || ev.modifiers.control;
        let page = &self.thread_canvas;
        if page.entered.is_some() || page.entering.is_some() {
            if zoom && wheel_out(ev) {
                self.canvas_leave_thread(window, cx);
                cx.stop_propagation();
            }
            return;
        }
        let page = &mut self.thread_canvas;
        let cam = page.hold();
        let next = match ev.delta {
            ScrollDelta::Lines(l) if zoom => {
                cam.zoom_at(at, threadbear_core::review_canvas::wheel_zoom(l.y))
            }
            ScrollDelta::Pixels(p) if zoom && ev.source == ScrollSource::Wheel => cam.zoom_at(
                at,
                threadbear_core::review_canvas::smooth_wheel_zoom(f32::from(p.y)),
            ),
            ScrollDelta::Pixels(p) if zoom => cam.zoom_at(at, (f32::from(p.y) * 0.01).exp()),
            ScrollDelta::Lines(l) => cam.pan(l.x * 40., l.y * 40.),
            ScrollDelta::Pixels(p) => cam.pan(f32::from(p.x), f32::from(p.y)),
        };
        page.camera = Some(clamped(next, at));
        page.dirty = true;
        cx.stop_propagation();
        cx.notify();
    }

    fn canvas_pinched(&mut self, ev: &PinchEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let page = &self.thread_canvas;
        if page.entered.is_some() || page.entering.is_some() {
            if ev.delta < -0.02 {
                self.canvas_leave_thread(window, cx);
                cx.stop_propagation();
            }
            return;
        }
        let page = &mut self.thread_canvas;
        let cam = page.hold();
        page.camera = Some(clamped(cam.zoom_at(at, 1. + ev.delta), at));
        page.dirty = true;
        cx.stop_propagation();
        cx.notify();
    }

    /// Esc: out of the open thread, else the spotlight off.
    fn canvas_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.thread_canvas.entered.is_some() || self.thread_canvas.entering.is_some() {
            self.canvas_leave_thread(window, cx);
            return true;
        }
        if self.thread_canvas.spotlight.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    /// A click on a miniature: the camera flies in until it fills the view,
    /// the thread loading meanwhile, and the real thread takes its place.
    pub(crate) fn canvas_enter_thread(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(to) = self.thread_canvas.camera_for(&id) else {
            return;
        };
        if !self.threads.contains_key(&id) {
            return;
        }
        let page = &mut self.thread_canvas;
        let now = page.hold();
        page.before = Some(now);
        page.entering = Some(id.clone());
        page.entered = None;
        page.fly(to);
        // Loaded during the flight; it comes in still, as the flight is its motion.
        page.opening = true;
        self.opening.next = Some(crate::open_motion::Opening::Still);
        self.open(id, window, cx);
        self.thread_canvas.opening = false;
        cx.notify();
    }

    /// Back out to the board, the miniature in the thread's place first.
    pub(crate) fn canvas_leave_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let page = &mut self.thread_canvas;
        let left = page.entered.take().or(page.entering.take());
        let back = page.before.take().or_else(|| {
            let cam = page.camera_now();
            let (vw, vh) = page.viewport()?;
            Some(cam.zoom_at((vw / 2., vh / 2.), 0.35))
        });
        if let Some(to) = back {
            page.fly(to);
        }
        if let Some(f) = page.focus.clone() {
            window.focus(&f, cx);
            crate::web_panels::keyboard_to_app(window);
        }
        if left.is_some() {
            page.dirty = true;
        }
        cx.notify();
    }

    fn canvas_see_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread_canvas.entered.is_some() {
            self.canvas_leave_thread(window, cx);
        }
        let page = &mut self.thread_canvas;
        page.before = None;
        if let Some(to) = page.fit_all() {
            page.fly(to);
            page.dirty = true;
        }
        cx.notify();
    }

    /// Tidy: the ghosts go and the gaps close, as a slide.
    fn canvas_tidy(&mut self, cx: &mut Context<Self>) {
        let page = &mut self.thread_canvas;
        let Some(layout) = page.layout.as_mut() else {
            return;
        };
        let from: HashMap<String, Rect> = layout
            .spots
            .keys()
            .filter_map(|id| Some((id.clone(), layout.rect(id)?)))
            .collect();
        layout.tidy(&page.entries);
        page.tidied = Some((from, Instant::now()));
        self.canvas_save(cx);
        cx.notify();
    }

    /// The scripted app's `canvas` command (features/thread-canvas.feature):
    /// `show`, `hide`, `enter` (a thread id), `leave`, `zoom` (a factor
    /// round the middle), `pan` ([dx, dy]), `spotlight` (an area id or
    /// null), `tidy`, `fit`; then the board as it is.
    #[cfg(feature = "automation")]
    pub(crate) fn canvas_command(
        &mut self,
        cmd: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<Value, String> {
        if cmd["show"].as_bool() == Some(true) {
            if !self.thread_canvas_on() {
                return Err("the threadCanvas experiment is off".into());
            }
            self.show_thread_canvas(window, cx);
        }
        if cmd["hide"].as_bool() == Some(true) {
            self.hide_thread_canvas();
            cx.notify();
        }
        if let Some(id) = cmd["enter"].as_str() {
            self.canvas_sync(cx);
            if self
                .thread_canvas
                .layout
                .as_ref()
                .and_then(|l| l.rect(id))
                .is_none()
            {
                return Err(format!("{id} isn't on the board"));
            }
            self.canvas_enter_thread(id.to_owned(), window, cx);
        }
        if cmd["leave"].as_bool() == Some(true) {
            self.canvas_leave_thread(window, cx);
        }
        if let Some(f) = cmd["zoom"].as_f64() {
            let page = &mut self.thread_canvas;
            let (vw, vh) = page.viewport().unwrap_or((1200., 800.));
            let cam = page.hold();
            page.camera = Some(clamped(cam.zoom_at((vw / 2., vh / 2.), f as f32), (0., 0.)));
        }
        if let Some([dx, dy]) = cmd["pan"].as_array().map(|a| {
            [
                a.first().and_then(Value::as_f64).unwrap_or(0.) as f32,
                a.get(1).and_then(Value::as_f64).unwrap_or(0.) as f32,
            ]
        }) {
            let page = &mut self.thread_canvas;
            let cam = page.hold();
            page.camera = Some(cam.pan(dx, dy));
        }
        if cmd.get("spotlight").is_some() {
            self.thread_canvas.spotlight = cmd["spotlight"].as_str().map(str::to_owned);
        }
        // An area (its id) or a thread (its id) filling the view, at `zoom`
        // times that if given: for pictures at a scale.
        if let Some(id) = cmd["look"].as_str() {
            let page = &mut self.thread_canvas;
            let rect = page
                .layout
                .as_ref()
                .and_then(|l| l.ground(id).or_else(|| l.rect(id)))
                .ok_or(format!("no area or thread {id}"))?;
            let (vw, vh) = page.viewport().unwrap_or((1200., 800.));
            let mut cam = Camera::fit(rect, vw, vh - STRIP_H, 60., MAX_ZOOM);
            if let Some(f) = cmd["by"].as_f64() {
                cam = cam.zoom_at((vw / 2., vh / 2.), f as f32);
            }
            page.hold();
            page.camera = Some(cam);
        }
        if cmd["tidy"].as_bool() == Some(true) {
            self.canvas_tidy(cx);
        }
        if cmd["fit"].as_bool() == Some(true) {
            self.canvas_see_all(window, cx);
        }
        cx.notify();
        Ok(self.canvas_state())
    }

    #[cfg(feature = "automation")]
    pub(crate) fn canvas_state(&self) -> Value {
        let page = &self.thread_canvas;
        let Some(layout) = page.layout.as_ref() else {
            return json!({ "showing": page.showing });
        };
        let threads: Vec<Value> = layout
            .spots
            .iter()
            .map(|(id, s)| {
                let r = layout.rect(id);
                json!({
                    "id": id, "title": s.title, "area": s.area, "col": s.col, "row": s.row,
                    "ghost": s.ghost.is_some(), "moved": s.at.is_some(),
                    "x": r.map(|r| r.x), "y": r.map(|r| r.y),
                })
            })
            .collect();
        let areas: Vec<Value> = layout
            .areas
            .iter()
            .map(|(id, a)| json!({ "id": id, "title": a.title, "x": a.x, "y": a.y, "bands": a.bands }))
            .collect();
        let cam = page.camera.unwrap_or_default();
        json!({
            "showing": page.showing,
            "entered": page.entered,
            "entering": page.entering,
            "spotlight": page.spotlight,
            "camera": { "s": cam.s, "tx": cam.tx, "ty": cam.ty },
            "flying": page.flight.is_some(),
            "areas": areas,
            "threads": threads,
            "edges": layout.edges().len(),
            "strip": layout.strip(&page.entries).iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
        })
    }
}

/// A wheel turned toward you (or two fingers pulled down), which zooms out.
fn wheel_out(ev: &ScrollEvent) -> bool {
    match ev.delta {
        ScrollDelta::Lines(l) => l.y < 0.,
        ScrollDelta::Pixels(p) => f32::from(p.y) < 0.,
    }
}

/// A camera kept between the zoom limits, round the point it zoomed at.
fn clamped(cam: Camera, at: (f32, f32)) -> Camera {
    let s = cam.s.clamp(MIN_ZOOM, MAX_ZOOM);
    if s == cam.s {
        return cam;
    }
    cam.zoom_at(at, s / cam.s)
}

fn window_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: hsla(0., 0., 0., 0.45),
        offset: point(gpui_kit::px(0.), gpui_kit::px(12.)),
        blur_radius: gpui_kit::px(36.),
        spread_radius: gpui_kit::px(0.),
        inset: false,
    }]
}

fn dot(size: f32) -> Div {
    div()
        .flex_none()
        .size(gpui_kit::px(size))
        .rounded_full()
        .bg(rgb(AMBER))
}

/// A thread window's title bar, at the camera's scale: its mark, title, the
/// amber dot while it's waiting on Mike, share and more.
fn header(cam: &Camera, title: &str, waiting: bool, ghost: bool, k: f32, look: Look) -> Div {
    let s = cam.s * k;
    let z = |v: f32| gpui_kit::px(v * s);
    let text_on = 16. * s >= SMALLEST_TEXT;
    h_flex()
        .flex_none()
        .h(z(if ghost { GHOST_H } else { HEADER_H }))
        .pl(z(22.))
        .pr(z(16.))
        .gap(z(10.))
        .items_center()
        .when(!ghost, |d| d.border_b_1().border_color(look.line))
        .child(
            crate::icons::symbol("bubble.left")
                .with_size(z(18.))
                .text_color(look.muted),
        )
        .child(if text_on {
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(z(16.))
                .font_weight(if ghost {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::SEMIBOLD
                })
                .text_color(if ghost { look.muted } else { look.text })
                .child(title.to_owned())
        } else {
            div()
                .flex_1()
                .h(z(8.))
                .max_w(z(360.))
                .rounded(z(4.))
                .bg(look.muted.opacity(0.5))
        })
        .when(waiting && !ghost, |d| d.child(dot(9. * s)))
        .when(!ghost, |d| {
            d.child(
                h_flex()
                    .gap(z(16.))
                    .text_color(look.muted)
                    .child(crate::icons::symbol("square.and.arrow.up").with_size(z(17.)))
                    .child(crate::icons::symbol("ellipsis").with_size(z(17.))),
            )
        })
}

/// Some words at the camera's scale, or grey lines where they'd be too small
/// to read.
fn words(text: &str, size: f32, s: f32, colour: Hsla, lines: usize, weight: FontWeight) -> Div {
    if size * s >= SMALLEST_TEXT {
        let clipped: String = text.chars().take(600).collect();
        return div()
            .text_size(gpui_kit::px(size * s))
            .line_height(gpui_kit::px(size * 1.5 * s))
            .font_weight(weight)
            .text_color(colour)
            .line_clamp(lines)
            .child(clipped);
    }
    let n = (text.chars().count() / 60).clamp(1, lines);
    v_flex()
        .gap(gpui_kit::px(size * 0.5 * s))
        .children((0..n).map(|i| {
            div()
                .h(gpui_kit::px(size * 0.55 * s))
                .w(relative(if i + 1 == n && n > 1 { 0.6 } else { 0.95 }))
                .rounded(gpui_kit::px(size * 0.3 * s))
                .bg(colour.opacity(0.35))
        }))
}

/// A miniature of a thread's window, drawn from its summary.
fn miniature(
    p: &Placed,
    cam: &Camera,
    t: Option<&threadbear_core::inbox::ThreadSummary>,
    title: &str,
    waiting: bool,
    look: Look,
) -> AnyElement {
    let screen = cam.rect(&p.rect);
    let s = cam.s * p.scale;
    let z = |v: f32| gpui_kit::px(v * s);
    let ghostly = p.ghost || p.collapse > 0.;
    let pill = p.collapse >= 0.98;
    let mut win = v_flex()
        .absolute()
        .left(gpui_kit::px(screen.x))
        .top(gpui_kit::px(screen.y))
        .w(gpui_kit::px(screen.w))
        .h(gpui_kit::px(screen.h))
        .rounded(z(lerp(12., 32., p.collapse)))
        .bg(if ghostly {
            if look.dark {
                rgb(0x222222).into()
            } else {
                rgb(0xF1F1F3).into()
            }
        } else {
            look.window
        })
        .border_1()
        .border_color(if ghostly {
            if look.dark {
                rgb(0x333333).into()
            } else {
                look.window_edge
            }
        } else {
            look.window_edge
        })
        .overflow_hidden()
        .opacity(p.alpha)
        .cursor_pointer()
        .when(!ghostly, |d| d.shadow(window_shadow()));
    win = win.child(header(cam, title, waiting, pill, p.scale, look));
    if pill {
        return win.into_any_element();
    }
    let Some(t) = t else {
        return win.into_any_element();
    };
    let fade = 1. - p.collapse;
    let mut col = v_flex()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .px(z(28.))
        .py(z(22.))
        .gap(z(16.))
        .opacity(fade);
    if let Some(asked) = t.asked.as_deref().filter(|a| !a.trim().is_empty()) {
        col = col.child(
            h_flex().justify_end().child(
                div()
                    .max_w(relative(0.82))
                    .bg(look.bubble)
                    .rounded(z(18.))
                    .px(z(18.))
                    .py(z(12.))
                    .child(words(asked, 15., s, look.text, 6, FontWeight::NORMAL)),
            ),
        );
    }
    let running = t.status == "running";
    if running || !t.preview.trim().is_empty() {
        col = col.child(
            h_flex()
                .gap(z(8.))
                .items_center()
                .child(
                    crate::icons::symbol("hammer")
                        .with_size(z(15.))
                        .text_color(look.muted),
                )
                .child(words(
                    if running { "Working" } else { "Worked" },
                    14.,
                    s,
                    look.muted,
                    1,
                    FontWeight::NORMAL,
                )),
        );
    }
    if !t.preview.trim().is_empty() {
        col = col.child(words(&t.preview, 15., s, look.text, 14, FontWeight::NORMAL));
    }
    if let Some(q) = t
        .asks
        .as_ref()
        .and_then(|a| a.first())
        .map(|a| a.action.clone())
        .filter(|q| !q.trim().is_empty())
    {
        col = col.child(words(&q, 15., s, look.text, 4, FontWeight::SEMIBOLD));
    }
    win = win.child(col);
    // The message box's look.
    let mode = if t.permission_mode == "ask" {
        "Ask before edits"
    } else {
        "Full access"
    };
    let model = t
        .model_in_use
        .clone()
        .or_else(|| t.model.clone())
        .unwrap_or_default();
    let row_text = format!("{}  {}", model, mode);
    win = win.child(
        div()
            .flex_none()
            .px(z(28.))
            .pt(z(10.))
            .pb(z(22.))
            .opacity(fade)
            .child(
                v_flex()
                    .rounded(z(22.))
                    .border_1()
                    .border_color(look.composer_edge)
                    .bg(look.composer)
                    .pl(z(20.))
                    .pr(z(16.))
                    .pt(z(14.))
                    .pb(z(10.))
                    .gap(z(8.))
                    .child(div().h(z(44.)).child(words(
                        "Message",
                        15.,
                        s,
                        look.muted,
                        1,
                        FontWeight::NORMAL,
                    )))
                    .child(
                        h_flex()
                            .items_center()
                            .gap(z(14.))
                            .child(div().flex_1().min_w_0().child(words(
                                &row_text,
                                14.,
                                s,
                                look.muted,
                                1,
                                FontWeight::NORMAL,
                            )))
                            .child(div().flex_none().size(z(32.)).rounded_full().bg(
                                if look.dark {
                                    rgb(0xE9E9E9)
                                } else {
                                    rgb(0x2A2A2E)
                                },
                            )),
                    ),
            ),
    );
    win.into_any_element()
}

/// The grid of dots behind the board, moving and zooming with it.
fn paint_dots(cam: &Camera, colour: Hsla, bounds: Bounds<Pixels>, window: &mut Window) {
    let mut step = 40.;
    while step * cam.s < 18. {
        step *= 2.;
    }
    while step * cam.s > 36. {
        step /= 2.;
    }
    let gap = step * cam.s;
    let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    let (x0, y0) = (cam.tx.rem_euclid(gap), cam.ty.rem_euclid(gap));
    let size = 2.;
    let mut y = y0;
    while y < h {
        let mut x = x0;
        while x < w {
            window.paint_quad(
                fill(
                    Bounds {
                        origin: point(
                            bounds.origin.x + gpui_kit::px(x - size / 2.),
                            bounds.origin.y + gpui_kit::px(y - size / 2.),
                        ),
                        size: size_of(size),
                    },
                    colour,
                )
                .corner_radii(gpui_kit::px(size / 2.)),
            );
            x += gap;
        }
        y += gap;
    }
}

fn size_of(n: f32) -> Size<Pixels> {
    Size {
        width: gpui_kit::px(n),
        height: gpui_kit::px(n),
    }
}

/// The arrows on screen: each curve, its arrowhead, and a dot where it leaves.
fn paint_arrows(pens: &[(Curve, f32, Hsla)], origin: Point<Pixels>, window: &mut Window) {
    let at = |p: (f32, f32)| point(origin.x + gpui_kit::px(p.0), origin.y + gpui_kit::px(p.1));
    for (c, width, colour) in pens {
        let width = width.max(0.6);
        let mut path = PathBuilder::stroke(gpui_kit::px(width));
        path.move_to(at(c.start));
        path.cubic_bezier_to(at(c.end), at(c.c1), at(c.c2));
        if let Ok(path) = path.build() {
            window.paint_path(path, *colour);
        }
        // The head: two strokes back from the end, along the curve's last
        // direction (from the second control to the end).
        let (dx, dy) = (c.end.0 - c.c2.0, c.end.1 - c.c2.1);
        let len = (dx * dx + dy * dy).sqrt().max(0.001);
        let (ux, uy) = (dx / len, dy / len);
        let head = width * 4.5;
        for side in [-1., 1.] {
            let back = (
                c.end.0 - ux * head - uy * head * 0.6 * side,
                c.end.1 - uy * head + ux * head * 0.6 * side,
            );
            let mut h = PathBuilder::stroke(gpui_kit::px(width));
            h.move_to(at(back));
            h.line_to(at(c.end));
            if let Ok(h) = h.build() {
                window.paint_path(h, *colour);
            }
        }
        let r = width * 2.3;
        window.paint_quad(
            fill(
                Bounds {
                    origin: at((c.start.0 - r, c.start.1 - r)),
                    size: size_of(r * 2.),
                },
                *colour,
            )
            .corner_radii(gpui_kit::px(r)),
        );
    }
}
