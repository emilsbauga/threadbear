// The band under the stage: a tab for each option with its tick (and one for
// all of them side by side), then the words of the one on show at the
// thread's reading size, with one reply box, None and Send beside them; once
// it's over, what was sent. Mike, 20 Nov 2026: the words were small and grey
// in a column down the right, so he went into the window for the pictures and
// back to the thread to read. He tried them as a page beside the thread, then
// picked this on 21 Nov.
use super::ReviewWindow;
use crate::spinner::Spinner;
use crate::style::{self, px};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Paste, Textarea};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::ops::Range;
use threadbear_core::open_policy::Origin;
use threadbear_core::reducer::ReviewOption;
use threadbear_core::review::{self as rules, ReviewMode};

const PAD: f32 = 22.;
/// A tab's small picture of its option.
const TAB_THUMB: (f32, f32) = (50., 31.);
/// The words at their widest: about a reply's in the thread.
const WORDS_WIDTH: f32 = 800.;
/// The words at their tallest, eight lines, before they scroll: the stage
/// keeps the rest of the window.
const WORDS_HEIGHT: f32 = 190.;
/// The answer's column: three tenths of the window, between these.
const ANSWER_WIDTH: (f32, f32) = (280., 420.);

impl ReviewWindow {
    pub(super) fn render_band(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Of the window, not zoomed, as its frame isn't.
        let width = f32::from(window.viewport_size().width);
        let on_canvas = self.on_canvas();
        // On the board the words are on the canvas, so the reply has room
        // for the chips of Mike's marks.
        let answer = if on_canvas {
            (width * 0.5).clamp(ANSWER_WIDTH.1, 720.)
        } else {
            (width * 0.3).clamp(ANSWER_WIDTH.0, ANSWER_WIDTH.1)
        };
        let words = if on_canvas {
            self.render_tour(cx)
        } else {
            self.render_words(cx)
        };
        v_flex()
            .id("review-band")
            .flex_none()
            .w_full()
            .bg(style::primary_opacity(cx, 0.025))
            .child(self.render_tabs(cx))
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap(px(32.))
                    .px(px(PAD))
                    .pt(px(12.))
                    .pb(px(18.))
                    .child(words)
                    .child(
                        div()
                            .flex_none()
                            .w(gpui_kit::px(answer))
                            .child(self.render_footer(window, cx)),
                    ),
            )
            .into_any_element()
    }

    /// All of them, then each option, scrolling sideways when there are
    /// too many; at the row's end, the ways to try the one on show.
    fn render_tabs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let all = self.session.mode == ReviewMode::All;
        let options = self.session.review().options.clone();
        let color = if all {
            style::label_text(cx)
        } else {
            style::secondary_text(cx)
        };
        let all_tab = crate::highlights::tipped(
            h_flex()
                .id("review-grid")
                .flex_none()
                .h(px(40.))
                .px(px(12.))
                .gap(px(8.))
                .items_center()
                .rounded(px(9.))
                .cursor_pointer()
                .when(all, |s| s.bg(style::primary_opacity(cx, 0.07)))
                .text_size(px(style::size::WORK))
                .font_weight(FontWeight::MEDIUM)
                .text_color(color),
            "See them all and choose (Esc)",
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.show_all(cx)))
        .child(
            Icon::new(IconName::LayoutGrid)
                .with_size(px(13.))
                .text_color(color),
        )
        .child(format!("All {}", options.len()));
        let mut tabs = h_flex()
            .id("review-tabs")
            .flex_1()
            .min_w_0()
            .gap(px(6.))
            .items_center()
            .overflow_x_scroll()
            .track_scroll(&self.tabs_scroll)
            .child(all_tab);
        for (index, option) in options.iter().enumerate() {
            tabs = tabs.child(self.render_tab(index, option, cx));
        }
        h_flex()
            .flex_none()
            .w_full()
            .px(px(14.))
            .pt(px(10.))
            .gap(px(10.))
            .items_center()
            .child(tabs)
            .children(self.render_tries(cx))
            .into_any_element()
    }

    /// One option's tab: its tick, then its small picture and name, which
    /// show it on the stage; the agent's pick has its star.
    fn render_tab(
        &mut self,
        index: usize,
        option: &ReviewOption,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let picked = self.session.draft().picked_ids.contains(&option.id);
        let current = if self.on_canvas() {
            self.canvas_option() == Some(index)
        } else {
            self.session.mode == ReviewMode::Single && self.session.focused() == index
        };
        let recommended = self.session.review().recommended.as_deref() == Some(option.id.as_str());
        let primary = style::label_text(cx);
        let show = crate::highlights::tipped(
            h_flex()
                .id(("review-tab", index))
                .min_w_0()
                .gap(px(9.))
                .items_center()
                .cursor_pointer(),
            rules::shot_tip(option, 0),
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            if !current {
                this.enlarge(index, 0, cx);
            }
        }))
        .child(
            div()
                .relative()
                .flex_none()
                .child(
                    super::parts::thumb(&option.image, TAB_THUMB.0, TAB_THUMB.1, 4., cx)
                        .opacity(if current { 1. } else { 0.7 }),
                )
                .when(current, |s| {
                    s.child(
                        div()
                            .absolute()
                            .top(px(-2.))
                            .left(px(-2.))
                            .w(px(TAB_THUMB.0 + 4.))
                            .h(px(TAB_THUMB.1 + 4.))
                            .rounded(px(5.))
                            .border(px(1.5))
                            .border_color(primary),
                    )
                }),
        )
        .child(
            div()
                .max_w(px(220.))
                .truncate()
                .text_size(px(style::size::WORK))
                .line_height(px(style::natural_line(style::size::WORK)))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if current {
                    primary
                } else {
                    style::secondary_text(cx)
                })
                .child(option.label()),
        )
        .when(recommended, |s| {
            s.child(
                crate::icons::symbol("star.fill")
                    .with_size(px(11.))
                    .text_color(style::recommended_star(cx)),
            )
        });
        let bg = if current {
            style::primary_opacity(cx, 0.07)
        } else if picked {
            style::control_accent(cx).opacity(0.08)
        } else {
            gpui_kit::transparent_black()
        };
        h_flex()
            .flex_none()
            .h(px(40.))
            .pl(px(10.))
            .pr(px(12.))
            .gap(px(9.))
            .items_center()
            .rounded(px(9.))
            .bg(bg)
            .children(self.render_pick_mark(option, picked, cx))
            .child(show)
            .into_any_element()
    }

    /// The option on show: its name, the agent's pick marked, which shot
    /// this is, and its reasons at the thread's reading size, right under
    /// what they describe. With all of them side by side, the agent's lead.
    fn render_words(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let body = |id: ElementId, source: &str, this: &Self, cx: &App| {
            div()
                .text_size(px(style::size::BODY))
                .line_height(px(style::size::BODY_LINE))
                .child(inline_note(
                    id,
                    source,
                    style::label_text(cx),
                    &this.cwd,
                    cx,
                ))
        };
        let mut words = v_flex().w_full().max_w(px(WORDS_WIDTH)).gap(px(4.));
        let index = self.session.focused();
        let shown = self
            .session
            .review()
            .options
            .get(index)
            .filter(|_| self.session.mode == ReviewMode::Single)
            .cloned();
        if let Some(option) = shown {
            let recommended =
                self.session.review().recommended.as_deref() == Some(option.id.as_str());
            let place = self
                .session
                .shown_shot()
                .map(|shot| rules::caption_where(&option, &shot))
                .unwrap_or_default();
            words = words.child(
                h_flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x(px(10.))
                    .child(
                        div()
                            .text_size(px(style::size::HEADER + 2.))
                            .line_height(px(style::natural_line(style::size::HEADER + 2.)))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(option.label()),
                    )
                    .when(recommended, |s| s.child(super::parts::recommended_mark(cx)))
                    .when(!place.is_empty(), |s| {
                        s.child(
                            div()
                                .text_size(px(style::size::WORK))
                                .line_height(px(style::natural_line(style::size::WORK)))
                                .text_color(style::secondary_text(cx))
                                .child(place),
                        )
                    }),
            );
            if let Some(reason) = option.note.clone().filter(|n| !n.is_empty()) {
                words = words.child(body(("review-words", index).into(), &reason, self, cx));
            }
            // A note on one option is from before the one reply box, or a
            // client that still sends them: shown, as it'll go with the reply.
            let note = self
                .session
                .shown_draft()
                .notes
                .get(&option.id)
                .cloned()
                .unwrap_or_default();
            if !note.is_empty() {
                words = words.child(
                    div()
                        .text_size(px(style::size::WORK))
                        .line_height(px(style::natural_line(style::size::WORK)))
                        .text_color(style::secondary_text(cx))
                        .child(note),
                );
            }
        } else if let Some(note) = self.session.review().note.clone().filter(|n| !n.is_empty()) {
            // As markdown in the text colour: drawn raw in grey it was one long
            // wall where backticks showed and nothing stood out (Mike, 7 Nov).
            words = words.child(body("review-note".into(), &note, self, cx));
        }
        div()
            .id("review-words")
            .flex_1()
            .min_w_0()
            .max_h(px(WORDS_HEIGHT))
            .overflow_y_scroll()
            .child(words)
            .into_any_element()
    }

    /// A tick, as several can be picked. A reference has none, nor has a
    /// sent review's unpicked option.
    fn render_pick_mark(
        &mut self,
        option: &ReviewOption,
        picked: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let accent = style::control_accent(cx);
        let slot = div()
            .flex_none()
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center();
        if self.session.editable() && !option.reference {
            let id = option.id.clone();
            let tip = if picked {
                format!("Unpick {}", option.id)
            } else {
                format!("Pick {}", option.id)
            };
            return Some(
                crate::highlights::tipped(
                    slot.id(SharedString::from(format!("review-pick-{}", option.id)))
                        .cursor_pointer(),
                    tip,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.pick(&id, cx)))
                .child(super::parts::checkbox(picked, accent, cx))
                .into_any_element(),
            );
        }
        picked.then(|| {
            slot.child(super::parts::checkbox(true, accent, cx))
                .into_any_element()
        })
    }

    // The answer.

    fn render_footer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.session.review().is_pending() {
            return self.render_sent(cx);
        }
        let none = self.session.draft().none;
        let editable = self.session.editable();
        // Not while a picture in the reply is still on its way in.
        let can_send = self.session.can_submit() && !self.reply_loading(cx);
        let submitting = self.session.submitting();
        let active = window.is_window_active();
        let focused = self.reply.read(cx).focus_handle(cx).is_focused(window);
        let accent = style::control_accent(cx);
        let dark = cx.theme().is_dark();
        // Grows with what's typed, from 60 to the 8 lines its box takes (the
        // stage gives up the room); a
        // click anywhere in it puts the cursor in it. The edge is drawn inside
        // its 6 of padding, as the Swift box's strokeBorder is.
        let reply = self.reply.clone();
        let (me, token_owner, paste_owner, click_owner) = (
            cx.entity().downgrade(),
            cx.entity().downgrade(),
            cx.entity().downgrade(),
            cx.entity().downgrade(),
        );
        let token_state = self.reply.clone();
        let reply_bounds = self.reply_box.clone();
        let reply_box = div()
            .id("review-reply")
            .relative()
            .w_full()
            .min_h(px(68.))
            .p(px(5.))
            .rounded(px(10.))
            .bg(hsla(0., 0., 0., if dark { 0.2 } else { 0.03 }))
            .border_1()
            .border_color(if focused { accent } else { style::hairline(cx) })
            .cursor_text()
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                let handle = reply.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
                crate::web_panels::keyboard_to_app(window);
                // Or the window's own focus, after this, took the keys back:
                // a click under the first line, past the text box's frame,
                // left no cursor and no blue edge (Mike, 23 Nov).
                window.prevent_default();
            })
            // A picture dropped on it goes in as a chip, as one pasted does.
            .on_drop(move |paths: &ExternalPaths, window, cx| {
                let paths =
                    crate::composer_media::read(true).unwrap_or_else(|| paths.paths().to_vec());
                if let Some(me) = me.upgrade() {
                    me.update(cx, |this, cx| this.take_reply_paths(paths, window, cx));
                }
            })
            // HEIC and file promises, which GPUI's own clipboard leaves out,
            // from the Mac's pasteboard first, as the thread's box does.
            .capture_action(cx.listener(|this, _: &Paste, window, cx| {
                if this.session.editable()
                    && this.reply.read(cx).focus_handle(cx).is_focused(window)
                {
                    if let Some(paths) = crate::composer_media::read(false) {
                        this.take_reply_paths(paths, window, cx);
                        cx.stop_propagation();
                    }
                }
            }))
            .child(
                canvas(
                    move |bounds, _, _| reply_bounds.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .child(
                crate::composer::bare_textarea(Textarea::new(&self.reply))
                    .token(move |ctx, _, cx| match token_owner.upgrade() {
                        Some(this) => {
                            this.read(cx)
                                .reply_pictures
                                .render(ctx, token_state.read(cx), cx)
                        }
                        None => div().into_any_element(),
                    })
                    .on_paste(move |item, window, cx| {
                        paste_owner.upgrade().is_some_and(|this| {
                            this.update(cx, |this, cx| {
                                this.take_reply_clipboard(Some(item), window, cx)
                            })
                        })
                    })
                    // A plain click on a picture's chip opens it full size
                    // (a drag from it or a Shift-click selects, as in the
                    // thread's box).
                    .on_token_click(move |event, window, cx| {
                        if let Some(this) = click_owner.upgrade() {
                            this.update(cx, |this, cx| {
                                let id = event.token().id();
                                match this.reply_chip_mark(id) {
                                    Some(n) => this.canvas_show_mark(n, cx),
                                    None => this.open_reply_picture(id, window, cx),
                                }
                            });
                        }
                    })
                    .w_full()
                    .text_size(px(style::size::WORK))
                    .line_height(px(style::natural_line(style::size::WORK))),
            );
        // None: tinted while it's chosen, as the Swift button's tint is.
        let none_tip = if none {
            "Take back none of them"
        } else {
            "None of them will do"
        };
        let none_fill = if none && active {
            accent.opacity(0.25)
        } else {
            style::primary_opacity(cx, 0.08)
        };
        let none_button = crate::highlights::tipped(
            h_flex()
                .id("review-none")
                .flex_none()
                .px(px(14.))
                .h(px(30.))
                .rounded_full()
                .bg(none_fill)
                .justify_center()
                .items_center()
                .text_size(px(style::size::LABEL))
                .text_color(if none && active {
                    accent
                } else {
                    style::label_text(cx)
                })
                .when(editable, |s| s.cursor_pointer())
                .when(!editable, |s| s.opacity(0.5)),
            none_tip,
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_none(cx)))
        .child(div().pt(px(1.)).child("None of them"));
        // Send says what will go, and while it goes says so with a spinner and
        // takes no more presses. Grey in a window that isn't in front, as a
        // Mac's own default button is.
        let (send_fill, send_text) = if can_send && active {
            (accent, gpui_kit::white())
        } else if can_send || submitting {
            (style::primary_opacity(cx, 0.08), style::label_text(cx))
        } else {
            (style::primary_opacity(cx, 0.04), style::tertiary_label(cx))
        };
        let send = crate::highlights::tipped(
            h_flex()
                .id("review-send")
                .flex_1()
                .min_w_0()
                .h(px(30.))
                .rounded_full()
                .bg(send_fill)
                .justify_center()
                .items_center()
                .gap(px(6.))
                .text_size(px(style::size::LABEL))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(send_text)
                .when(can_send, |s| s.cursor_pointer())
                .when(submitting, |s| s.child(Spinner::new().color(send_text).with_size(px(12.)))),
            "Send your picks and reply to the agent (\u{2318}\u{21A9}). Close the window to finish it later.",
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.submit(cx)))
        .child(div().pt(px(1.)).min_w_0().truncate().child(self.session.send_label()));
        v_flex()
            .w_full()
            .gap(px(10.))
            .child(reply_box)
            .child(h_flex().w_full().gap(px(8.)).child(none_button).child(send))
            .into_any_element()
    }

    /// What went, once it's over: None of them, the reply as written, and
    /// whether it was sent, cancelled or answered in the thread, with Done.
    fn render_sent(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let sent = self.session.shown_draft().clone();
        let status = rules::status_text(self.session.review());
        let mut column = v_flex()
            .w_full()
            .gap(px(10.))
            .text_size(px(style::size::WORK))
            .line_height(px(style::natural_line(style::size::WORK)));
        if sent.none {
            column = column.child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("None of them"),
            );
        }
        if let Some(reply) = sent.reply.filter(|r| !r.is_empty()) {
            // As tall as it needs up to the reply box's most, then it scrolls,
            // so a long one leaves room for the options and keeps Done on screen.
            column = column.child(
                div()
                    .id("review-sent-reply")
                    .w_full()
                    .max_h(px(220.))
                    .overflow_y_scroll()
                    .child(reply),
            );
        }
        // The pictures that went with it, small.
        if !sent.images.is_empty() {
            let edge = style::hairline(cx);
            column = column.child(h_flex().flex_wrap().gap(px(6.)).children(
                sent.images.iter().map(|image| {
                    img(crate::rows::markdown::file_picture(&image.path))
                        .size(px(48.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(edge)
                        .object_fit(ObjectFit::Cover)
                }),
            ));
        }
        column
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(style::size::DETAIL))
                            .text_color(style::secondary_text(cx))
                            .child(status),
                    )
                    .child(
                        super::plain_button("review-done", "Done", "Close it", false, cx)
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close(cx))),
                    ),
            )
            .into_any_element()
    }
}

/// An agent's note as SwiftUI draws inline markdown: bold, italic, code in
/// the mono face and links in the link colour, on the lines of what it's
/// in, so it takes the line heights of where it's put.
/// (The kit's markdown view keeps line heights of its own and boxes inline
/// code.) A link opens through the open gate.
pub(crate) fn inline_note(
    id: impl Into<ElementId>,
    source: &str,
    color: Hsla,
    cwd: &str,
    cx: &App,
) -> AnyElement {
    let (base, mono, link_color) = (
        cx.theme().font_family.clone(),
        cx.theme().mono_font_family.clone(),
        style::link_text(cx),
    );
    let mut text = String::new();
    let mut runs: Vec<TextRun> = vec![];
    let mut links: Vec<(Range<usize>, std::sync::Arc<str>)> = vec![];
    for run in rules::inline_markdown(source) {
        let start = text.len();
        text.push_str(&run.text);
        let mut face = font(if run.code { mono.clone() } else { base.clone() });
        if run.bold {
            face.weight = FontWeight::BOLD;
        }
        if run.italic {
            face.style = FontStyle::Italic;
        }
        runs.push(TextRun {
            len: run.text.len(),
            font: face,
            color: if run.link.is_some() {
                link_color
            } else {
                color
            },
            background_color: None,
            underline: None,
            strikethrough: None,
        });
        if let Some(url) = run.link {
            links.push((start..text.len(), url));
        }
    }
    let styled = StyledText::new(text).with_runs(runs);
    if links.is_empty() {
        return styled.into_any_element();
    }
    // The addresses as the parser shares them, one copy a link.
    let (ranges, urls): (Vec<Range<usize>>, Vec<std::sync::Arc<str>>) = links.into_iter().unzip();
    let cwd = cwd.to_owned();
    InteractiveText::new(id, styled)
        .on_click(ranges, move |ix, _, cx| {
            crate::open_gate::open_link(&urls[ix], Origin::ThisMac, &cwd, cx)
        })
        .into_any_element()
}
