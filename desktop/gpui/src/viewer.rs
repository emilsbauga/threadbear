// A viewer for pictures in the transcript, the in-app replacement for Quick
// Look on Windows and Linux (and the Mac, for now): click a tile for an
// overlay with arrows through that message's pictures, Escape closes
// (docs/gpui-port/mac-only-parts.md, "Quick Look").
//
// The security rule carries over from the Swift app's `quickLooks` (Codex review,
// 7 Nov): only a real, decodable picture is ever shown, and never handed to
// its default app, so a `.command` posing as an image can't run. The image
// is decoded from the bytes here, not opened by the system.
use crate::a11y::A11yRole as _;
use crate::highlights::{icon, SidePane};
use crate::style;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
// Shadows gpui's px, so sizes here follow the app's zoom (style.rs).
use crate::style::px;
use serde_json::{json, Value};
use std::sync::Arc;
use threadbear_core::folders::picture_size;
use threadbear_core::highlights::{looks_like_picture, runs_code};
use threadbear_core::reducer::ImageRef;

/// One picture of the message the viewer is on.
struct Shown {
    path: String,
    /// Its bytes once they've been read.
    image: Option<Arc<Image>>,
    size: Option<(u32, u32)>,
    /// Read and found wanting (refused, cut short, not a picture): it says
    /// "Couldn't show", not "Loading…" for ever (Codex, 18 Nov).
    failed: bool,
}

/// What's open in the viewer.
pub(crate) struct ViewerState {
    pictures: Vec<Shown>,
    index: usize,
    open: bool,
    /// Counts the openings, so a read that lands after the viewer has moved
    /// on (closed, opened on another message or another Mac's same path)
    /// is dropped, not put in the wrong picture's place (Codex, 18 Nov).
    opening: u64,
    /// Another Mac's thread: its pictures are that Mac's, asked of it through
    /// this runner (`files.read` with its `runnerId`), never read here.
    runner: Option<String>,
    /// Holds the keys while it's up: Escape and the arrows.
    focus: FocusHandle,
}

impl ViewerState {
    pub(crate) fn new(cx: &mut App) -> Self {
        Self {
            pictures: vec![],
            index: 0,
            open: false,
            opening: 0,
            runner: None,
            focus: cx.focus_handle(),
        }
    }
}

impl ViewerState {
    /// Up over the window: a video or PDF view in the pane hides under it
    /// (media_view.rs), as it would be drawn over it.
    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    fn current_path(&self) -> Option<&str> {
        self.pictures.get(self.index).map(|p| p.path.as_str())
    }

    /// For scripts: "" while it's closed, else "<n> of <total> <path>", with
    /// " (loading)" until the picture's drawn, " (couldn't show)" if it won't be.
    #[cfg(feature = "automation")]
    pub(crate) fn describe(&self) -> String {
        if !self.open {
            return String::new();
        }
        format!(
            "{} of {} {}{}",
            self.index + 1,
            self.pictures.len(),
            self.current_path().unwrap_or(""),
            self.state_words()
        )
    }

    #[cfg(feature = "automation")]
    fn state_words(&self) -> &'static str {
        match self.pictures.get(self.index) {
            Some(p) if p.image.is_some() => "",
            Some(p) if p.failed => " (couldn't show)",
            _ => " (loading)",
        }
    }
}

/// A handle the transcript's rows use to open the viewer. One per window:
/// the tiles are drawn by the thread pane, the viewer by the side pane.
#[derive(Clone)]
pub(crate) struct ViewerHandle(pub WeakEntity<SidePane>);
impl Global for ViewerHandle {}

/// Whether a tile can open in the viewer at all (`quickLooks`): named like a
/// picture, and not something whose default app runs code.
fn opens_here(path: &str) -> bool {
    looks_like_picture(path) && !runs_code(path)
}

/// The same for another Mac's picture, which also may be one that Mac hasn't
/// put up yet (a `threadbear-relay:` place, remote_pictures.rs): the viewer
/// asks for it and says if it couldn't be got. Its bytes are decoded here,
/// never handed to an app, as this Mac's are.
fn opens_from(path: &str, remote: bool) -> bool {
    opens_here(path) || (remote && crate::remote_pictures::not_up_yet(path))
}

/// A click on a tile or a picture's chip in a message: the viewer on that
/// picture, stepping through the message's other real pictures. `runner`
/// is the thread's when it's another Mac's (Mike, 18 Nov: its pictures
/// showed, but a click on one opened nothing).
pub(crate) fn open_from_tile(
    images: &[ImageRef],
    index: usize,
    runner: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(handle) = cx.try_global::<ViewerHandle>().cloned() else {
        return;
    };
    let paths: Vec<String> = images
        .iter()
        .map(|i| i.path.clone())
        .filter(|p| opens_from(p, runner.is_some()))
        .collect();
    let Some(chosen) = images
        .get(index)
        .map(|i| i.path.clone())
        .filter(|p| paths.contains(p))
    else {
        return;
    };
    let runner = runner.map(str::to_owned);
    handle
        .0
        .update(cx, |pane, cx| {
            open_on(pane, paths, &chosen, runner, window, cx)
        })
        .ok();
}

/// A click on a picture in the message box (its chip among the words or its
/// thumbnail over them): the viewer on `chosen`, stepping through the box's
/// other real pictures, as a transcript tile's does. Says what it shows (the
/// paths and the place of `chosen` among them), or None when `chosen` isn't
/// one that opens here.
///
/// The opening waits for the click's turn to end: the click comes from inside
/// the composer's update, and the side pane can read the composer and the app
/// back while it opens, which would be a double lease.
pub(crate) fn open_from_composer(
    paths: Vec<String>,
    chosen: &str,
    window: &mut Window,
    cx: &mut App,
) -> Option<(Vec<String>, usize)> {
    cx.try_global::<ViewerHandle>()?;
    let shown: Vec<String> = paths.into_iter().filter(|p| opens_here(p)).collect();
    let index = shown.iter().position(|p| p == chosen)?;
    let (paths, chosen) = (shown.clone(), chosen.to_owned());
    window.defer(cx, move |window, cx| {
        let Some(handle) = cx.try_global::<ViewerHandle>().cloned() else {
            return;
        };
        handle
            .0
            .update(cx, |pane, cx| pane.open_viewer(paths, &chosen, window, cx))
            .ok();
    });
    Some((shown, index))
}

/// A window that shows the viewer over itself: the main window's side pane,
/// and the design review window, whose reply's picture chips open it (Mike,
/// 17 Nov). Its state, and the runner to read pictures through.
pub(crate) trait HostsViewer: Sized + 'static {
    fn viewer_state(&mut self) -> &mut ViewerState;
    fn viewer_client(&self) -> Arc<threadbear_client::runner::Client>;
}

impl HostsViewer for SidePane {
    fn viewer_state(&mut self) -> &mut ViewerState {
        &mut self.viewer
    }
    fn viewer_client(&self) -> Arc<threadbear_client::runner::Client> {
        self.client.clone()
    }
}

impl SidePane {
    pub(crate) fn open_viewer(
        &mut self,
        paths: Vec<String>,
        chosen: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        open(self, paths, chosen, window, cx);
    }

    pub(crate) fn close_viewer(&mut self, cx: &mut Context<Self>) {
        close(self, cx);
    }

    pub(crate) fn viewer_step(&mut self, delta: i64, cx: &mut Context<Self>) {
        step(self, delta, cx);
    }

    /// The overlay, drawn over the whole window while it's open.
    pub(crate) fn viewer_overlay(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        overlay(self, window, cx)
    }
}

/// The viewer on `chosen`, stepping through `paths`, in `host`'s window.
/// Only paths named like pictures that don't run code (`opens_here`).
pub(crate) fn open<T: HostsViewer>(
    host: &mut T,
    paths: Vec<String>,
    chosen: &str,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    open_on(host, paths, chosen, None, window, cx);
}

/// `open`, for pictures on `runner` when it's another Mac.
fn open_on<T: HostsViewer>(
    host: &mut T,
    paths: Vec<String>,
    chosen: &str,
    runner: Option<String>,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| opens_from(p, runner.is_some()))
        .collect();
    let Some(index) = paths.iter().position(|p| p == chosen) else {
        return;
    };
    let viewer = host.viewer_state();
    viewer.pictures = paths
        .into_iter()
        .map(|path| Shown {
            path,
            image: None,
            size: None,
            failed: false,
        })
        .collect();
    viewer.index = index;
    viewer.open = true;
    viewer.opening += 1;
    viewer.runner = runner;
    // The overlay holds the keys: Escape closes, the arrows step.
    let focus = viewer.focus.clone();
    window.focus(&focus, cx);
    crate::web_panels::keyboard_to_app(window);
    read_picture(host, index, cx);
    cx.notify();
}

pub(crate) fn close<T: HostsViewer>(host: &mut T, cx: &mut Context<T>) {
    host.viewer_state().open = false;
    cx.notify();
}

pub(crate) fn step<T: HostsViewer>(host: &mut T, delta: i64, cx: &mut Context<T>) {
    let viewer = host.viewer_state();
    let count = viewer.pictures.len() as i64;
    if !viewer.open || count == 0 {
        return;
    }
    let next = (viewer.index as i64 + delta).rem_euclid(count) as usize;
    viewer.index = next;
    read_picture(host, next, cx);
    cx.notify();
}

/// Reads the picture through the runner, and another Mac's through it from
/// that Mac. Anything that doesn't decode just shows "Couldn't show this
/// picture": the bytes are never handed to another app.
fn read_picture<T: HostsViewer>(host: &mut T, index: usize, cx: &mut Context<T>) {
    let viewer = host.viewer_state();
    let (runner, opening) = (viewer.runner.clone(), viewer.opening);
    let Some(shown) = viewer.pictures.get_mut(index) else {
        return;
    };
    if shown.image.is_some() || shown.failed {
        return;
    }
    // Another Mac's picture its tile has drawn: the same bytes, not asked again.
    if let Some(drawn) = runner
        .as_deref()
        .and_then(|runner| crate::remote_pictures::ready(runner, &shown.path, cx))
    {
        shown.size = picture_size(drawn.bytes());
        shown.image = Some(drawn);
        return;
    }
    let path = shown.path.clone();
    let params = match &runner {
        Some(runner) => {
            json!({ "path": path, "runnerId": runner, "maxBytes": crate::remote_pictures::MAX_BYTES })
        }
        None => json!({ "path": path }),
    };
    let client = host.viewer_client();
    cx.spawn(async move |this, cx| {
        let res = crate::call(client, "files.read", params).await;
        // Only its start, from another Mac, won't draw.
        let read = res
            .ok()
            .as_ref()
            .and_then(threadbear_core::folders::FileRead::decode)
            .filter(|read| runner.is_none() || !read.truncated);
        // Shrunk to what the GPU can draw (fit_picture.rs), off this thread.
        let path2 = path.clone();
        let picture = cx
            .background_executor()
            .spawn(async move {
                read.and_then(|read| {
                    format_of(&path2, &read.data)
                        .and_then(|format| crate::fit_picture::fit_bytes(format, read.data))
                })
            })
            .await;
        this.update(cx, |t, cx| {
            let viewer = t.viewer_state();
            // Only into the opening that asked for it.
            if viewer.opening != opening {
                return;
            }
            let Some(slot) = viewer.pictures.iter_mut().find(|p| p.path == path) else {
                return;
            };
            match picture {
                Some((format, data)) => {
                    slot.size = picture_size(&data);
                    slot.image = Some(Arc::new(Image::from_bytes(format, data)));
                }
                None => slot.failed = true,
            }
            cx.notify();
        })
        .ok();
    })
    .detach();
}

/// The overlay, drawn over the whole of `host`'s window while it's open.
pub(crate) fn overlay<T: HostsViewer>(
    host: &mut T,
    window: &mut Window,
    cx: &mut Context<T>,
) -> Option<AnyElement> {
    let viewer = host.viewer_state();
    if !viewer.open {
        return None;
    }
    let bounds = window.viewport_size();
    let (index, total) = (viewer.index, viewer.pictures.len());
    let current = viewer.pictures.get(index)?;
    let (path, image) = (current.path.clone(), current.image.clone());
    // A picture only reads once; "Couldn't" after that means it failed.
    let loading = !current.failed;
    let focus = viewer.focus.clone();
    let name = threadbear_core::highlights::last_component(&path).to_owned();
    let backdrop = gpui_kit::hsla(0., 0., 0., 0.82);
    let fg = gpui_kit::hsla(0., 0., 1., 0.92);
    let dim = gpui_kit::hsla(0., 0., 1., 0.55);
    let body: AnyElement = match image {
        // With an id, so a GIF plays (files.rs, the pane's picture).
        Some(image) => img(ImageSource::Image(image))
            .id(SharedString::from(format!("viewer-picture-{index}")))
            .max_w(bounds.width - px(120.))
            .max_h(bounds.height - px(120.))
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
        None => div()
            .text_size(px(style::size::LABEL))
            .text_color(dim)
            .child(if loading {
                "Loading…".to_owned()
            } else {
                format!("Couldn't show {name}")
            })
            .into_any_element(),
    };
    let arrow = |id: &'static str,
                 symbol: &'static str,
                 delta: i64,
                 tip: &'static str,
                 cx: &mut Context<T>| {
        crate::highlights::tipped(
            div()
                .id(id)
                .size(px(44.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(gpui_kit::hsla(0., 0., 1., 0.1))
                .hover(|s| s.bg(gpui_kit::hsla(0., 0., 1., 0.2)))
                .cursor_pointer()
                .child(icon(symbol, 18., fg)),
            tip,
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            // Not the backdrop's click, which closes it.
            cx.stop_propagation();
            step(this, delta, cx);
        }))
        .into_any_element()
    };
    let many = total > 1;
    let prev = many.then(|| arrow("viewer-prev", "chevron.left", -1, "Previous picture", cx));
    let next = many.then(|| arrow("viewer-next", "chevron.right", 1, "Next picture", cx));
    let close_button = crate::highlights::tipped(
        div()
            .id("viewer-close")
            .size(px(32.))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(gpui_kit::hsla(0., 0., 1., 0.12))
            .hover(|s| s.bg(gpui_kit::hsla(0., 0., 1., 0.24)))
            .cursor_pointer()
            .child(icon("xmark", 14., fg)),
        "Close",
    )
    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| close(this, cx)));
    let caption = if total > 1 {
        format!("{name}  ·  {} of {total}", index + 1)
    } else {
        name
    };
    let overlay = div()
        .id("picture-viewer")
        .a11y_role(Role::GenericContainer)
        .track_focus(&focus)
        .w(bounds.width)
        .h(bounds.height)
        .bg(backdrop)
        .flex()
        .items_center()
        .justify_center()
        .occlude()
        .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
            match ev.keystroke.key.as_str() {
                "escape" => close(this, cx),
                "left" => step(this, -1, cx),
                "right" => step(this, 1, cx),
                _ => return,
            }
            // Not the window's own keys under it (the review window steps
            // its stage with the arrows).
            cx.stop_propagation();
        }))
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| close(this, cx)))
        .child(
            h_flex()
                .size_full()
                .items_center()
                .justify_between()
                .px(px(16.))
                .child(div().w(px(44.)).when_some(prev, |s, b| s.child(b)))
                // Clicks on the picture itself don't close it.
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .id("viewer-body")
                                .a11y_role(Role::GenericContainer)
                                .on_click(|_, _, cx| cx.stop_propagation())
                                .child(body),
                        )
                        .child(
                            div()
                                .text_size(px(style::size::DETAIL))
                                .text_color(dim)
                                .child(caption),
                        ),
                )
                .child(div().w(px(44.)).when_some(next, |s, b| s.child(b))),
        )
        .child(
            div()
                .absolute()
                .top(px(16.))
                .right(px(16.))
                .child(close_button),
        );
    Some(
        deferred(anchored().position(point(px(0.), px(0.))).child(overlay))
            .with_priority(2)
            .into_any_element(),
    )
}

/// The image format from its bytes, so a mislabelled file still decodes as
/// what it really is, and a non-picture is refused.
pub(crate) fn format_of(path: &str, bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG") {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF8") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.starts_with(b"BM") {
        return Some(ImageFormat::Bmp);
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some(ImageFormat::Tiff);
    }
    // An SVG is text, and only ever drawn, never run.
    (path.to_lowercase().ends_with(".svg")
        && String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).contains("<svg"))
    .then_some(ImageFormat::Svg)
}

/// `viewer` for scripts: says what's open, and `step`, `close`, `open` act.
#[cfg(feature = "automation")]
pub(crate) fn viewer_command(
    side: &Entity<SidePane>,
    cmd: &Value,
    cx: &mut App,
) -> Result<Value, String> {
    if let Some(delta) = cmd["step"].as_i64() {
        side.update(cx, |pane, cx| pane.viewer_step(delta, cx));
    }
    if cmd["close"].as_bool() == Some(true) {
        side.update(cx, |pane, cx| pane.close_viewer(cx));
    }
    let pane = side.read(cx);
    let viewer = &pane.viewer;
    if !viewer.open {
        return Ok(json!("ok closed"));
    }
    Ok(json!(format!(
        "ok showing {} of {} {}{}",
        viewer.index + 1,
        viewer.pictures.len(),
        viewer.current_path().unwrap_or(""),
        viewer.state_words()
    )))
}

/// The thread's action chips, for the thread pane to draw over the composer
/// (the chips live with the patches, patches.rs).
pub(crate) fn action_chips(
    thread: &threadbear_core::inbox::ThreadSummary,
    room: f32,
    project_icons: &std::collections::HashMap<String, crate::sidebar::ProjectIcon>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if !SidePane::has_action_chips(thread) {
        return None;
    }
    let handle = cx.try_global::<ViewerHandle>()?.clone();
    let entity = handle.0.upgrade()?;
    entity.update(cx, |pane, cx| {
        pane.render_action_chips(thread, room, project_icons, window, cx)
    })
}

/// The tile's tooltip words on a transcript row (`transcript.images`), and on
/// the message box's thumbnails.
pub(crate) const TILE_TIP: &str = "Open the picture";

pub(crate) fn viewer_handle_global(entity: WeakEntity<SidePane>, cx: &mut App) {
    cx.set_global(ViewerHandle(entity));
}

/// Value only used by the automation build.
#[cfg(not(feature = "automation"))]
#[allow(
    dead_code,
    reason = "keeps `Value` used in builds without the automation"
)]
fn _unused(_: &Value) {}
