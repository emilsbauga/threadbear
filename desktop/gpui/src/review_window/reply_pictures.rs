// Pictures in the reply box: a picture pasted (or dropped) there is a chip
// with its thumbnail and "Picture N", as in the thread's own box, and goes to
// the agent with the answer, placed by `[Picture N]` in the reply's words.
// Mike, 17 Nov: the box was plain text, so a pasted screenshot went in as its
// file path and the agent never saw it.
//
// The chips are the composer's (composer.rs `picture_chip`, `picture_token`),
// each copied in through the runner's `media.import` as it shows, dimmed until
// it's in. The draft only takes the box once every picture in it is in: the
// runner keeps its own copy beside the review (runner/reviews.ts
// keepReplyImages), which the box then points at.
use super::ReviewWindow;
use crate::composer::{
    is_picture, keep_picture, picture_chip, picture_token, save_pasted_image, unstage,
};
use gpui_kit::component::h_flex;
use gpui_kit::component::input::{InlineToken, InlineTokenContext, InputContent, TextareaState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use threadbear_core::composer::{self as words, PICTURE_MARK_STR};
use threadbear_core::reducer::ImageRef;

/// One chip's picture: where it came from, and the runner's copy once it's in.
/// `failed`: it couldn't be read, so its chip was taken out; one that Undo
/// puts back is left out of the reply, rather than holding Send for ever.
pub(super) struct ReplyPicture {
    source: PathBuf,
    image: Option<ImageRef>,
    failed: bool,
}

/// One of Mike's marks on the review canvas, as a chip in the reply: its
/// number, what it's on ("A · Menu open") and its cut-out once made.
pub(super) struct MarkChip {
    pub(super) n: u32,
    pub(super) label: String,
    pub(super) image: Option<String>,
}

/// The character a mark's chip stands on in the box, as a picture's stands
/// on PICTURE_MARK_STR; the draft keeps `[Mark N]`.
pub(super) const MARK_STR: &str = "\u{E000}";

pub(super) fn mark_token(id: &SharedString) -> InlineToken {
    InlineToken::new(id.clone(), MARK_STR).with_label("Mark")
}

#[derive(Default)]
pub(super) struct ReplyPictures {
    chips: HashMap<SharedString, ReplyPicture>,
    pub(super) marks: HashMap<SharedString, MarkChip>,
    next: usize,
}

impl ReplyPictures {
    fn fresh_id(&mut self) -> SharedString {
        self.next += 1;
        format!("reply-picture-{}", self.next).into()
    }

    /// The box's words and chips for a reply as the draft keeps it, its
    /// `[Picture N]` markers chips again. Any chips from before go.
    pub(super) fn content_for(
        &mut self,
        reply: &str,
        images: &[ImageRef],
        marks: Vec<MarkChip>,
    ) -> InputContent {
        self.chips.clear();
        self.marks.clear();
        // Each mark's `[Mark N]` stands on its character, in order, while the
        // pictures' markers are read.
        let mut reply = reply.to_owned();
        let mut placed_marks: Vec<(usize, MarkChip)> = Vec::new();
        for mark in marks {
            if let Some(at) = reply.find(&format!("[Mark {}]", mark.n)) {
                placed_marks.push((at, mark));
            }
        }
        placed_marks.sort_by_key(|(at, _)| *at);
        for (_, mark) in &placed_marks {
            reply = reply.replacen(&format!("[Mark {}]", mark.n), MARK_STR, 1);
        }
        let mut marks_in_order = placed_marks.into_iter().map(|(_, m)| m);
        let (text, order) = words::edit_draft(&reply, images.len());
        let mut out = String::new();
        let mut tokens = Vec::new();
        let mut placed = order.into_iter();
        for c in text.chars() {
            if c.to_string() == MARK_STR {
                let Some(mark) = marks_in_order.next() else {
                    continue;
                };
                let id = self.fresh_id();
                let start = out.len();
                out.push_str(MARK_STR);
                tokens.push((start..out.len(), mark_token(&id)));
                self.marks.insert(id, mark);
                continue;
            }
            if c.to_string() != PICTURE_MARK_STR {
                out.push(c);
                continue;
            }
            let Some(image) = placed.next().and_then(|i| images.get(i)).cloned() else {
                continue;
            };
            let id = self.fresh_id();
            let start = out.len();
            out.push_str(PICTURE_MARK_STR);
            tokens.push((start..out.len(), picture_token(&id)));
            self.chips.insert(
                id,
                ReplyPicture {
                    source: PathBuf::from(&image.path),
                    image: Some(image),
                    failed: false,
                },
            );
        }
        let mut content = InputContent::new(out);
        for (range, token) in tokens {
            content = content.clone().with_token(range, token).unwrap_or(content);
        }
        content
    }

    /// The picture chips in the box, in order (not marks).
    fn ids(&self, state: &TextareaState) -> Vec<SharedString> {
        state
            .tokens()
            .iter()
            .map(|span| span.token().id().clone())
            .filter(|id| !self.marks.contains_key(id))
            .collect()
    }

    /// The reply and its pictures as the draft keeps them, each picture's
    /// chip its `[Picture N]`, or None while a picture is still on its way in
    /// (it can't be sent without it). A chip with no picture (one that
    /// failed, put back by Undo) is left out, and so is a mark that isn't a chip.
    pub(super) fn draft_of(
        &self,
        state: &TextareaState,
    ) -> Option<(String, Vec<ImageRef>, Vec<u32>)> {
        if self.loading(state) {
            return None;
        }
        let text = state.value().to_string();
        let mut spans: Vec<_> = state
            .tokens()
            .iter()
            .map(|span| (span.range(), span.token().id().clone()))
            .collect();
        spans.sort_by_key(|(range, _)| range.start);
        let mut reply = String::with_capacity(text.len());
        let mut images = Vec::new();
        let mut marks = Vec::new();
        let mut at = 0;
        for (range, id) in spans {
            if range.start < at || range.end > text.len() {
                continue;
            }
            reply.push_str(&words::draft_words(&text[at..range.start]));
            if let Some(image) = self.chips.get(&id).and_then(|c| c.image.clone()) {
                images.push(image);
                reply.push_str(&words::picture_marker(images.len()));
            } else if let Some(mark) = self.marks.get(&id) {
                marks.push(mark.n);
                reply.push_str(&format!("[Mark {}]", mark.n));
            }
            at = range.end;
        }
        reply.push_str(&words::draft_words(&text[at..]));
        Some((reply, images, marks))
    }

    /// Whether a picture in the box is still being copied in.
    pub(super) fn loading(&self, state: &TextareaState) -> bool {
        self.ids(state).iter().any(|id| {
            self.chips
                .get(id)
                .is_some_and(|c| c.image.is_none() && !c.failed)
        })
    }

    /// Each picture chip's file, in the box's order: the runner's copy once
    /// it's in, else the one it came from.
    fn paths(&self, state: &TextareaState) -> Vec<(SharedString, String)> {
        self.ids(state)
            .into_iter()
            .filter_map(|id| {
                let chip = self.chips.get(&id)?;
                let path = chip.image.as_ref().map_or_else(
                    || chip.source.to_string_lossy().into_owned(),
                    |i| i.path.clone(),
                );
                Some((id, path))
            })
            .collect()
    }

    /// The runner's own copies, once a save has them: the same pictures in
    /// the same order, so the box points at the copies that last.
    pub(super) fn adopt(&mut self, state: &TextareaState, images: &[ImageRef]) {
        let ids: Vec<_> = self
            .ids(state)
            .into_iter()
            .filter(|id| self.chips.get(id).is_some_and(|c| c.image.is_some()))
            .collect();
        if ids.len() != images.len() {
            return;
        }
        for (id, image) in ids.iter().zip(images) {
            if let Some(chip) = self.chips.get_mut(id) {
                chip.image = Some(image.clone());
            }
        }
    }

    pub(super) fn render(
        &self,
        ctx: &InlineTokenContext,
        state: &TextareaState,
        cx: &App,
    ) -> AnyElement {
        let id = ctx.token().id();
        if let Some(mark) = self.marks.get(id) {
            return mark_chip(mark, ctx.is_selected(), cx);
        }
        let chip = self.chips.get(id);
        let number = self
            .ids(state)
            .iter()
            .position(|c| c == id)
            .map_or(1, |i| i + 1);
        let path = chip.map(|c| {
            c.image
                .as_ref()
                .map_or_else(|| c.source.clone(), |i| PathBuf::from(&i.path))
        });
        picture_chip(
            path,
            number,
            chip.is_none_or(|c| c.image.is_none()),
            ctx.is_selected(),
            cx,
        )
    }
}

impl ReviewWindow {
    /// A paste into the reply: pictures and files first, as the thread's box
    /// takes them; words paste as words. Whether it took the paste.
    pub(super) fn take_reply_clipboard(
        &mut self,
        item: Option<&ClipboardItem>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.session.editable() {
            return false;
        }
        // What GPUI's clipboard leaves out (HEIC, file promises, a picture
        // copied in a browser), read from the Mac's own pasteboard.
        if let Some(paths) = crate::composer_media::read(false) {
            self.take_reply_paths(paths, window, cx);
            return true;
        }
        let Some(item) = item else { return false };
        let mut paths = Vec::new();
        let mut images = Vec::new();
        let mut has_text = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(p) => paths.extend(p.paths().iter().cloned()),
                ClipboardEntry::Image(image) => images.push(image.clone()),
                ClipboardEntry::String(_) => has_text = true,
            }
        }
        if !paths.is_empty() {
            self.take_reply_paths(paths, window, cx);
            return true;
        }
        // Text with an image flavour (rich text from a browser) stays text.
        if has_text || images.is_empty() {
            return false;
        }
        let saved: Vec<PathBuf> = images.iter().filter_map(save_pasted_image).collect();
        if saved.is_empty() {
            return false;
        }
        self.take_reply_paths(saved, window, cx);
        true
    }

    /// Files pasted or dropped: pictures become chips where the cursor is, and
    /// anything else goes in as its path, for the agent to open where it is.
    pub(super) fn take_reply_paths(
        &mut self,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.session.editable() {
            return;
        }
        let (pictures, others): (Vec<_>, Vec<_>) = paths
            .into_iter()
            .map(keep_picture)
            .partition(|p| is_picture(p));
        let target = self.reply.clone();
        let (text, selection) = {
            let state = target.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let ids: Vec<SharedString> = pictures
            .iter()
            .map(|_| self.reply_pictures.fresh_id())
            .collect();
        let mut piece_paths = words::path_text(
            &others
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
        );
        let prev_is_space = text[..selection.start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let next_is_space = text[selection.end..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace);
        target.update(cx, |s, cx| {
            if !selection.is_empty() {
                s.replace("", window, cx);
            }
            if !prev_is_space {
                s.insert(" ", window, cx);
            }
            if !others.is_empty() {
                if !ids.is_empty() {
                    piece_paths.push(' ');
                }
                s.insert(piece_paths, window, cx);
            }
            for (i, id) in ids.iter().enumerate() {
                if i > 0 {
                    s.insert(" ", window, cx);
                }
                let _ = s.replace_with_token(picture_token(id), window, cx);
            }
            if !next_is_space {
                s.insert(" ", window, cx);
            }
            s.focus(window, cx);
            crate::web_panels::keyboard_to_app(window);
        });
        for (id, path) in ids.into_iter().zip(pictures) {
            self.reply_pictures.chips.insert(
                id.clone(),
                ReplyPicture {
                    source: path.clone(),
                    image: None,
                    failed: false,
                },
            );
            self.import_reply_picture(id, path, cx);
        }
        cx.notify();
    }

    /// Copies a chip's picture in through the runner, as the thread's box
    /// does (`import_picture`); one that can't be read comes out again.
    fn import_reply_picture(&mut self, id: SharedString, path: PathBuf, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let grace = cx.background_executor().timer(Duration::from_millis(500));
            let ready = crate::composer_media::ready(&path, grace);
            let timeout = cx.background_executor().timer(Duration::from_secs(60));
            futures::pin_mut!(ready, timeout);
            let prepared = match futures::future::select(ready, timeout).await {
                futures::future::Either::Left((result, _)) => result,
                futures::future::Either::Right(_) => {
                    Err("The picture took too long to arrive".into())
                }
            };
            let (result, staged) = match prepared {
                Ok(mut prepared) => {
                    // A legacy file promise can bring several; the first is this chip's.
                    let staged = std::mem::take(&mut prepared.paths);
                    let first = staged.first().cloned().unwrap_or_else(|| path.clone());
                    (
                        crate::call(
                            client,
                            "media.import",
                            json!({ "path": first.to_string_lossy() }),
                        )
                        .await
                        .map_err(|e| e.message),
                        staged,
                    )
                }
                Err(message) => (Err(message), Vec::new()),
            };
            // The runner keeps its own copy (or said no): a pasted picture's
            // staged file goes now, whatever happens to the chip.
            unstage(&path);
            for staged in &staged {
                unstage(staged);
            }
            this.update(cx, |this, cx| this.settle_reply_picture(id, result, cx))
                .ok();
        })
        .detach();
    }

    fn settle_reply_picture(
        &mut self,
        id: SharedString,
        result: Result<serde_json::Value, String>,
        cx: &mut Context<Self>,
    ) {
        let image = result.and_then(|v| {
            ImageRef::decode(&v["image"])
                .ok_or_else(|| "The runner's answer didn't make sense.".to_owned())
        });
        match image {
            Ok(image) => {
                if let Some(chip) = self.reply_pictures.chips.get_mut(&id) {
                    chip.image = Some(image);
                }
            }
            Err(message) => {
                if let Some(chip) = self.reply_pictures.chips.get_mut(&id) {
                    chip.failed = true;
                }
                self.pending_chip_removal.push(id);
                self.session.error = Some(format!("Couldn\u{2019}t add that picture: {message}"));
            }
        }
        // Into the draft now it's in (or gone), at the next draw, where
        // there's a window to take a chip out with.
        self.reply_changed = true;
        cx.notify();
    }

    /// The box changed, or a picture in it came in: the draft takes it, once
    /// every picture in it is in.
    pub(super) fn reply_to_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for id in std::mem::take(&mut self.pending_chip_removal) {
            let range = self
                .reply
                .read(cx)
                .tokens()
                .iter()
                .find(|span| span.token().id() == &id)
                .map(|span| span.range());
            if let Some(range) = range {
                self.reply.update(cx, |s, cx| {
                    s.set_selected_range(range, cx);
                    s.replace("", window, cx);
                });
            }
        }
        let parts = self.reply_pictures.draft_of(self.reply.read(cx));
        let Some((reply, images, marks)) = parts else {
            return;
        };
        self.reply_synced = reply.clone();
        self.pictures_synced = images.len();
        if self.session.set_reply_with_marks(&reply, images, &marks) {
            self.edited(cx);
        }
    }

    /// The mark on the canvas a chip in the reply stands for, if it's one.
    pub(super) fn reply_chip_mark(&self, id: &SharedString) -> Option<u32> {
        self.reply_pictures.marks.get(id).map(|m| m.n)
    }

    /// A plain click on a picture's chip in the reply: the picture full size
    /// over this window, stepping through the reply's others, as a chip in
    /// the thread's box opens (composer.rs `open_picture`). A mark's chip
    /// isn't a picture: the band shows the mark on the canvas instead.
    pub(super) fn open_reply_picture(
        &mut self,
        id: &SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let paths = self.reply_pictures.paths(self.reply.read(cx));
        let Some(chosen) = paths
            .iter()
            .find(|(chip, _)| chip == id)
            .map(|(_, path)| path.clone())
        else {
            return;
        };
        crate::viewer::open(
            self,
            paths.into_iter().map(|(_, path)| path).collect(),
            &chosen,
            window,
            cx,
        );
    }

    pub(super) fn reply_loading(&self, cx: &App) -> bool {
        self.reply_pictures.loading(self.reply.read(cx))
    }
}

/// A mark's chip: its number in Mike's blue, its cut-out once made, and what
/// it's on.
fn mark_chip(mark: &MarkChip, selected: bool, cx: &App) -> AnyElement {
    let blue: Hsla = rgb(0x6CB8FF).into();
    h_flex()
        .h_full()
        .items_center()
        .child(
            h_flex()
                .h(px(crate::style::size::CHIP_HEIGHT))
                .pl(px(2.5))
                .pr(px(7.))
                .gap(px(5.))
                .rounded(px(6.))
                .bg(blue.opacity(0.14))
                .border(gpui_kit::px(0.5))
                .border_color(if selected { blue } else { blue.opacity(0.5) })
                .cursor_pointer()
                .child(
                    div()
                        .size(px(15.))
                        .rounded(px(8.))
                        .bg(blue)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(10.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(0x0B1A2A))
                        .child(mark.n.to_string()),
                )
                .when_some(mark.image.clone(), |s, path: String| {
                    s.child(
                        img(crate::rows::markdown::file_picture(&path))
                            .w(px(21.))
                            .h(px(14.))
                            .rounded(px(3.))
                            .object_fit(ObjectFit::Cover),
                    )
                })
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(crate::style::quiet_text(cx))
                        .child(mark.label.clone()),
                ),
        )
        .into_any_element()
}

impl ReviewWindow {
    /// The draft's marks as chips: number, what they're on, cut-out.
    pub(super) fn mark_chips(&self) -> Vec<MarkChip> {
        let review = self.session.review();
        self.session
            .shown_draft()
            .marks
            .iter()
            .map(|m| MarkChip {
                n: m.n,
                label: threadbear_core::review_canvas::mark_label(review, m),
                image: m.image.as_ref().map(|i| i.path.clone()),
            })
            .collect()
    }

    /// A mark just drawn: its chip where the cursor is in the reply, and the
    /// keys to the box, so Mike can say what it's about straight away.
    pub(super) fn insert_mark_chip(&mut self, n: u32, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chip) = self.mark_chips().into_iter().find(|m| m.n == n) else {
            return;
        };
        let id = self.reply_pictures.fresh_id();
        self.reply_pictures.marks.insert(id.clone(), chip);
        let target = self.reply.clone();
        let (text, selection) = {
            let state = target.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let prev_is_space = text[..selection.start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        target.update(cx, |s, cx| {
            if !selection.is_empty() {
                s.replace("", window, cx);
            }
            if !prev_is_space {
                s.insert(" ", window, cx);
            }
            let _ = s.replace_with_token(mark_token(&id), window, cx);
            s.insert(" ", window, cx);
            s.focus(window, cx);
            crate::web_panels::keyboard_to_app(window);
        });
        self.reply_to_draft(window, cx);
    }

    /// A mark's cut-out came in: its chip shows it.
    pub(super) fn mark_chip_image(&mut self, n: u32, path: String) {
        for chip in self.reply_pictures.marks.values_mut() {
            if chip.n == n {
                chip.image = Some(path.clone());
            }
        }
    }
}
