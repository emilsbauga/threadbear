// The # thread picker over the message box: type # at the start of a word and
// the other threads are listed, latest first, narrowed by what's typed after
// it (threadbear_core::thread_mentions). Up and Down move, Return, Tab or a
// click puts the thread in as its chip (the link `[title](thread:<id>)`, as a
// pasted id goes in), and Esc closes it. It only shows while something
// matches, so a # in other words ("issue #12") doesn't get in the way, and
// the slash palette goes first. Drawn as the slash palette's layer is
// (slash_palette.rs), with the keys reaching it from the box the same way.
use crate::composer::Composer;
use crate::style::{self, size};
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// Shadows gpui's px, so sizes here follow the app's zoom (style.rs).
use crate::style::px;
#[cfg(feature = "automation")]
use serde_json::{json, Value};
use std::sync::Arc;
use threadbear_core::inbox::{folder_name, ThreadSummary};
use threadbear_core::inline_chips::draft_pieces;
use threadbear_core::slash::PaletteKey;
use threadbear_core::thread_mentions::{self as mentions, Typed};

impl Composer {
    /// The "#word" before the cursor and the threads it matches, while the
    /// picker is open: not with a selection, not once Esc closed it at this
    /// text, and not with nothing to list.
    fn thread_picker_open(&self, cx: &App) -> Option<(Typed, Vec<Arc<ThreadSummary>>)> {
        let state = self.input.read(cx);
        if !state.selected_range().is_empty() {
            return None;
        }
        let text = state.value();
        if self.thread_picker.closed_at.as_deref() == Some(text.as_ref()) {
            return None;
        }
        let typed = mentions::typed(&text, state.cursor())?;
        let app = self.app.upgrade()?;
        let all: Vec<Arc<ThreadSummary>> = app.read(cx).threads.values().cloned().collect();
        let found = mentions::matches(&all, &typed.query, self.thread_id.as_deref());
        (!found.is_empty()).then_some((typed, found))
    }

    /// Esc closed the picker at that text only: any change reopens it. And
    /// the arrows' pick goes once the picker closes.
    pub(crate) fn thread_picker_text_changed(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value();
        if self
            .thread_picker
            .closed_at
            .as_deref()
            .is_some_and(|c| c != text.as_ref())
        {
            self.thread_picker.closed_at = None;
        }
        if self.thread_picker_open(cx).is_none() {
            self.thread_picker.selected = None;
        }
    }

    /// Arrows, Tab, Return and Esc while the picker is open. False lets the
    /// box have the key as usual.
    pub(crate) fn thread_picker_key(
        &mut self,
        key: PaletteKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some((_, found)) = self.thread_picker_open(cx) else {
            return false;
        };
        let text = self.input.read(cx).value().to_string();
        if let Some(thread) = mentions::handle_key(key, &found, &mut self.thread_picker, &text) {
            self.pick_thread(&thread, window, cx);
        }
        // Keep the pick in sight as the arrows move it.
        if matches!(key, PaletteKey::Up | PaletteKey::Down) {
            if let Some(index) = found
                .iter()
                .position(|t| self.thread_picker.selected.as_deref() == Some(t.id.as_str()))
            {
                self.thread_scroll.scroll_to_item(index);
            }
        }
        cx.notify();
        true
    }

    /// Puts the thread's chip where the #word was, with a space after it to
    /// carry on typing.
    fn pick_thread(&mut self, thread: &ThreadSummary, window: &mut Window, cx: &mut Context<Self>) {
        let Some((typed, _)) = self.thread_picker_open(cx) else {
            return;
        };
        self.thread_picker = Default::default();
        let cursor = self.input.read(cx).cursor();
        self.input
            .update(cx, |s, cx| s.set_selected_range(typed.start..cursor, cx));
        self.insert_pieces(
            draft_pieces(&mentions::reference(thread), 0),
            &[],
            window,
            cx,
        );
    }

    /// The picker's layer over the box, or None while it's closed.
    pub(crate) fn render_thread_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (_, found) = self.thread_picker_open(cx)?;
        let picked = mentions::picked(&found, &self.thread_picker).map(|t| t.id.clone());
        // In points, as the slash palette works them out (slash_palette.rs).
        let zoom = style::zoom_scale();
        let window_height = f64::from(window.viewport_size().height / zoom);
        let height = mentions::height(found.len(), window_height);
        // No taller than the room over the box (the new-thread page): the
        // text sits lower, so that's never more than it has.
        let room = f64::from(self.box_top.get() / zoom) - 16.;
        let height = height.min(room.max(0.));
        let mut rows = v_flex().w_full();
        for thread in &found {
            let on = picked.as_deref() == Some(thread.id.as_str());
            rows = rows.child(self.render_thread_picker_row(thread, on, cx));
        }
        let panel = div()
            .id("thread-picker")
            .size_full()
            .rounded(px(crate::slash_resize::RADIUS))
            .overflow_hidden()
            .bg(cx.theme().background)
            .border_1()
            .border_color(style::hairline(cx))
            .shadow_lg()
            // Keep clicks out of the transcript under it.
            .occlude()
            .child(
                div()
                    .id("thread-picker-list")
                    .size_full()
                    .py(px(6.))
                    .overflow_y_scroll()
                    .track_scroll(&self.thread_scroll)
                    .child(rows),
            );
        // On the text's top edge, out to the box's sides, and as far over
        // the text as it was over the box, so with nothing over the text it
        // sits where it did, 8 over the box, and with a card or chips there
        // it covers them, next to the # (Mike, 24 Nov).
        let inset = style::COMPOSER_PADDING;
        Some(
            deferred(
                div()
                    .absolute()
                    .left(px(-inset))
                    .right(px(-inset))
                    .bottom_full()
                    .mb(px(inset + 8.))
                    .h(px(height as f32))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(panel),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    fn render_thread_picker_row(
        &mut self,
        thread: &Arc<ThreadSummary>,
        on: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let title = mentions::shown_title(thread);
        let folder = folder_name(&thread.cwd);
        let place = if thread.archived_at.is_some() {
            format!("{folder}, archived")
        } else {
            folder
        };
        let (fg, accent, hover) = (
            cx.theme().foreground,
            style::accent(cx).opacity(0.75),
            style::primary_opacity(cx, 0.05),
        );
        let text = if on { gpui_kit::white() } else { fg };
        let tip: SharedString = format!("Put a link to \"{title}\" in the message (Return)").into();
        let picked = thread.clone();
        h_flex()
            .id(SharedString::from(format!(
                "thread-picker-row-{}",
                thread.id
            )))
            .test_support()
            .role(Role::ListItem)
            .aria_label(tip.clone())
            .w_full()
            .h(px(mentions::ROW_HEIGHT as f32))
            .gap(px(10.))
            .px(px(14.))
            .cursor_pointer()
            .text_color(text)
            .when(on, |s| s.bg(accent))
            .when(!on, |s| s.hover(move |s| s.bg(hover)))
            .tip(tip)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.pick_thread(&picked, window, cx);
            }))
            .child(
                div().flex_none().opacity(0.6).child(
                    crate::icons::symbol("bubble.left")
                        .size(px(14.))
                        .text_color(text),
                ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(size::LABEL + 1.))
                            .child(title),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(size::LABEL - 1.))
                            .opacity(0.7)
                            .child(place),
                    ),
            )
    }

    /// `dump`'s # picker, while it's open.
    #[cfg(feature = "automation")]
    pub(crate) fn thread_picker_dump(&self, cx: &App) -> Value {
        let Some((typed, found)) = self.thread_picker_open(cx) else {
            return Value::Null;
        };
        let picked = mentions::picked(&found, &self.thread_picker).map(|t| t.id.clone());
        json!({
            "query": typed.query,
            "threads": found.iter().map(|t| json!({
                "id": t.id,
                "title": mentions::shown_title(t),
                "folder": folder_name(&t.cwd),
            })).collect::<Vec<_>>(),
            "picked": picked,
        })
    }
}
