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
use crate::composer::{is_picture, keep_picture, picture_chip, picture_token, save_pasted_image, unstage};
use gpui_kit::component::input::{InlineTokenContext, InputContent, TextareaState};
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

#[derive(Default)]
pub(super) struct ReplyPictures {
    chips: HashMap<SharedString, ReplyPicture>,
    next: usize,
}

impl ReplyPictures {
    fn fresh_id(&mut self) -> SharedString {
        self.next += 1;
        format!("reply-picture-{}", self.next).into()
    }

    /// The box's words and chips for a reply as the draft keeps it, its
    /// `[Picture N]` markers chips again. Any chips from before go.
    pub(super) fn content_for(&mut self, reply: &str, images: &[ImageRef]) -> InputContent {
        self.chips.clear();
        let (text, order) = words::edit_draft(reply, images.len());
        let mut out = String::new();
        let mut tokens = Vec::new();
        let mut placed = order.into_iter();
        for c in text.chars() {
            if c.to_string() != PICTURE_MARK_STR {
                out.push(c);
                continue;
            }
            let Some(image) = placed.next().and_then(|i| images.get(i)).cloned() else { continue };
            let id = self.fresh_id();
            let start = out.len();
            out.push_str(PICTURE_MARK_STR);
            tokens.push((start..out.len(), picture_token(&id)));
            self.chips.insert(id, ReplyPicture { source: PathBuf::from(&image.path), image: Some(image), failed: false });
        }
        let mut content = InputContent::new(out);
        for (range, token) in tokens {
            content = content.clone().with_token(range, token).unwrap_or(content);
        }
        content
    }

    /// The chips in the box, in order.
    fn ids(state: &TextareaState) -> Vec<SharedString> {
        state.tokens().iter().map(|span| span.token().id().clone()).collect()
    }

    /// The reply and its pictures as the draft keeps them, each picture's
    /// chip its `[Picture N]`, or None while a picture is still on its way in
    /// (it can't be sent without it). A chip with no picture (one that
    /// failed, put back by Undo) is left out, and so is a mark that isn't a chip.
    pub(super) fn draft_of(&self, state: &TextareaState) -> Option<(String, Vec<ImageRef>)> {
        if self.loading(state) {
            return None;
        }
        let text = state.value().to_string();
        let mut spans: Vec<_> = state.tokens().iter().map(|span| (span.range(), span.token().id().clone())).collect();
        spans.sort_by_key(|(range, _)| range.start);
        let mut reply = String::with_capacity(text.len());
        let mut images = Vec::new();
        let mut at = 0;
        for (range, id) in spans {
            if range.start < at || range.end > text.len() {
                continue;
            }
            reply.push_str(&words::draft_words(&text[at..range.start]));
            if let Some(image) = self.chips.get(&id).and_then(|c| c.image.clone()) {
                images.push(image);
                reply.push_str(&words::picture_marker(images.len()));
            }
            at = range.end;
        }
        reply.push_str(&words::draft_words(&text[at..]));
        Some((reply, images))
    }

    /// Whether a picture in the box is still being copied in.
    pub(super) fn loading(&self, state: &TextareaState) -> bool {
        Self::ids(state).iter().any(|id| self.chips.get(id).is_some_and(|c| c.image.is_none() && !c.failed))
    }


    /// Each picture chip's file, in the box's order: the runner's copy once
    /// it's in, else the one it came from.
    fn paths(&self, state: &TextareaState) -> Vec<(SharedString, String)> {
        Self::ids(state).into_iter().filter_map(|id| {
            let chip = self.chips.get(&id)?;
            let path = chip.image.as_ref().map_or_else(|| chip.source.to_string_lossy().into_owned(), |i| i.path.clone());
            Some((id, path))
        }).collect()
    }

    /// The runner's own copies, once a save has them: the same pictures in
    /// the same order, so the box points at the copies that last.
    pub(super) fn adopt(&mut self, state: &TextareaState, images: &[ImageRef]) {
        let ids: Vec<_> = Self::ids(state).into_iter().filter(|id| self.chips.get(id).is_some_and(|c| c.image.is_some())).collect();
        if ids.len() != images.len() {
            return;
        }
        for (id, image) in ids.iter().zip(images) {
            if let Some(chip) = self.chips.get_mut(id) {
                chip.image = Some(image.clone());
            }
        }
    }

    pub(super) fn render(&self, ctx: &InlineTokenContext, state: &TextareaState, cx: &App) -> AnyElement {
        let id = ctx.token().id();
        let chip = self.chips.get(id);
        let number = Self::ids(state).iter().position(|c| c == id).map_or(1, |i| i + 1);
        let path = chip.map(|c| c.image.as_ref().map_or_else(|| c.source.clone(), |i| PathBuf::from(&i.path)));
        picture_chip(path, number, chip.is_none_or(|c| c.image.is_none()), ctx.is_selected(), cx)
    }
}

impl ReviewWindow {
    /// A paste into the reply: pictures and files first, as the thread's box
    /// takes them; words paste as words. Whether it took the paste.
    pub(super) fn take_reply_clipboard(&mut self, item: Option<&ClipboardItem>, window: &mut Window, cx: &mut Context<Self>) -> bool {
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
    pub(super) fn take_reply_paths(&mut self, paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.session.editable() {
            return;
        }
        let (pictures, others): (Vec<_>, Vec<_>) = paths.into_iter().map(keep_picture).partition(|p| is_picture(p));
        let target = self.reply.clone();
        let (text, selection) = {
            let state = target.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let ids: Vec<SharedString> = pictures.iter().map(|_| self.reply_pictures.fresh_id()).collect();
        let mut piece_paths = words::path_text(&others.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>());
        let prev_is_space = text[..selection.start].chars().next_back().map_or(true, char::is_whitespace);
        let next_is_space = text[selection.end..].chars().next().is_some_and(char::is_whitespace);
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
            self.reply_pictures.chips.insert(id.clone(), ReplyPicture { source: path.clone(), image: None, failed: false });
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
                futures::future::Either::Right(_) => Err("The picture took too long to arrive".into()),
            };
            let (result, staged) = match prepared {
                Ok(mut prepared) => {
                    // A legacy file promise can bring several; the first is this chip's.
                    let staged = std::mem::take(&mut prepared.paths);
                    let first = staged.first().cloned().unwrap_or_else(|| path.clone());
                    (crate::call(client, "media.import", json!({ "path": first.to_string_lossy() })).await.map_err(|e| e.message), staged)
                }
                Err(message) => (Err(message), Vec::new()),
            };
            // The runner keeps its own copy (or said no): a pasted picture's
            // staged file goes now, whatever happens to the chip.
            unstage(&path);
            for staged in &staged {
                unstage(staged);
            }
            this.update(cx, |this, cx| this.settle_reply_picture(id, result, cx)).ok();
        })
        .detach();
    }

    fn settle_reply_picture(&mut self, id: SharedString, result: Result<serde_json::Value, String>, cx: &mut Context<Self>) {
        let image = result.and_then(|v| ImageRef::decode(&v["image"]).ok_or_else(|| "The runner's answer didn't make sense.".to_owned()));
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
            let range = self.reply.read(cx).tokens().iter().find(|span| span.token().id() == &id).map(|span| span.range());
            if let Some(range) = range {
                self.reply.update(cx, |s, cx| {
                    s.set_selected_range(range, cx);
                    s.replace("", window, cx);
                });
            }
        }
        let parts = self.reply_pictures.draft_of(self.reply.read(cx));
        let Some((reply, images)) = parts else { return };
        self.reply_synced = reply.clone();
        self.pictures_synced = images.len();
        if self.session.set_reply_with_pictures(&reply, images) {
            self.edited(cx);
        }
    }

    /// A plain click on a picture's chip in the reply: the picture full size
    /// over this window, stepping through the reply's others, as a chip in
    /// the thread's box opens (composer.rs `open_picture`).
    pub(super) fn open_reply_picture(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let paths = self.reply_pictures.paths(self.reply.read(cx));
        let Some(chosen) = paths.iter().find(|(chip, _)| chip == id).map(|(_, path)| path.clone()) else { return };
        crate::viewer::open(self, paths.into_iter().map(|(_, path)| path).collect(), &chosen, window, cx);
    }

    pub(super) fn reply_loading(&self, cx: &App) -> bool {
        self.reply_pictures.loading(self.reply.read(cx))
    }
}
