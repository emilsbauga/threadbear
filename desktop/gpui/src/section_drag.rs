// Drag-to-reorder for the Threads sidebar's section headings (Option A: fold
// open sections on pickup + live-sliding headings):
// - A short click on a heading folds or unfolds it as before.
// - Dragging past DRAG_THRESHOLD folds open sections temporarily into a
//   compact stack with counts, lifts a floating heading pill under the
//   pointer, and slides the remaining headings live via RowMotion to open a
//   dashed landing slot.
// - Dropping commits the new section order, saves it in desktop-settings.json,
//   and unfolds the previously-open sections in their new order.
// - Escape or losing window focus cancels the drag and restores everything.
use crate::app::Threadbear;
use crate::now_ms;
use crate::sidebar::{icon, Palette};
use crate::style::{self, px};
use gpui_kit::component::{h_flex, ActiveTheme as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};
use threadbear_core::section_drag::{SlotTracker, DRAG_THRESHOLD};

/// A left mouse press on a sidebar heading before it crosses DRAG_THRESHOLD.
struct PendingPress {
    key: &'static str,
    title: &'static str,
    symbol: &'static str,
    count: usize,
    start: Point<Pixels>,
}

/// An active drag of a sidebar section heading.
struct ActiveDrag {
    key: &'static str,
    title: &'static str,
    symbol: &'static str,
    count: usize,
    tracker: SlotTracker,
    /// Full section order before pickup, restored if cancelled.
    original_order: Vec<&'static str>,
    /// Visible sections that were open before pickup and temporarily folded.
    temporarily_folded: Vec<&'static str>,
    /// Scroll offset before pickup, restored on cancel or no-op drop.
    saved_scroll_y: Pixels,
    start: Point<Pixels>,
    pointer: Point<Pixels>,
    grab_offset_y: f32,
    pill_left: f32,
    pill_width: f32,
    started_at: Instant,
}

/// State for section heading drags, owned by `SidebarState`.
#[derive(Default)]
pub(crate) struct SectionDragState {
    press: Option<PendingPress>,
    active: Option<ActiveDrag>,
    /// App-wide Escape interceptor active only while a section drag runs.
    escape_watch: Option<Subscription>,
    /// Suppresses the trailing `on_click` right after a drag ends so dropping
    /// a heading never toggles its fold.
    suppress_click: bool,
    /// Window bounds of the sidebar scroll viewport (top of slot 0 at scroll 0).
    list_viewport: Rc<Cell<Bounds<Pixels>>>,
    /// Measured height of a sidebar section heading in window points.
    heading_height: Rc<Cell<f32>>,
    /// Measured window bounds of each sidebar heading, by section key.
    heading_bounds: Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>,
}

impl SectionDragState {
    pub(crate) fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn dragged_key(&self) -> Option<&'static str> {
        self.active.as_ref().map(|d| d.key)
    }

    /// Live preview order while dragging, or None when idle.
    pub(crate) fn preview_order(&self) -> Option<Vec<&'static str>> {
        self.active
            .as_ref()
            .map(|d| d.tracker.preview_order(&d.original_order))
    }

    /// Whether a drag is currently in flight (keeps auto-update restarts away).
    pub(crate) fn under_way(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|d| d.started_at.elapsed() < Duration::from_secs(30))
    }

    /// Consumes the click-suppression flag set when a drag just ended.
    pub(crate) fn take_suppressed_click(&mut self) -> bool {
        std::mem::take(&mut self.suppress_click)
    }

    /// Marker placed on the sidebar's scroll container to note where slot 0
    /// sits in window coordinates.
    pub(crate) fn viewport_marker(&self) -> impl IntoElement {
        let viewport = self.list_viewport.clone();
        canvas(move |bounds, _, _| viewport.set(bounds), |_, _, _, _| {})
            .absolute()
            .top_0()
            .left_0()
            .size_full()
    }

    /// Marker placed on each draggable section heading to record its bounds
    /// and zoomed height for pickup alignment and compact slot geometry.
    pub(crate) fn heading_marker(&self, key: &'static str) -> impl IntoElement {
        let bounds_map = self.heading_bounds.clone();
        let height = self.heading_height.clone();
        canvas(
            move |bounds, _, _| {
                let h = f32::from(bounds.size.height);
                if h > 1. {
                    height.set(h);
                }
                bounds_map.borrow_mut().insert(key, bounds);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    fn slot_geometry(&self) -> (f32, f32) {
        let stack_top = f32::from(self.list_viewport.get().origin.y);
        let h = self.heading_height.get();
        let slot_h = if h > 1. { h } else { f32::from(px(40.)) };
        (stack_top, slot_h)
    }
}

impl Threadbear {
    /// Notes a left mouse press on a draggable sidebar heading.
    pub(crate) fn section_heading_pressed(
        &mut self,
        key: &'static str,
        title: &'static str,
        symbol: &'static str,
        count: usize,
        at: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let searching = !self.search.read(cx).value().trim().is_empty();
        if searching || self.sidebar.section_drag.active.is_some() {
            return;
        }
        self.sidebar.section_drag.suppress_click = false;
        self.sidebar.section_drag.press = Some(PendingPress {
            key,
            title,
            symbol,
            count,
            start: at,
        });
    }

    /// Capture-phase mouse move while the left button is held. Returns `true`
    /// while a section drag owns the pointer.
    fn section_drag_moved(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        if let Some(active) = self.sidebar.section_drag.active.as_mut() {
            active.pointer = at;
            let pill_h = f32::from(px(32.));
            let pill_center_y = f32::from(at.y) - active.grab_offset_y + pill_h * 0.5;
            let (stack_top, slot_h) = {
                let viewport = self.sidebar.section_drag.list_viewport.get();
                let h = self.sidebar.section_drag.heading_height.get();
                (
                    f32::from(viewport.origin.y),
                    if h > 1. { h } else { f32::from(px(40.)) },
                )
            };
            if let Some(active) = self.sidebar.section_drag.active.as_mut() {
                active.tracker.move_to(pill_center_y, stack_top, slot_h);
            }
            cx.notify();
            return true;
        }
        let Some(press) = self.sidebar.section_drag.press.as_ref() else {
            return false;
        };
        let dx = f32::from(at.x - press.start.x);
        let dy = f32::from(at.y - press.start.y);
        if dx.hypot(dy) < DRAG_THRESHOLD {
            return false;
        }
        let Some(press) = self.sidebar.section_drag.press.take() else {
            return false;
        };
        self.begin_section_drag(press, at, cx)
    }

    fn begin_section_drag(
        &mut self,
        press: PendingPress,
        at: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.search.read(cx).value().trim().is_empty() {
            return false;
        }
        let now = now_ms();
        let sections = self.shown_sections(cx, now);
        let visible: Vec<&'static str> = sections
            .iter()
            .filter(|s| !s.rows.is_empty() || s.key == "inbox")
            .map(|s| s.key)
            .collect();
        if visible.len() <= 1 || !visible.contains(&press.key) {
            return false;
        }
        let temporarily_folded: Vec<&'static str> = visible
            .iter()
            .copied()
            .filter(|k| !self.folded.contains(k))
            .collect();
        let saved_scroll_y = self.sidebar.scroll.offset().y;
        let scroll_offset = self.sidebar.scroll.offset();
        if scroll_offset.y < gpui_kit::px(0.) {
            self.sidebar
                .scroll
                .set_offset(point(scroll_offset.x, gpui_kit::px(0.)));
        }
        let (stack_top, slot_h) = self.sidebar.section_drag.slot_geometry();
        let pill_h = f32::from(px(32.));
        let bounds = self
            .sidebar
            .section_drag
            .heading_bounds
            .borrow()
            .get(press.key)
            .copied()
            .unwrap_or_else(|| {
                let vp = self.sidebar.section_drag.list_viewport.get();
                Bounds::new(
                    point(vp.origin.x + px(8.), press.start.y - px(20.)),
                    size(vp.size.width - px(16.), gpui_kit::px(slot_h)),
                )
            });
        let visual_top =
            f32::from(bounds.origin.y) + (f32::from(bounds.size.height) - pill_h).max(0.);
        let grab_offset_y =
            (f32::from(press.start.y) - visual_top).clamp(pill_h * 0.2, pill_h * 0.8);
        let start_center_y = f32::from(press.start.y) - grab_offset_y + pill_h * 0.5;
        let mut tracker = SlotTracker::new(press.key, visible, start_center_y, stack_top, slot_h);
        let cur_center_y = f32::from(at.y) - grab_offset_y + pill_h * 0.5;
        tracker.move_to(cur_center_y, stack_top, slot_h);
        let pill_left = f32::from(bounds.origin.x) + f32::from(px(6.));
        let pill_width = (f32::from(bounds.size.width) - f32::from(px(12.))).max(160.);
        self.sidebar.section_drag.active = Some(ActiveDrag {
            key: press.key,
            title: press.title,
            symbol: press.symbol,
            count: press.count,
            tracker,
            original_order: self.sidebar.section_order.clone(),
            temporarily_folded: temporarily_folded.clone(),
            saved_scroll_y,
            start: press.start,
            pointer: at,
            grab_offset_y,
            pill_left,
            pill_width,
            started_at: Instant::now(),
        });
        let app = cx.entity().downgrade();
        self.sidebar.section_drag.escape_watch =
            Some(cx.intercept_keystrokes(move |event, _, cx| {
                if event.keystroke.key == "escape"
                    && app
                        .update(cx, |this, cx| this.cancel_section_drag(cx))
                        .unwrap_or(false)
                {
                    cx.stop_propagation();
                }
            }));
        if !cx.reduce_motion() {
            for k in temporarily_folded {
                self.start_fold(k, false, cx);
            }
        }
        cx.notify();
        true
    }

    /// Capture-phase mouse up for the left button. Commits the reorder if a
    /// drag was active (returning `true` to stop propagation), else lets the
    /// click fold/unfold as usual.
    fn section_drag_released(&mut self, cx: &mut Context<Self>) -> bool {
        self.sidebar.section_drag.press = None;
        self.sidebar.section_drag.escape_watch = None;
        let Some(active) = self.sidebar.section_drag.active.take() else {
            return false;
        };
        let new_order = active.tracker.preview_order(&active.original_order);
        let changed = new_order != self.sidebar.section_order;
        if changed {
            self.sidebar.section_order = new_order;
            self.sidebar_settings_changed(cx);
        } else {
            let offset = self.sidebar.scroll.offset();
            self.sidebar
                .scroll
                .set_offset(point(offset.x, active.saved_scroll_y));
        }
        if !cx.reduce_motion() {
            for k in active.temporarily_folded {
                self.start_fold(k, true, cx);
            }
        }
        self.sidebar.section_drag.suppress_click = true;
        cx.notify();
        true
    }

    /// Cancels an active section drag (Escape or window focus lost), restoring
    /// the original order, scroll position, and open sections.
    pub(crate) fn cancel_section_drag(&mut self, cx: &mut Context<Self>) -> bool {
        self.sidebar.section_drag.press = None;
        self.sidebar.section_drag.escape_watch = None;
        let Some(active) = self.sidebar.section_drag.active.take() else {
            return false;
        };
        let offset = self.sidebar.scroll.offset();
        self.sidebar
            .scroll
            .set_offset(point(offset.x, active.saved_scroll_y));
        if !cx.reduce_motion() {
            for k in active.temporarily_folded {
                self.start_fold(k, true, cx);
            }
        }
        self.sidebar.section_drag.suppress_click = true;
        cx.notify();
        true
    }

    /// Capture-phase window mouse watch for section heading drags, placed
    /// beside `row_press_watch` in `shell.rs`.
    pub(crate) fn section_drag_watch(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let app = cx.entity().downgrade();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let (moved, released) = (app.clone(), app);
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                    if phase != DispatchPhase::Capture {
                        return;
                    }
                    if event.pressed_button != Some(MouseButton::Left) {
                        // A release outside the window can arrive only as a
                        // move with no button held: finish cleanly.
                        let active = moved
                            .read_with(cx, |t, _| {
                                t.sidebar.section_drag.active.is_some()
                                    || t.sidebar.section_drag.press.is_some()
                            })
                            .unwrap_or(false);
                        if active {
                            moved
                                .update(cx, |this, cx| {
                                    this.section_drag_released(cx);
                                })
                                .ok();
                        }
                        return;
                    }
                    if moved
                        .update(cx, |this, cx| this.section_drag_moved(event.position, cx))
                        .unwrap_or(false)
                    {
                        cx.stop_propagation();
                    }
                });
                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                        let handled = released
                            .update(cx, |this, cx| this.section_drag_released(cx))
                            .unwrap_or(false);
                        if handled {
                            cx.stop_propagation();
                        }
                    }
                });
            },
        )
        .absolute()
        .size_0()
    }

    /// The dashed target slot rendered in the sidebar list where the dragged
    /// section will land. Exact same total height (40pt) as a heading so
    /// neighbouring sections never shift vertically on swap.
    pub(crate) fn render_section_drag_slot(&self, p: &Palette) -> AnyElement {
        div()
            .w_full()
            .pt(px(10.))
            .px(px(6.))
            .child(
                div()
                    .h(px(30.))
                    .w_full()
                    .rounded(px(7.))
                    .border_1()
                    .border_dashed()
                    .border_color(p.accent.opacity(0.55))
                    .bg(p.accent.opacity(0.09)),
            )
            .into_any_element()
    }

    /// Full-window overlay drawn while a section heading is being dragged:
    /// holds the closed-hand cursor across the window and floats the lifted
    /// heading pill under the pointer.
    pub(crate) fn render_section_drag_overlay(&self, cx: &App) -> Option<AnyElement> {
        let active = self.sidebar.section_drag.active.as_ref()?;
        let p = crate::sidebar::palette(cx);
        let bg = cx.theme().background;
        let lift = style::primary_opacity(cx, 0.08);
        let border = style::primary_opacity(cx, 0.16);
        let dx = (f32::from(active.pointer.x - active.start.x) * 0.22).clamp(-24., 24.);
        let pill_x = active.pill_left + dx;
        let pill_y = f32::from(active.pointer.y) - active.grab_offset_y;
        let count_text = (active.count > 0).then(|| active.count.to_string());
        let pill = h_flex()
            .absolute()
            .left(gpui_kit::px(pill_x))
            .top(gpui_kit::px(pill_y))
            .w(gpui_kit::px(active.pill_width))
            .h(px(32.))
            .px(px(11.))
            .gap(px(7.))
            .items_center()
            .rounded(px(8.))
            .bg(bg)
            .border_1()
            .border_color(border)
            .shadow_lg()
            .child(div().absolute().inset_0().rounded(px(7.)).bg(lift))
            .child(icon(active.symbol, 11., p.accent).flex_none())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(style::size::SIDEBAR_HEADING))
                    .font_semibold()
                    .text_color(p.fg)
                    .child(active.title),
            )
            .when_some(count_text, |s, count| {
                s.child(
                    div()
                        .flex_none()
                        .text_size(px(style::size::SIDEBAR_META))
                        .text_color(p.secondary)
                        .child(count),
                )
            });
        Some(
            deferred(
                div()
                    .absolute()
                    .inset_0()
                    .cursor(CursorStyle::ClosedHand)
                    .child(pill),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }
}

/// `section-drag`: drags a sidebar section heading through real GPUI pointer
/// events (`{"from": "Running", "to": "Inbox"}` or `"index": 0`), with
/// optional `"drop": false` (pause mid-drag for inspection/screenshots),
/// `"cancel": true` (press Escape mid-drag), or `"finish": true` (release an
/// already-active drag).
#[cfg(feature = "automation")]
pub(crate) async fn section_drag_command(
    app: &WeakEntity<Threadbear>,
    window: AnyWindowHandle,
    cmd: &serde_json::Value,
    cx: &mut AsyncApp,
) -> Result<serde_json::Value, String> {
    use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
    let app = app.upgrade().ok_or("the app has gone")?;
    let reduce = cx.update(|cx| cx.reduce_motion());
    let fold_wait = Duration::from_millis(if reduce { 20 } else { 250 });

    // Finish or cancel an already-active drag (after a `drop: false` call).
    if cmd["finish"].as_bool() == Some(true) {
        let pointer = app
            .read_with(cx, |t, _| {
                t.sidebar.section_drag.active.as_ref().map(|a| a.pointer)
            })
            .ok_or("no section drag active")?;
        cx.update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.pointer_up(pointer, MouseButton::Left, cx);
                window.render_frame(cx);
            });
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor().timer(fold_wait).await;
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!("ok finished"));
    }
    if cmd["from"].is_null() && cmd["cancel"].as_bool() == Some(true) {
        cx.update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.press("escape", cx);
                window.render_frame(cx);
            });
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor().timer(fold_wait).await;
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!("ok cancelled"));
    }

    let from_raw = cmd["from"]
        .as_str()
        .ok_or("from must name a sidebar section")?;
    let from_key = threadbear_core::section_drag::section_key_by_name(from_raw)
        .ok_or_else(|| format!("unknown section {from_raw:?}"))?;

    cx.update_window(window, |_, window, cx| window.render_frame(cx))
        .map_err(|e| e.to_string())?;

    let (mut from_bounds, visible) = app.read_with(cx, |t, cx| {
        let bounds = t
            .sidebar
            .section_drag
            .heading_bounds
            .borrow()
            .get(from_key)
            .copied();
        let visible: Vec<&'static str> = t
            .shown_sections(cx, now_ms())
            .iter()
            .filter(|s| !s.rows.is_empty() || s.key == "inbox")
            .map(|s| s.key)
            .collect();
        (bounds, visible)
    });
    if let Some(bounds) = from_bounds {
        let (scroll, viewport) = app.read_with(cx, |t, _| {
            (
                t.sidebar.scroll.clone(),
                t.sidebar.section_drag.list_viewport.get(),
            )
        });
        if bounds.origin.y < viewport.origin.y || bounds.bottom() > viewport.bottom() {
            cx.update_window(window, |_, window, cx| {
                if crate::settings_window::scroll_to(&scroll, bounds) {
                    window.refresh();
                    window.render_frame(cx);
                }
            })
            .map_err(|e| e.to_string())?;
            from_bounds = app.read_with(cx, |t, _| {
                t.sidebar
                    .section_drag
                    .heading_bounds
                    .borrow()
                    .get(from_key)
                    .copied()
            });
        }
    }
    let from_center = from_bounds
        .map(|b| b.center())
        .ok_or_else(|| format!("heading {from_key:?} isn't on screen"))?;

    let target_idx = if let Some(to_raw) = cmd["to"].as_str() {
        let to_key = threadbear_core::section_drag::section_key_by_name(to_raw)
            .ok_or_else(|| format!("unknown target section {to_raw:?}"))?;
        visible
            .iter()
            .position(|k| *k == to_key)
            .ok_or_else(|| format!("target section {to_key:?} isn't visible"))?
    } else if let Some(idx) = cmd["index"].as_u64() {
        (idx as usize).min(visible.len().saturating_sub(1))
    } else {
        return Err("specify `to` (section name) or `index`".into());
    };

    let from_idx = visible
        .iter()
        .position(|k| *k == from_key)
        .ok_or_else(|| format!("heading {from_key:?} isn't visible"))?;

    // Press and cross the drag threshold in the direction of the target.
    let pickup_dy = if target_idx > from_idx {
        DRAG_THRESHOLD + 4.
    } else {
        -(DRAG_THRESHOLD + 4.)
    };
    let pickup = point(from_center.x, from_center.y + gpui_kit::px(pickup_dy));
    cx.update_window(window, |_, window, cx| {
        crate::thread::scripted_input(|| {
            window.pointer_move(from_center, None, cx);
            window.pointer_down(from_center, MouseButton::Left, cx);
            window.pointer_move(pickup, Some(MouseButton::Left), cx);
            window.render_frame(cx);
        });
    })
    .map_err(|e| e.to_string())?;

    cx.background_executor().timer(fold_wait).await;
    cx.update_window(window, |_, window, cx| window.render_frame(cx))
        .map_err(|e| e.to_string())?;

    let (stack_top, slot_h, grab_offset_y) = app.read_with(cx, |t, _| {
        let (top, h) = t.sidebar.section_drag.slot_geometry();
        let grab = t
            .sidebar
            .section_drag
            .active
            .as_ref()
            .map_or(f32::from(px(16.)), |a| a.grab_offset_y);
        (top, h, grab)
    });
    let pill_h = f32::from(px(32.));
    let desired_center_y = stack_top + (target_idx as f32 + 0.5) * slot_h;
    let target_y = desired_center_y + grab_offset_y - pill_h * 0.5;
    let to_point = point(from_center.x, gpui_kit::px(target_y));

    // When dragging downward after a short section above collapsed, dip past
    // DOWNWARD_ENGAGE first if `to_point` alone wouldn't cross it, then settle
    // on `to_point`.
    let mut waypoints = Vec::new();
    let engage_y = f32::from(from_center.y) + threadbear_core::section_drag::DOWNWARD_ENGAGE + 4.;
    if target_idx > from_idx && target_y < engage_y {
        waypoints.push(point(from_center.x, gpui_kit::px(engage_y)));
    }
    waypoints.push(to_point);

    let mut cur = pickup;
    let steps = 8;
    for wp in waypoints {
        for step in 1..=steps {
            let t = step as f32 / steps as f32;
            let at = point(cur.x + (wp.x - cur.x) * t, cur.y + (wp.y - cur.y) * t);
            cx.update_window(window, |_, window, cx| {
                crate::thread::scripted_input(|| {
                    window.pointer_move(at, Some(MouseButton::Left), cx);
                    window.render_frame(cx);
                });
            })
            .map_err(|e| e.to_string())?;
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
        }
        cur = wp;
    }

    if cmd["cancel"].as_bool() == Some(true) {
        cx.update_window(window, |_, window, cx| {
            crate::thread::scripted_input(|| {
                window.press("escape", cx);
                window.render_frame(cx);
            });
        })
        .map_err(|e| e.to_string())?;
        cx.background_executor().timer(fold_wait).await;
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!("ok cancelled"));
    }

    if cmd["drop"].as_bool() == Some(false) {
        cx.background_executor()
            .timer(Duration::from_millis(if reduce { 16 } else { 200 }))
            .await;
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .map_err(|e| e.to_string())?;
        return Ok(serde_json::json!(format!(
            "ok dragging {from_key} to {target_idx}"
        )));
    }

    cx.update_window(window, |_, window, cx| {
        crate::thread::scripted_input(|| {
            window.pointer_up(to_point, MouseButton::Left, cx);
            window.render_frame(cx);
        });
    })
    .map_err(|e| e.to_string())?;
    cx.background_executor().timer(fold_wait).await;
    cx.update_window(window, |_, window, cx| window.render_frame(cx))
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!(format!(
        "ok moved {from_key} to {target_idx}"
    )))
}
