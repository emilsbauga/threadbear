// Agent Archive in the sidebar's search (the `archive` experiment,
// runner/src/experiments/archive.md; docs/protocol/threads.md, "Searching
// Agent Archive"; mockup B, which Mike picked on 23 Nov 2026). After the
// app's own threads, the search lists the archive's sessions with the words:
// every word said anywhere, sessions outside Threadbear, from before it, and
// from every machine. The runner asks the archive through its own command;
// the app only ever asks the runner.
//
// The archive is asked once typing pauses, with three or more characters,
// and its rows come after the app's own, so they never hold those up. While
// it's asked, a row says so. A session whose Threadbear thread the app has
// opens that thread; any other opens read-only in the thread's place, with
// Open in the archive and New thread from this under it.
use crate::app::Threadbear;
use crate::sidebar::{icon, tipped, Palette, CORNER, LEADING, TILE, TRAILING};
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::tips::Tip as _;
use crate::{call, icons};
use gpui_kit::base::{RangeHighlight, RenderedText, TestSupportExt as _, TextViewState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use threadbear_core::archive_search::{self as core, Answer, Hit, Item, Results, Role, Session};
use threadbear_core::sidebar::local_now;

/// The search's side of it, and the session open in the thread's place.
#[derive(Default)]
pub(crate) struct ArchiveSearch {
    /// The words the archive is being asked about (typing hasn't paused
    /// yet, or the answer hasn't come): the "Searching the archive" row.
    pub(crate) asking: Option<String>,
    /// The last answer, with the words it was for.
    pub(crate) results: Option<Results>,
    /// Why the last search failed, with its words.
    pub(crate) error: Option<(String, String)>,
    /// The runner has the archive off, or doesn't know the method: nothing
    /// shows for it until the next hello.
    pub(crate) off: bool,
    /// The pause and the search under way. Replacing it drops the one before.
    task: Option<Task<()>>,
    pub(crate) open: Option<ArchivePage>,
}

/// A session open read-only in the thread's place.
pub(crate) struct ArchivePage {
    pub(crate) hit: Hit,
    /// The words that found it, marked in its messages.
    pub(crate) query: String,
    pub(crate) session: Option<Session>,
    pub(crate) items: Vec<PageItem>,
    pub(crate) error: Option<String>,
    pub(crate) scroll: ScrollHandle,
    /// The message to bring into view, until its replies have been laid out.
    scroll_to: Option<usize>,
    task: Option<Task<()>>,
    _watch: Vec<Subscription>,
}

pub(crate) struct PageItem {
    pub(crate) item: Item,
    /// An agent's reply, drawn as a thread's are.
    doc: Option<Entity<TextViewState>>,
    /// The reply's text when its words were last marked.
    marked: Option<RenderedText>,
    /// The message the search found.
    pub(crate) found: bool,
}

impl ArchivePage {
    fn loading(&self) -> bool {
        self.session.is_none() && self.error.is_none()
    }
}

/// The amber behind a search's words, as a highlighter would mark them.
fn mark_colour(cx: &App) -> Hsla {
    let a = if cx.theme().is_dark() { 0.32 } else { 0.4 };
    hsla(42. / 360., 0.9, 0.55, a)
}

/// `text` with the search's words marked.
fn marked_text(text: &str, query: &str, fg: Hsla, cx: &App) -> StyledText {
    let bg = mark_colour(cx);
    let marks = core::marks(text, query)
        .into_iter()
        .map(|r| {
            (
                r,
                HighlightStyle {
                    color: Some(fg),
                    background_color: Some(bg),
                    ..Default::default()
                },
            )
        })
        .collect::<Vec<_>>();
    StyledText::new(text.to_owned()).with_highlights(marks)
}

impl Threadbear {
    /// The experiment's on for this Mac's runner and the runner hasn't said
    /// the archive is off.
    pub(crate) fn archive_on(&self) -> bool {
        !self.archive.off && self.experiment_on(core::EXPERIMENT)
    }

    /// A new hello: the runner may have the archive now.
    pub(crate) fn archive_hello(&mut self) {
        self.archive.off = false;
    }

    /// The search's words changed: the archive is asked once typing pauses,
    /// with the row saying so from now, and an answer for words since
    /// changed is dropped.
    pub(crate) fn archive_search_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).value().trim().to_owned();
        if !self.archive_on() || !core::searchable(&query) {
            self.archive.task = None;
            self.archive.asking = None;
            return;
        }
        if self.archive.asking.as_deref() == Some(query.as_str()) {
            return;
        }
        // Answered already, or failed: asked again only once the words
        // change, as this runs on every redraw of the box.
        let answered = self
            .archive
            .results
            .as_ref()
            .is_some_and(|r| r.query == query)
            || self
                .archive
                .error
                .as_ref()
                .is_some_and(|(q, _)| *q == query);
        if answered {
            self.archive.task = None;
            self.archive.asking = None;
            return;
        }
        self.archive.asking = Some(query.clone());
        let client = self.client.clone();
        self.archive.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(core::PAUSE_MS))
                .await;
            let res = call(
                client,
                "archive.search",
                json!({ "query": query, "limit": core::LIMIT }),
            )
            .await;
            this.update(cx, |this, cx| {
                if this.archive.asking.as_deref() != Some(query.as_str()) {
                    return;
                }
                this.archive.asking = None;
                match res {
                    Ok(v) => match core::decode_search(&query, &v) {
                        Answer::Off => {
                            this.archive.off = true;
                            this.archive.results = None;
                        }
                        Answer::Found(r) => this.archive.results = Some(r),
                    },
                    // A runner from before the archive.
                    Err(e) if e.code == -32601 => this.archive.off = true,
                    Err(e) => this.archive.error = Some((query.clone(), e.message)),
                }
                this.notify_threads_panel(cx);
            })
            .ok();
        }));
    }

    /// The hits shown for the search as it reads now, under the app's own
    /// results (`own`), or None when the archive has nothing to show.
    fn archive_hits_for(&self, query: &str, own: &HashSet<&str>) -> Option<Vec<Hit>> {
        let r = self.archive.results.as_ref().filter(|r| r.query == query)?;
        Some(core::shown(&r.hits, own).into_iter().cloned().collect())
    }

    /// The keys of the archive's rows the arrow keys walk, after the threads.
    pub(crate) fn archive_arrow_keys(&self, own: &HashSet<&str>, cx: &App) -> Vec<String> {
        let query = self.search.read(cx).value().trim().to_owned();
        if !self.archive_on() || !core::searchable(&query) || self.archive.asking.is_some() {
            return Vec::new();
        }
        self.archive_hits_for(&query, own)
            .unwrap_or_default()
            .iter()
            .map(|h| row_key(&h.thread_id))
            .collect()
    }

    /// The arrows reached an archive row: it opens as a click opens it.
    pub(crate) fn step_to_archive(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = key.strip_prefix("archive:") else {
            return;
        };
        let hit = self
            .archive
            .results
            .as_ref()
            .and_then(|r| r.hits.iter().find(|h| h.thread_id == id))
            .cloned();
        if let Some(hit) = hit {
            self.open_archive_hit(hit, window, cx);
        }
    }

    /// The archive page's row key, for the arrows to start from.
    pub(crate) fn archive_open_key(&self) -> Option<String> {
        self.archive_page_showing()
            .then(|| {
                self.archive
                    .open
                    .as_ref()
                    .map(|p| row_key(&p.hit.thread_id))
            })
            .flatten()
    }

    /// The archive's rows, keyed for the list's motion: its heading, then a
    /// row saying it's searching, why it failed, that nothing matched, or
    /// the hits. Nothing when the archive's off or the words are too few.
    pub(crate) fn render_archive_rows(
        &mut self,
        own: &HashSet<&str>,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> Vec<(String, AnyElement)> {
        let query = self.search.read(cx).value().trim().to_owned();
        if !self.archive_on() || !core::searchable(&query) {
            return Vec::new();
        }
        let asking = self.archive.asking.is_some();
        let error = self
            .archive
            .error
            .as_ref()
            .filter(|(q, _)| *q == query)
            .map(|(_, e)| e.clone());
        let hits = (!asking && error.is_none())
            .then(|| self.archive_hits_for(&query, own))
            .flatten();
        let more = self.archive.results.as_ref().is_some_and(|r| r.more);
        let count = hits.as_ref().map(|h| core::count_label(h.len(), more));
        let mut out = vec![(
            "heading:archive".to_owned(),
            self.render_archive_heading(count, p),
        )];
        let note = |text: String, colour: Hsla| {
            div()
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .pt(px(4.))
                .pb(px(6.))
                .text_size(px(style::size::SIDEBAR_PREVIEW))
                .text_color(colour)
                .child(text)
                .into_any_element()
        };
        if asking {
            let row = h_flex()
                .id("archive-searching")
                .test_support()
                .role(gpui_kit::Role::ProgressIndicator)
                .aria_label("Searching the archive")
                .pl(px(LEADING))
                .pt(px(4.))
                .pb(px(6.))
                .gap(px(8.))
                .items_center()
                .text_size(px(style::size::SIDEBAR_PREVIEW))
                .text_color(p.secondary)
                .child(Spinner::new().color(p.secondary).with_size(px(11.)))
                .child("Searching the archive")
                .into_any_element();
            out.push(("note:archive".into(), row));
        } else if let Some(e) = error {
            out.push(("note:archive".into(), note(e, p.failed)));
        } else if let Some(hits) = hits {
            if hits.is_empty() {
                out.push((
                    "note:archive".into(),
                    note("Nothing in the archive matches.".into(), p.secondary),
                ));
            }
            let now = local_now();
            for hit in hits {
                let key = row_key(&hit.thread_id);
                let row = self.render_archive_row(hit, &query, &now, p, cx);
                out.push((key, row));
            }
        }
        out
    }

    /// The Agent Archive heading, with how many it found once it's found them.
    fn render_archive_heading(&self, count: Option<String>, p: &Palette) -> AnyElement {
        h_flex()
            .id("heading-archive")
            .test_support()
            .role(gpui_kit::Role::Heading)
            .aria_label("Agent Archive")
            .tip("Sessions in Agent Archive with these words: from every agent and machine, and from before Threadbear")
            .pr(px(TRAILING))
            .pl(px(LEADING))
            .pt(px(18.))
            .pb(px(6.))
            .gap(px(6.))
            .items_center()
            .child(icon("archivebox", 11., p.secondary).flex_none())
            .child(
                div()
                    .flex_none()
                    .text_size(px(style::size::SIDEBAR_HEADING))
                    .line_height(px(16.))
                    .font_semibold()
                    .text_color(p.secondary)
                    .child("Agent Archive"),
            )
            .when_some(count, |s, n| {
                s.child(
                    div()
                        .flex_none()
                        .text_size(px(style::size::SIDEBAR_HEADING))
                        .line_height(px(16.))
                        .text_color(p.faint)
                        .child(n),
                )
            })
            .child(div().flex_1().min_w_0().h(px(1.)).mx(px(4.)).bg(p.hairline))
            .into_any_element()
    }

    /// One session: who it was with, its title, where and when, and the
    /// words round the match.
    fn render_archive_row(
        &mut self,
        hit: Hit,
        query: &str,
        now: &threadbear_core::chrono::DateTime<threadbear_core::chrono::Local>,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let line = core::hit_line(&hit, now);
        let opens_thread = hit
            .threadbear
            .as_ref()
            .is_some_and(|t| self.threads.get(&t.thread_id).is_some());
        let tip = if opens_thread {
            format!("{}\n{line}\nOpens its thread", hit.title)
        } else {
            format!("{}\n{line}\nOpens read-only, from Agent Archive", hit.title)
        };
        let selected = self.archive_page_showing()
            && self
                .archive
                .open
                .as_ref()
                .is_some_and(|o| o.hit.thread_id == hit.thread_id);
        let hovered = self.sidebar.hovered.as_deref() == Some(row_key(&hit.thread_id).as_str());
        let tile = div()
            .flex_none()
            .size(px(TILE))
            .rounded(px(7.))
            .bg(p.tile)
            .flex()
            .items_center()
            .justify_center()
            .child(
                icons::provider_mark(&hit.agent)
                    .with_size(px(15.))
                    .text_color(p.secondary),
            );
        let snippet = (!hit.snippet.is_empty()).then(|| marked_text(&hit.snippet, query, p.fg, cx));
        let title = hit.title.clone();
        let hover_key = row_key(&hit.thread_id);
        let (bg_hover, bg_sel) = (p.hover, p.selected);
        h_flex()
            .id(ElementId::Name(
                format!("archive-row-{}", hit.thread_id).into(),
            ))
            .test_support()
            .role(gpui_kit::Role::ListItem)
            .aria_selected(selected)
            .aria_label(hit.title.clone())
            .tip(tip)
            .items_start()
            .gap(px(10.))
            .pt(px(crate::sidebar::row_pad()))
            .pb(px(crate::sidebar::row_pad()))
            .pl(px(LEADING))
            .pr(px(TRAILING))
            .rounded(px(CORNER))
            .when(selected, |s| s.bg(bg_sel))
            .when(!selected && hovered, |s| s.bg(bg_hover))
            .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                if *over {
                    this.sidebar.hovered = Some(hover_key.clone());
                } else if this.sidebar.hovered.as_deref() == Some(hover_key.as_str()) {
                    this.sidebar.hovered = None;
                }
                this.notify_threads_panel(cx);
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    this.open_archive_hit(hit.clone(), window, cx);
                }),
            )
            .child(div().pt(px(2.)).child(tile))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(if style::compact() { 1. } else { 3. }))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(style::size::SIDEBAR_TITLE))
                            .line_height(px(17.))
                            .text_color(p.fg)
                            .child(title),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(style::size::SIDEBAR_META + 1.))
                            .line_height(px(15.))
                            .text_color(p.secondary)
                            .child(line),
                    )
                    .when_some(snippet, |s, snippet| {
                        s.child(
                            div()
                                .min_w_0()
                                .line_clamp(2)
                                .text_size(px(style::size::SIDEBAR_PREVIEW))
                                .line_height(px(17.))
                                .text_color(p.secondary)
                                .child(snippet),
                        )
                    }),
            )
            .into_any_element()
    }

    /// Opens a hit: its Threadbear thread when the app has it, else the
    /// session read-only in the thread's place, there at once with a
    /// spinner until its messages come.
    pub(crate) fn open_archive_hit(
        &mut self,
        hit: Hit,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(t) = hit
            .threadbear
            .as_ref()
            .filter(|t| self.threads.get(&t.thread_id).is_some())
        {
            self.open(t.thread_id.clone(), window, cx);
            return;
        }
        let query = self.search.read(cx).value().trim().to_owned();
        if self.archive_page_showing()
            && self
                .archive
                .open
                .as_ref()
                .is_some_and(|o| o.hit.thread_id == hit.thread_id && o.error.is_none())
        {
            return;
        }
        self.close_subagent(cx);
        self.leave_pane(cx);
        self.selected = None;
        self.shows_home = false;
        self.projects.open = None;
        self.archive.open = Some(ArchivePage {
            hit,
            query,
            session: None,
            items: Vec::new(),
            error: None,
            scroll: ScrollHandle::new(),
            scroll_to: None,
            task: None,
            _watch: Vec::new(),
        });
        self.load_archive_page(cx);
        cx.notify();
    }

    /// `archive.read` for the open session, around the message that matched.
    fn load_archive_page(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.archive.open.as_mut() else {
            return;
        };
        page.error = None;
        let (id, around) = (page.hit.thread_id.clone(), page.hit.sequence);
        let client = self.client.clone();
        let task = cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "archive.read",
                json!({ "threadId": id, "around": around, "limit": core::READ_LIMIT }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.archive_page_read(&id, res.map_err(|e| e.message), cx)
            })
            .ok();
        });
        page.task = Some(task);
    }

    fn archive_page_read(&mut self, id: &str, res: Result<Value, String>, cx: &mut Context<Self>) {
        let Some(page) = self.archive.open.as_mut().filter(|p| p.hit.thread_id == id) else {
            return;
        };
        page.task = None;
        let read = match res {
            Ok(v) => core::decode_read(&v)
                .ok_or_else(|| "The archive sent nothing for this session.".to_owned()),
            Err(e) => Err(e),
        };
        match read {
            Err(e) => page.error = Some(e),
            Ok((session, items)) => {
                let found = core::found_index(&items, page.hit.sequence);
                let mut watch = Vec::new();
                let mut out = Vec::new();
                for (n, item) in items.into_iter().enumerate() {
                    let doc = (item.role == Role::Assistant).then(|| {
                        let doc = cx.new(|cx| TextViewState::markdown(&item.text, cx));
                        // Its words marked once its text is laid out.
                        watch.push(cx.observe(&doc, |this, _, cx| this.mark_archive_page(cx)));
                        doc
                    });
                    out.push(PageItem {
                        item,
                        doc,
                        marked: None,
                        found: Some(n) == found,
                    });
                }
                page.items = out;
                page.session = Some(session);
                page.scroll_to = found;
                page._watch = watch;
            }
        }
        self.mark_archive_page(cx);
        cx.notify();
    }

    /// Marks the search's words in each reply whose text has changed since
    /// (its parse landing), as the find bar marks a page's.
    fn mark_archive_page(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.archive.open.as_mut() else {
            return;
        };
        let bg = mark_colour(cx);
        let query = page.query.clone();
        for item in &mut page.items {
            let Some(doc) = item.doc.clone() else {
                continue;
            };
            let rendered = doc.read(cx).rendered_text();
            if item.marked.as_ref() == Some(&rendered) || rendered.as_str().is_empty() {
                continue;
            }
            let marks: Vec<RangeHighlight> = core::marks(rendered.as_str(), &query)
                .into_iter()
                .map(|r| RangeHighlight::new(r, bg))
                .collect();
            item.marked = Some(rendered);
            doc.update(cx, |s, cx| {
                if marks.is_empty() {
                    s.clear_range_highlights(cx);
                } else {
                    let _ = s.set_range_highlights(marks, cx);
                }
            });
        }
    }

    /// Whether the main panel shows the archive's session: one's open and
    /// nothing has taken the thread's place since.
    pub(crate) fn archive_page_showing(&self) -> bool {
        self.archive.open.is_some()
            && self.selected.is_none()
            && self.home_page().is_none()
            && self.open_project().is_none()
    }

    /// The session's title line in the panel's bar: its title, the Agent
    /// Archive chip, and who, where and when.
    pub(crate) fn render_archive_header_title(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.archive_page_showing() {
            return None;
        }
        let page = self.archive.open.as_ref()?;
        let now = local_now();
        let (title, line) = match &page.session {
            Some(s) => (s.title.clone(), core::session_line(s, &now)),
            None => (page.hit.title.clone(), core::hit_line(&page.hit, &now)),
        };
        let faint = style::faint_text(cx);
        let secondary = style::secondary_text(cx);
        Some(
            h_flex()
                .min_w_0()
                .pl(px(7.))
                .relative()
                .top(px(1.))
                .gap(px(8.))
                .items_center()
                .text_size(px(style::size::HEADER))
                .child(
                    div()
                        .id("archive-header-title")
                        .test_support()
                        .min_w_0()
                        .truncate()
                        .font_weight(FontWeight::SEMIBOLD)
                        .tip(title.clone())
                        .child(title),
                )
                .child(
                    tipped!(
                        div()
                            .flex_none()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(5.))
                            .border_1()
                            .border_color(style::primary_opacity(cx, 0.12))
                            .bg(style::primary_opacity(cx, 0.05))
                            .text_size(px(style::size::DETAIL))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(secondary),
                        "archive-chip",
                        "A session from Agent Archive, read only",
                        gpui_kit::Role::GenericContainer
                    )
                    .child("Agent Archive"),
                )
                .child(
                    div()
                        .flex_shrink(1.)
                        .min_w_0()
                        .truncate()
                        .text_size(px(style::size::LABEL))
                        .text_color(faint)
                        .child(line),
                )
                .into_any_element(),
        )
    }

    /// The session in the thread's place: its messages, the one the search
    /// found marked and brought into view, and a bar where the message box
    /// would be.
    pub(crate) fn render_archive_page(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let label = style::label_text(cx);
        let secondary = style::secondary_text(cx);
        let bubble_bg = style::bubble_background(cx);
        let mark = mark_colour(cx);
        let reading = crate::rows::reading_style(cx);
        let Some(page) = self.archive.open.as_mut() else {
            return div().into_any_element();
        };
        let loading = page.loading();
        let query = page.query.clone();
        let url = page.session.as_ref().and_then(|s| s.url.clone());
        let (title, thread_id) = (
            page.session
                .as_ref()
                .map_or_else(|| page.hit.title.clone(), |s| s.title.clone()),
            page.hit.thread_id.clone(),
        );
        // Kept asking until the replies above it have been laid out, as each
        // one's height only settles once its Markdown is.
        if let Some(n) = page.scroll_to {
            page.scroll.scroll_to_item(n);
            let settled = page
                .items
                .iter()
                .take(n + 1)
                .all(|i| i.doc.as_ref().is_none_or(|_| i.marked.is_some()));
            if settled {
                page.scroll_to = None;
            }
        }
        let mut list = v_flex()
            .id("archive-page-list")
            .test_support()
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&page.scroll)
            .px(px(style::SIDE_INSET))
            .pt(px(24.))
            .pb(px(24.));
        if loading {
            list = list.child(
                h_flex()
                    .id("archive-page-loading")
                    .test_support()
                    .role(gpui_kit::Role::ProgressIndicator)
                    .aria_label("Reading the archive")
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(style::size::LABEL))
                    .text_color(secondary)
                    .child(Spinner::new().color(secondary).with_size(px(12.)))
                    .child("Reading the archive"),
            );
        }
        if let Some(e) = page.error.clone() {
            list = list.child(
                v_flex()
                    .gap(px(10.))
                    .items_start()
                    .text_size(px(style::size::LABEL))
                    .text_color(secondary)
                    .child(format!("Couldn't read this session: {e}"))
                    .child(
                        Button::new("archive-page-retry")
                            .label("Try again")
                            .small()
                            .secondary()
                            .tooltip("Ask the archive for this session again")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.load_archive_page(cx);
                                cx.notify();
                            })),
                    ),
            );
        }
        for (n, item) in page.items.iter().enumerate() {
            let body: AnyElement = match (&item.doc, item.item.role) {
                (Some(doc), _) => {
                    crate::open_gate::text_view(doc, crate::open_gate::Origin::ThisMac, "")
                        .selectable(true)
                        .style(reading.clone())
                        .into_any_element()
                }
                (None, _) => h_flex()
                    .w_full()
                    .justify_end()
                    .child(
                        div()
                            .max_w(relative(crate::rows::metrics::BUBBLE_SHARE))
                            .px(px(crate::rows::metrics::BUBBLE_PAD_H))
                            .py(px(crate::rows::metrics::BUBBLE_PAD_V))
                            .rounded(px(crate::rows::metrics::BUBBLE_RADIUS))
                            .bg(bubble_bg)
                            .text_size(px(style::size::BODY))
                            .line_height(px(style::size::BODY_LINE))
                            .text_color(label)
                            .child(marked_text(&item.item.text, &query, label, cx)),
                    )
                    .into_any_element(),
            };
            let role = if item.item.role == Role::User {
                "user"
            } else {
                "assistant"
            };
            list = list.child(
                div()
                    .id(("archive-message", n))
                    .test_support()
                    .role(gpui_kit::Role::Group)
                    .aria_label(format!("{role} message {}", item.item.sequence))
                    .w_full()
                    .max_w(px(style::MAX_CONTENT_WIDTH))
                    .mx_auto()
                    .py(px(10.))
                    .when(item.found, |s| {
                        s.border_l(px(3.))
                            .border_color(hsla(42. / 360., 0.9, 0.55, 1.))
                            .pl(px(14.))
                            .bg(Hsla {
                                a: mark.a * 0.18,
                                ..mark
                            })
                    })
                    .child(body),
            );
        }
        let new_words = core::new_thread_words(&title, &thread_id);
        let bar = h_flex()
            .id("archive-page-bar")
            .test_support()
            .mx(px(style::SIDE_INSET))
            .mb(px(18.))
            .px(px(16.))
            .py(px(12.))
            .gap(px(10.))
            .items_center()
            .rounded(px(14.))
            .border_1()
            .border_color(style::primary_opacity(cx, 0.1))
            .bg(style::primary_opacity(cx, 0.03))
            .text_size(px(style::size::LABEL))
            .text_color(secondary)
            .child(
                tipped!(
                    div().flex_1().min_w_0().truncate(),
                    "archive-read-only",
                    "This session is in Agent Archive: read it here, or pick it up in a new thread",
                    gpui_kit::Role::GenericContainer
                )
                .child("Read only"),
            )
            .when_some(url, |s, url| {
                s.child(
                    Button::new("archive-open-reader")
                        .label("Open in the archive")
                        .small()
                        .secondary()
                        .tooltip("Open this session in Agent Archive's reader, in your browser")
                        .on_click(move |_, _, cx| {
                            crate::open_gate::open_web(&url, cx);
                        }),
                )
            })
            .child(
                Button::new("archive-new-thread")
                    .label("New thread from this")
                    .small()
                    .primary()
                    .disabled(loading)
                    .tooltip("Start a new thread that picks this session up: its agent reads it from the archive")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.start_thread_about(new_words.clone(), window, cx);
                    })),
            );
        v_flex()
            .size_full()
            .child(div().flex_1().min_h_0().child(list))
            .child(bar)
            .into_any_element()
    }

    /// What the sidebar's search shows of the archive, for `dump`.
    pub(crate) fn archive_search_dump(&self, cx: &App) -> Value {
        let query = self.search.read(cx).value().trim().to_owned();
        let shown = self.archive_on() && core::searchable(&query);
        let error = self
            .archive
            .error
            .as_ref()
            .filter(|(q, _)| *q == query)
            .map(|(_, e)| e.clone());
        let now = local_now();
        let own_ids: Vec<String> = if shown {
            self.shown_sections(cx, crate::now_ms())
                .iter()
                .flat_map(|s| s.rows.iter().map(|t| t.id.clone()))
                .collect()
        } else {
            Vec::new()
        };
        let own: HashSet<&str> = own_ids.iter().map(String::as_str).collect();
        let hits = if shown && self.archive.asking.is_none() {
            self.archive_hits_for(&query, &own)
        } else {
            None
        };
        json!({
            "on": self.archive_on(),
            "shown": shown,
            "searching": shown && self.archive.asking.is_some(),
            "error": error,
            "hits": hits.map(|hs| hs.iter().map(|h| json!({
                "threadId": h.thread_id,
                "title": h.title,
                "line": core::hit_line(h, &now),
                "snippet": h.snippet,
                "marked": core::marks(&h.snippet, &query).into_iter().map(|r| h.snippet[r].to_owned()).collect::<Vec<_>>(),
                "threadbear": h.threadbear.as_ref().map(|t| t.thread_id.clone()),
            })).collect::<Vec<_>>()),
        })
    }

    /// The session in the thread's place, for `dump`.
    pub(crate) fn archive_page_dump(&self, cx: &App) -> Value {
        if !self.archive_page_showing() {
            return Value::Null;
        }
        let Some(page) = self.archive.open.as_ref() else {
            return Value::Null;
        };
        let now = local_now();
        json!({
            "threadId": page.hit.thread_id,
            "title": page.session.as_ref().map_or(&page.hit.title, |s| &s.title),
            "line": page.session.as_ref().map(|s| core::session_line(s, &now)),
            "loading": page.loading(),
            "error": page.error,
            "url": page.session.as_ref().and_then(|s| s.url.clone()),
            "messages": page.items.iter().map(|i| json!({
                "role": if i.item.role == Role::User { "user" } else { "assistant" },
                "text": i.item.text,
                "found": i.found,
                "marked": i.doc.as_ref().map_or_else(
                    || core::marks(&i.item.text, &page.query).into_iter().map(|r| i.item.text[r].to_owned()).collect::<Vec<_>>(),
                    |d| { let t = d.read(cx).rendered_text(); core::marks(t.as_str(), &page.query).into_iter().map(|r| t.as_str()[r].to_owned()).collect() },
                ),
            })).collect::<Vec<_>>(),
        })
    }
}

/// The list's key for a session's row.
pub(crate) fn row_key(thread_id: &str) -> String {
    format!("archive:{thread_id}")
}
