// The Feed (experiment `feed`, runner/src/experiments/feed.md): the Inbox as
// one roomy card per thread, one after another, in the main panel in place of
// the thread, as Mike picked on 20 Nov 2026 (feed-mockups r3-c-status: "basically
// our inbox, but with everything inline"). The sidebar stays as it is.
//
// A card: what Mike asked (his first message to it, `request`), or who started
// it; "Where it's at", the latest turn's headline, its asks answerable in place
// (the composer's own buttons and rows, through project_decisions.rs's
// `DecisionCard`) or a spinner line while it works; a fold with the agent's
// avatar and how many messages, which opens its recent messages inside the
// card; Done, which archives it and shrinks it to one line with Undo until
// Mike leaves the feed; Later, the hibernate menu; and a reply box on a card
// that needs him or whose fold he opened. A pill, "↑ N new", says cards came in
// while he was scrolled down. The rules with no window in them are
// threadbear_core::feed.
use crate::app::Threadbear;
use crate::project_decisions::DecisionCard;
use crate::shell::SidebarMode;
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::{call, icons, now_ms};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use threadbear_core::feed::{self as rules, Author, CardState, Starter};
use threadbear_core::inbox::ThreadSummary;

/// How many of a thread's newest events a card reads for its fold.
const EVENTS_READ: u64 = 200;
/// The feed's column, as the mockup has it.
const COLUMN: f32 = 680.;
/// Where a card's boxes start, past its avatar.
const INSET: f32 = 48.;

/// A card's messages, read from its thread's events.
pub(crate) struct Loaded {
    last_seq: u64,
    messages: Vec<rules::Message>,
    more_before: bool,
    at: Instant,
}

/// The Feed's state in the app (`Threadbear::inbox_feed`).
#[derive(Default)]
pub(crate) struct FeedState {
    pub(crate) scroll: ScrollHandle,
    /// Threads marked Done here: archived, and one line with Undo until Mike
    /// leaves the feed.
    pub(crate) done: HashSet<String>,
    /// Each Done row's thread as it was archived, for the row once the
    /// app's list no longer has archived threads in it.
    done_rows: HashMap<String, Arc<ThreadSummary>>,
    /// Cards whose fold is open.
    pub(crate) folds: HashSet<String>,
    /// Messages opened with See full, by thread and seq.
    full: HashSet<(String, u64)>,
    /// Folds showing their earlier messages too.
    earlier: HashSet<String>,
    loaded: HashMap<String, Loaded>,
    loading: HashSet<String>,
    /// Each card's reply box, made the first time it's drawn.
    replies: HashMap<String, Entity<TextareaState>>,
    subs: Vec<Subscription>,
    /// Replies on their way, with their words, shown under the box with a
    /// spinner until the runner takes them.
    pub(crate) sending: HashMap<String, String>,
    /// Replies the runner refused, to put back in their box at the next draw.
    put_back: HashMap<String, String>,
    /// Each card's asks, answered in place.
    asks: HashMap<String, Entity<DecisionCard>>,
    /// The cards there when Mike last saw the top, for "↑ N new".
    seen: Option<HashSet<String>>,
}

/// The first word of this account's full name ("Mike"), for the top of a
/// card he started and over his messages; "You" where there's none. Read
/// from the account's own record (its GECOS field), so no program runs.
fn user_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        // SAFETY: getpwuid's record is read straight away, on one thread
        // (OnceLock), before anything else can call it again.
        #[cfg(unix)]
        let full = unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if pw.is_null() || (*pw).pw_gecos.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr((*pw).pw_gecos)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        #[cfg(not(unix))]
        let full = String::new();
        rules::first_name(full.split(',').next().unwrap_or(""))
    })
}

impl Threadbear {
    /// The feed experiment is on for this Mac's runner.
    pub(crate) fn feed_on(&self) -> bool {
        self.experiment_on(rules::EXPERIMENT)
    }

    /// Opens the Feed in the main panel; the sidebar shows the Inbox.
    pub(crate) fn show_feed(&mut self, cx: &mut Context<Self>) {
        if !self.feed_on() {
            return;
        }
        self.unfold_threads(cx);
        self.set_mode(SidebarMode::Feed, cx);
    }

    /// Leaving the Feed: the Done rows go, as the threads they stand for are
    /// archived, and the next visit starts from the top.
    pub(crate) fn left_feed(&mut self) {
        self.inbox_feed.done.clear();
        self.inbox_feed.done_rows.clear();
        self.inbox_feed.seen = None;
    }

    /// A thread opened (or the new-thread page) takes the Feed's place: the
    /// sidebar is back on the Inbox.
    pub(crate) fn leave_feed_for_thread(&mut self) {
        if self.mode == SidebarMode::Feed {
            self.left_feed();
            self.mode = SidebarMode::Inbox;
        }
    }

    /// The threads the feed shows, in its order.
    pub(crate) fn feed_cards(&self) -> Vec<Arc<ThreadSummary>> {
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        let gone = self
            .inbox_feed
            .done_rows
            .iter()
            .filter(|(id, _)| !self.threads.contains_key(id.as_str()))
            .map(|(_, t)| t);
        rules::feed_threads(
            self.threads.values().chain(gone),
            now_ms(),
            &wakes,
            &self.inbox_feed.done,
        )
    }

    fn feed_state_of(&self, t: &ThreadSummary) -> CardState {
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        rules::card_state(t, now_ms(), &wakes)
    }

    /// A card shows as a Done row: marked here, and archived still (a
    /// refused archive puts the card back).
    fn feed_is_done(&self, t: &ThreadSummary) -> bool {
        self.inbox_feed.done.contains(&t.id) && t.is_archived()
    }

    // ---- What a card does ----

    /// Done: archived at once, the card down to one line; back if the runner
    /// refuses (`update_thread`'s rollback), with its reason.
    pub(crate) fn feed_done(&mut self, id: &str, cx: &mut Context<Self>) {
        let at = threadbear_core::inbox::iso_time(now_ms());
        self.inbox_feed.done.insert(id.to_owned());
        self.inbox_feed.folds.remove(id);
        self.update_thread(
            id,
            move |t| t.archived_at = Some(at),
            json!({ "archived": true, "archivedBy": "mike" }),
            cx,
        );
        if let Some(t) = self.threads.get(id) {
            self.inbox_feed
                .done_rows
                .insert(id.to_owned(), Arc::new((**t).clone()));
        }
    }

    /// Undo on a Done row: back in the Inbox at once, and a card again.
    pub(crate) fn feed_undo(&mut self, id: &str, cx: &mut Context<Self>) {
        self.inbox_feed.done.remove(id);
        // Back in the list as it was, if the list has let it go, so taking
        // the archive off shows at once.
        if let Some(t) = self
            .inbox_feed
            .done_rows
            .remove(id)
            .filter(|_| !self.threads.contains_key(id))
        {
            self.threads.insert(id.to_owned(), t);
        }
        self.unarchive_row(id, cx);
    }

    pub(crate) fn feed_toggle_fold(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.inbox_feed.folds.remove(id) {
            self.inbox_feed.folds.insert(id.to_owned());
            self.feed_load(id, cx);
        }
        cx.notify();
    }

    /// Reads a card's messages from its thread's newest events.
    fn feed_load(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.inbox_feed.loading.contains(id) {
            return;
        }
        let Some(t) = self.threads.get(id).cloned() else {
            return;
        };
        if self
            .inbox_feed
            .loaded
            .get(id)
            .is_some_and(|l| l.last_seq == t.last_seq)
        {
            return;
        }
        self.inbox_feed.loading.insert(id.to_owned());
        let client = self.client.clone();
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.events",
                json!({ "threadId": id, "limit": EVENTS_READ }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.inbox_feed.loading.remove(&id);
                if let Ok(page) = res {
                    let events: Vec<Value> = page["events"].as_array().cloned().unwrap_or_default();
                    let first = events.first().and_then(|e| e["seq"].as_u64()).unwrap_or(1);
                    let last = page["lastSeq"]
                        .as_u64()
                        .or_else(|| events.last().and_then(|e| e["seq"].as_u64()))
                        .unwrap_or(t.last_seq);
                    let more_before = events.len() as u64 >= EVENTS_READ && first > 1;
                    this.inbox_feed.loaded.insert(
                        id.clone(),
                        Loaded {
                            last_seq: last.max(t.last_seq),
                            messages: rules::messages(&events),
                            more_before,
                            at: Instant::now(),
                        },
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The card's messages are read once it's drawn, and again once its
    /// thread has moved on: at once with the fold open (at most every few
    /// seconds while it works), else once its turn is over.
    fn feed_refresh(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        if self.inbox_feed.loading.contains(&t.id) {
            return;
        }
        let open = self.inbox_feed.folds.contains(&t.id);
        let due = match self.inbox_feed.loaded.get(&t.id) {
            None => open || !t.is_remote(),
            Some(l) if l.last_seq == t.last_seq => false,
            Some(l) if open => l.at.elapsed() > Duration::from_secs(3),
            Some(_) => !t.busy() && !t.is_remote(),
        };
        if due {
            self.feed_load(&t.id, cx);
        }
    }

    /// The card's reply box, made the first time it's drawn.
    fn feed_reply_box(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(input) = self.inbox_feed.replies.get(id) {
            return input.clone();
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Reply")
                .auto_grow(1, 8)
                .submit_on_enter(true)
        });
        // Its words are only here until they're sent: an update's restart
        // waits for them (unsent.rs).
        crate::unsent::watch_in(&input, "a reply box in the Feed", Some(id.to_owned()), cx);
        let thread = id.to_owned();
        let sub = cx.subscribe_in(
            &input,
            window,
            move |this, _input, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = ev {
                    this.feed_send_reply(&thread, window, cx);
                }
            },
        );
        self.inbox_feed.subs.push(sub);
        self.inbox_feed.replies.insert(id.to_owned(), input.clone());
        input
    }

    /// Sends what's in a card's box to its thread, as the composer's Send
    /// does. The box empties at once and its words show under it with a
    /// spinner till the runner takes them; refused, they go back in the box.
    pub(crate) fn feed_send_reply(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.inbox_feed.sending.contains_key(id) {
            return;
        }
        let Some(input) = self.inbox_feed.replies.get(id).cloned() else {
            return;
        };
        let text = input.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        input.update(cx, |s, cx| s.set_value("", window, cx));
        self.feed_send(id, text, cx);
    }

    fn feed_send(&mut self, id: &str, text: String, cx: &mut Context<Self>) {
        let Some(t) = self.threads.get(id).cloned() else {
            return;
        };
        self.inbox_feed.sending.insert(id.to_owned(), text.clone());
        cx.notify();
        let remote = t.runner_id.is_some();
        let params = json!({ "threadId": id, "text": text, "runnerId": t.runner_id });
        let going = crate::call_for_thread(self.client.clone(), remote, "threads.send", params);
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.inbox_feed.sending.remove(&id);
                if let Err(e) = res {
                    this.inbox_feed.put_back.insert(id.clone(), text);
                    this.show_error(e.message, cx);
                } else {
                    // What it sent is the newest message: read again.
                    this.inbox_feed.loaded.remove(&id);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn feed_asks(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> Entity<DecisionCard> {
        if let Some(card) = self.inbox_feed.asks.get(&t.id) {
            return card.clone();
        }
        let app = cx.entity().downgrade();
        let id = t.id.clone();
        let card = cx.new(|_| DecisionCard::for_feed(app, id));
        self.inbox_feed.asks.insert(t.id.clone(), card.clone());
        card
    }

    /// Back to the top, from the "↑ N new" pill.
    fn feed_to_top(&mut self, cx: &mut Context<Self>) {
        self.inbox_feed
            .scroll
            .set_offset(point(gpui_kit::px(0.), gpui_kit::px(0.)));
        self.inbox_feed.seen = Some(self.feed_cards().iter().map(|t| t.id.clone()).collect());
        cx.notify();
    }

    /// Scrolls a card to the top of the feed.
    #[cfg(feature = "automation")]
    fn feed_show(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(index) = self.feed_cards().iter().position(|t| t.id == id) else {
            return;
        };
        let scroll = &self.inbox_feed.scroll;
        // Where the card was last laid out, against the list's top: its top
        // goes a little under the list's.
        if let Some(item) = scroll.bounds_for_item(index) {
            let (list, now) = (scroll.bounds(), scroll.offset());
            let y = f32::from(now.y) - (f32::from(item.top()) - f32::from(list.top()) - 16.);
            scroll.set_offset(point(now.x, gpui_kit::px(y.min(0.))));
        } else {
            scroll.scroll_to_top_of_item(index);
        }
        cx.notify();
    }

    // ---- Drawing ----

    /// The Feed, in the main panel: a column of cards about 680 wide in the
    /// middle, and the "↑ N new" pill over it while new ones came in below
    /// the top.
    pub(crate) fn render_feed(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cards = self.feed_cards();
        let ids: Vec<String> = cards.iter().map(|t| t.id.clone()).collect();
        let away = -f32::from(self.inbox_feed.scroll.offset().y) > rules::AWAY_FROM_TOP;
        let fresh = match &self.inbox_feed.seen {
            Some(seen) if away => rules::new_count(ids.iter().map(String::as_str), seen),
            _ => {
                self.inbox_feed.seen = Some(ids.iter().cloned().collect());
                0
            }
        };
        // The cards are the scrolling list's own children, so one can be
        // scrolled to by its place (`feed_show`).
        let mut column = v_flex()
            .id("feed")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.inbox_feed.scroll)
            .items_center()
            .gap(px(16.))
            .pt(px(22.))
            .pb(px(48.))
            .px(px(28.));
        if cards.is_empty() {
            column = column.child(
                div()
                    .pt(px(40.))
                    .w_full()
                    .flex()
                    .justify_center()
                    .text_size(px(style::size::LABEL))
                    .text_color(style::secondary_text(cx))
                    .child("Nothing in your Inbox."),
            );
        }
        for t in &cards {
            let card = if self.feed_is_done(t) {
                self.render_done_row(t, cx)
            } else {
                self.render_feed_card(t, window, cx)
            };
            column = column.child(div().w_full().max_w(px(COLUMN)).flex_none().child(card));
        }
        let pill = (fresh > 0).then(|| {
            div()
                .absolute()
                .top(px(14.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(crate::highlights::tipped(
                    div()
                        .id("feed-new")
                        .role(gpui_kit::Role::Button)
                        .px(px(16.))
                        .py(px(7.))
                        .rounded_full()
                        .bg(style::button_fill(cx))
                        .border_1()
                        .border_color(style::button_edge(cx))
                        .shadow(vec![BoxShadow::new(px(0.), px(6.), hsla(0., 0., 0., 0.5))
                            .blur_radius(px(20.))])
                        .text_size(px(13.5))
                        .font_medium()
                        .text_color(style::label_text(cx))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.feed_to_top(cx)))
                        .child(rules::new_pill(fresh)),
                    "Go to the top for the new ones",
                ))
        });
        div()
            .relative()
            .size_full()
            // The pill follows where the feed's scrolled to.
            .child(column.on_scroll(cx.listener(|_, _: &ScrollEvent, _, cx| cx.notify())))
            .children(pill)
            .into_any_element()
    }

    /// "✓ title · headline · Undo": a card marked Done, until Mike leaves the
    /// feed.
    fn render_done_row(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> AnyElement {
        let (title, head) = rules::done_line(t);
        let id = t.id.clone();
        let faint = style::faint_text(cx);
        h_flex()
            .id(SharedString::from(format!("feed-done-{}", t.id)))
            .w_full()
            .items_center()
            .gap(px(10.))
            .px(px(16.))
            .py(px(10.))
            .rounded(px(14.))
            .bg(style::card_background(cx).opacity(0.7))
            .border_1()
            .border_color(style::card_border(cx))
            .text_size(px(14.))
            .line_height(px(18.))
            .child(
                div()
                    .flex_none()
                    .text_color(style::tick_green(cx))
                    .child("\u{2713}"),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(px(260.))
                    .truncate()
                    .font_medium()
                    .text_color(style::label_text(cx))
                    .child(title),
            )
            .when_some(head, |s, head| {
                s.child(div().flex_none().text_color(faint).child("\u{b7}"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(style::secondary_text(cx))
                            .child(head),
                    )
            })
            .child(div().flex_1())
            .child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!("feed-undo-{}", t.id)))
                        .role(gpui_kit::Role::Button)
                        .flex_none()
                        .cursor_pointer()
                        .text_color(style::link_text(cx))
                        .hover(|s| s.underline()),
                    "Put it back in your Inbox",
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.feed_undo(&id, cx)))
                .child("Undo"),
            )
            .into_any_element()
    }

    fn render_feed_card(
        &mut self,
        t: &ThreadSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.feed_refresh(t, cx);
        let state = self.feed_state_of(t);
        let top = rules::top(t);
        let now = threadbear_core::sidebar::local_now();
        let (faint, secondary, label) = (
            style::faint_text(cx),
            style::secondary_text(cx),
            style::label_text(cx),
        );
        let started_ms = t
            .created_at
            .as_deref()
            .and_then(threadbear_core::inbox::parse_ms)
            .unwrap_or_else(|| t.activity_ms());
        let (avatar, name, meta): (AnyElement, String, String) = match top.from {
            Starter::Mike => (
                person_avatar(user_name(), 36., cx),
                user_name().to_owned(),
                rules::when(started_ms, &now),
            ),
            Starter::Thread => (
                letters_avatar(&top.initials, 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
            Starter::Schedule => (
                symbol_avatar("clock", 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
            Starter::Tool => (
                letters_avatar(&top.initials, 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
        };
        let pill = (state == CardState::NeedsYou).then(|| {
            let accent = style::control_accent(cx);
            div()
                .flex_none()
                .px(px(10.))
                .py(px(2.))
                .rounded_full()
                .bg(accent.opacity(0.35))
                .text_size(px(12.))
                .line_height(px(16.))
                .font_semibold()
                .text_color(style::label_text(cx))
                .child("Needs you")
        });
        let header = h_flex()
            .w_full()
            .items_start()
            .gap(px(12.))
            .child(avatar)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .flex_shrink(1.)
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(14.))
                                    .line_height(px(20.))
                                    .font_semibold()
                                    .text_color(label)
                                    .child(name),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(13.))
                                    .line_height(px(20.))
                                    .text_color(faint)
                                    .child(meta),
                            )
                            .child(div().flex_1())
                            .children(pill),
                    )
                    .child(
                        div()
                            .mt(px(2.))
                            .text_size(px(15.))
                            .line_height(px(22.))
                            .text_color(label)
                            .child(top.line),
                    ),
            );
        let where_box = self.render_where(t, state, window, cx);
        let footer = self.render_card_foot(t, cx);
        let fold_open = self.inbox_feed.folds.contains(&t.id);
        let fold = fold_open.then(|| self.render_fold(t, window, cx));
        let reply =
            (state == CardState::NeedsYou || fold_open).then(|| self.render_reply(t, window, cx));
        let _ = secondary;
        // Its own id, so the asks' controls in it are this card's to the
        // window, not the next card's of the same shape.
        v_flex()
            .id(SharedString::from(format!("feed-card-{}", t.id)))
            .w_full()
            .px(px(20.))
            .pt(px(18.))
            .pb(px(14.))
            .rounded(px(20.))
            .bg(style::card_background(cx))
            .border_1()
            .border_color(style::card_border(cx))
            .child(header)
            .child(where_box)
            .child(footer)
            .children(fold)
            .children(reply)
            .into_any_element()
    }

    /// "Where it's at": the latest turn's headline, then its asks to answer
    /// here, or while it works a spinner and what it's doing.
    fn render_where(
        &mut self,
        t: &ThreadSummary,
        state: CardState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = threadbear_core::sidebar::local_now();
        let (faint, secondary) = (style::faint_text(cx), style::secondary_text(cx));
        let updated = rules::when(t.activity_ms(), &now);
        let heading = h_flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(13.))
            .line_height(px(17.))
            .child(
                icons::symbol("arrow.clockwise")
                    .with_size(px(12.))
                    .text_color(secondary),
            )
            .child(
                div()
                    .font_semibold()
                    .text_color(secondary)
                    .child("Where it's at"),
            )
            .child(div().text_color(faint).child(updated));
        let mut body = v_flex().w_full().child(heading);
        let head = self
            .inbox_feed
            .loaded
            .get(&t.id)
            .and_then(|l| rules::fuller_headline(t, &l.messages))
            .or_else(|| rules::headline(t));
        if let Some(head) = head.clone() {
            body = body.child(
                div()
                    .mt(px(4.))
                    .text_size(px(15.))
                    .line_height(px(22.))
                    .line_clamp(3)
                    .overflow_hidden()
                    .text_color(style::label_text(cx))
                    .child(head),
            );
        }
        let waiting_asks = threadbear_core::projects::is_waiting(t);
        if state == CardState::NeedsYou && waiting_asks {
            let card = self.feed_asks(t, cx);
            let sending = threadbear_core::projects::is_sending(
                t,
                self.projects.decision_sends.get(&t.id).map(|s| s.asks_seq),
            );
            card.update(cx, |card, _| {
                card.prepare(t);
                card.mark_sending(sending);
            });
            let asks = card.update(cx, |card, cx| card.render_asks(window, cx));
            body = body.child(div().w_full().pt(px(6.)).child(asks));
        } else if t.status == "waiting" {
            let id = t.id.clone();
            body = body.child(
                h_flex()
                    .mt(px(8.))
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(13.5))
                    .text_color(secondary)
                    .child("It's waiting for you to answer in the thread.")
                    .child(crate::project_page::small_push_button(
                        SharedString::from(format!("feed-answer-{}", t.id)),
                        "Open thread",
                        "Open the thread to answer it",
                        cx,
                        cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_thread_from_page(id.clone(), window, cx)
                        }),
                    )),
            );
        } else if state == CardState::Running {
            body = body.child(
                h_flex()
                    .mt(px(8.))
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(13.5))
                    .line_height(px(18.))
                    .text_color(secondary)
                    .child(
                        div().flex_none().size(px(12.)).child(
                            Spinner::new()
                                .icon(gpui_kit::assets::IconName::LoaderCircle)
                                .color(secondary)
                                .with_size(px(12.)),
                        ),
                    )
                    .child(div().min_w_0().truncate().child(rules::live_line(t))),
            );
        } else if head.is_none() {
            body = body.child(
                div()
                    .mt(px(4.))
                    .text_size(px(14.))
                    .text_color(faint)
                    .child("Nothing said yet."),
            );
        }
        div()
            .id(SharedString::from(format!("feed-where-{}", t.id)))
            .mt(px(14.))
            .ml(px(INSET))
            .px(px(14.))
            .py(px(12.))
            .rounded(px(14.))
            .bg(style::answer_rows_fill(cx))
            .border_1()
            .border_color(style::hairline(cx))
            .child(body)
            .into_any_element()
    }

    /// The fold with the agent's avatar and how many messages, Done and Later.
    fn render_card_foot(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> AnyElement {
        let open = self.inbox_feed.folds.contains(&t.id);
        let loaded = self.inbox_feed.loaded.get(&t.id);
        let words = rules::fold_label(
            &t.provider,
            loaded.map(|l| l.messages.len()),
            loaded.is_some_and(|l| l.more_before),
        );
        let (secondary, label) = (style::secondary_text(cx), style::label_text(cx));
        let (fold_id, done_id, later_id) = (t.id.clone(), t.id.clone(), t.id.clone());
        let fold = crate::highlights::tipped(
            h_flex()
                .id(SharedString::from(format!("feed-fold-{}", t.id)))
                .role(gpui_kit::Role::Button)
                .items_center()
                .gap(px(8.))
                .pl(px(5.))
                .pr(px(12.))
                .py(px(4.))
                .rounded_full()
                .bg(if open {
                    style::chip_fill(cx)
                } else {
                    style::chip_hover_fill(cx)
                })
                .hover(|s| s.bg(style::chip_fill(cx)))
                .cursor_pointer()
                .text_size(px(13.))
                .line_height(px(16.))
                .text_color(if open { label } else { secondary })
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.feed_toggle_fold(&fold_id, cx)
                }))
                .child(agent_avatar(&t.provider, 22., cx))
                .child(words)
                .child(
                    icons::symbol(if open { "chevron.up" } else { "chevron.down" })
                        .with_size(px(11.))
                        .text_color(secondary),
                ),
            if open {
                "Fold the messages away"
            } else {
                "Show its recent messages"
            },
        );
        let done = foot_button(
            SharedString::from(format!("feed-done-button-{}", t.id)),
            "checkmark",
            "Done",
            "Archive it",
            cx,
            cx.listener(move |this, _: &ClickEvent, _, cx| this.feed_done(&done_id, cx)),
        );
        let later = foot_button(
            SharedString::from(format!("feed-later-{}", t.id)),
            "clock",
            "Later",
            "Hibernate it until later",
            cx,
            cx.listener(move |this, ev: &ClickEvent, window, cx| {
                this.open_hibernate_menu(later_id.clone(), ev.position(), window, cx)
            }),
        );
        h_flex()
            .mt(px(12.))
            .ml(px(INSET))
            .items_center()
            .gap(px(6.))
            .child(fold)
            .child(done)
            .child(later)
            .into_any_element()
    }

    /// The fold, open: its newest messages, each cut to three lines with See
    /// full and Open thread, and Show N earlier messages over them.
    fn render_fold(
        &mut self,
        t: &ThreadSummary,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut list = v_flex()
            .w_full()
            .mt(px(12.))
            .pt(px(12.))
            .border_t_1()
            .border_color(style::hairline(cx));
        let Some(loaded) = self.inbox_feed.loaded.get(&t.id) else {
            return list
                .child(
                    h_flex()
                        .ml(px(INSET))
                        .gap(px(8.))
                        .items_center()
                        .text_size(px(13.))
                        .text_color(style::secondary_text(cx))
                        .child(
                            Spinner::new()
                                .icon(gpui_kit::assets::IconName::LoaderCircle)
                                .with_size(px(12.)),
                        )
                        .child("Reading its messages"),
                )
                .into_any_element();
        };
        let all = &loaded.messages;
        let showing_earlier = self.inbox_feed.earlier.contains(&t.id);
        let start = if showing_earlier {
            0
        } else {
            all.len().saturating_sub(rules::FOLD_SHOWS)
        };
        if start > 0 {
            let id = t.id.clone();
            let n = start;
            list = list.child(
                div()
                    .id(SharedString::from(format!("feed-earlier-{}", t.id)))
                    .role(gpui_kit::Role::Button)
                    .ml(px(INSET))
                    .mb(px(10.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(style::link_text(cx))
                    .hover(|s| s.underline())
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.inbox_feed.earlier.insert(id.clone());
                        cx.notify();
                    }))
                    .child(if n == 1 {
                        "Show 1 earlier message".to_owned()
                    } else {
                        format!("Show {n} earlier messages")
                    }),
            );
        }
        if all.is_empty() {
            list = list.child(
                div()
                    .ml(px(INSET))
                    .text_size(px(13.))
                    .text_color(style::faint_text(cx))
                    .child("No messages yet."),
            );
        }
        let messages: Vec<rules::Message> = all[start..].to_vec();
        for m in messages {
            list = list.child(self.render_fold_message(t, &m, cx));
        }
        list.into_any_element()
    }

    fn render_fold_message(
        &mut self,
        t: &ThreadSummary,
        m: &rules::Message,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = threadbear_core::sidebar::local_now();
        let (avatar, name) = match m.author {
            Author::Mike => (person_avatar(user_name(), 32., cx), user_name().to_owned()),
            Author::Agent => (
                agent_avatar(&t.provider, 32., cx),
                rules::agent_name(&t.provider),
            ),
            Author::Other => (
                letters_avatar(&rules::initials(&m.by), 32., cx),
                m.by.clone(),
            ),
        };
        let key = (t.id.clone(), m.seq);
        let full = self.inbox_feed.full.contains(&key);
        let text = if full { m.text.clone() } else { plain(&m.text) };
        let words = div()
            .mt(px(1.))
            .text_size(px(14.5))
            .line_height(px(21.))
            .text_color(style::label_text(cx))
            .when(!full, |s| s.line_clamp(3).overflow_hidden())
            .child(text);
        let (open_id, see_key) = (t.id.clone(), key);
        let links = h_flex()
            .mt(px(4.))
            .gap(px(16.))
            .text_size(px(12.5))
            .text_color(style::faint_text(cx))
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id(SharedString::from(format!("feed-full-{}-{}", t.id, m.seq)))
                        .role(gpui_kit::Role::Button)
                        .gap(px(4.))
                        .items_center()
                        .cursor_pointer()
                        .hover(|s| s.text_color(style::secondary_text(cx))),
                    if full {
                        "Cut it back to three lines"
                    } else {
                        "See all of this message"
                    },
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if !this.inbox_feed.full.remove(&see_key) {
                        this.inbox_feed.full.insert(see_key.clone());
                    }
                    cx.notify();
                }))
                .child(
                    icons::symbol(if full { "chevron.up" } else { "chevron.down" })
                        .with_size(px(10.)),
                )
                .child(if full { "Less" } else { "See full" }),
            )
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id(SharedString::from(format!("feed-open-{}-{}", t.id, m.seq)))
                        .role(gpui_kit::Role::Button)
                        .gap(px(4.))
                        .items_center()
                        .cursor_pointer()
                        .hover(|s| s.text_color(style::secondary_text(cx))),
                    "Open thread",
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.open_thread_from_page(open_id.clone(), window, cx)
                }))
                .child(icons::symbol("arrow.up.forward.square").with_size(px(11.)))
                .child("Open thread"),
            );
        h_flex()
            .w_full()
            .items_start()
            .gap(px(12.))
            .pt(px(6.))
            .pb(px(8.))
            .child(avatar)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .items_baseline()
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_semibold()
                                    .text_color(style::label_text(cx))
                                    .child(name),
                            )
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .text_color(style::faint_text(cx))
                                    .child(rules::when(m.at_ms, &now)),
                            ),
                    )
                    .child(words)
                    .child(links),
            )
            .into_any_element()
    }

    /// The reply box: what's typed goes to the thread as the composer sends
    /// it. While it's on its way, its words under the box with a spinner.
    fn render_reply(
        &mut self,
        t: &ThreadSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let input = self.feed_reply_box(&t.id, window, cx);
        if let Some(text) = self.inbox_feed.put_back.remove(&t.id) {
            input.update(cx, |s, cx| s.set_value(text, window, cx));
        }
        let sending = self.inbox_feed.sending.get(&t.id).cloned();
        let secondary = style::secondary_text(cx);
        let id = t.id.clone();
        let send: AnyElement = if sending.is_some() {
            div()
                .flex_none()
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Spinner::new()
                        .icon(gpui_kit::assets::IconName::LoaderCircle)
                        .color(secondary)
                        .with_size(px(13.)),
                )
                .into_any_element()
        } else {
            crate::highlights::tipped(
                div()
                    .id(SharedString::from(format!("feed-send-{}", t.id)))
                    .role(gpui_kit::Role::Button)
                    .flex_none()
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx))),
                "Send it to the thread",
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.feed_send_reply(&id, window, cx)
            }))
            .child(
                icons::symbol("paperplane")
                    .with_size(px(15.))
                    .text_color(secondary),
            )
            .into_any_element()
        };
        let field = crate::composer::bare_textarea(Textarea::new(&input))
            .text_size(px(14.))
            .line_height(px(20.));
        let note = sending.map(|words| {
            h_flex()
                .ml(px(44.))
                .mt(px(6.))
                .gap(px(6.))
                .items_center()
                .text_size(px(12.5))
                .text_color(style::faint_text(cx))
                .child(div().flex_none().child("Sending:"))
                .child(div().min_w_0().truncate().child(words))
        });
        v_flex()
            .w_full()
            .mt(px(12.))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(12.))
                    .child(person_avatar(user_name(), 32., cx))
                    .child(
                        h_flex()
                            .id(SharedString::from(format!("feed-reply-{}", t.id)))
                            .flex_1()
                            .min_w_0()
                            .items_end()
                            .gap(px(8.))
                            .pl(px(12.))
                            .pr(px(6.))
                            .py(px(5.))
                            .rounded(px(14.))
                            .bg(style::composer_fill(cx))
                            .border_1()
                            .border_color(style::hairline(cx))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(div().flex_1().min_w_0().py(px(2.)).child(field))
                            .child(send),
                    ),
            )
            .children(note)
            .into_any_element()
    }

    /// The Feed in the dump (`feed`): one line a card, as `rules::dump_line`
    /// says it, with "(sending)" while an answer or a reply is on its way and
    /// "(open: N)" with its fold's messages.
    #[cfg(feature = "automation")]
    pub(crate) fn feed_dump(&self) -> Value {
        let cards = self.feed_cards();
        let lines: Vec<Value> = cards
            .iter()
            .map(|t| {
                let done = self.feed_is_done(t);
                let state = self.feed_state_of(t);
                let sending = threadbear_core::projects::is_sending(t, self.projects.decision_sends.get(&t.id).map(|s| s.asks_seq)) || self.inbox_feed.sending.contains_key(&t.id);
                let open = self.inbox_feed.folds.contains(&t.id);
                let loaded = self.inbox_feed.loaded.get(&t.id);
                json!({
                    "id": t.id,
                    "title": t.title,
                    "line": rules::dump_line(t, state, done),
                    "state": if done { "done" } else { state.name() },
                    "top": rules::top(t).line,
                    "fold": rules::fold_label(&t.provider, loaded.map(|l| l.messages.len()), loaded.is_some_and(|l| l.more_before)),
                    "open": open,
                    "messages": if open { loaded.map(|l| l.messages.iter().map(|m| m.text.clone()).collect::<Vec<_>>()).unwrap_or_default() } else { vec![] },
                    "sending": sending,
                    "reply": !done && (state == CardState::NeedsYou || open),
                })
            })
            .collect();
        json!({ "title": "Feed", "cards": lines })
    }
}

/// A message's words as one block of plain text for its three clipped lines:
/// markdown's marks out, its lines kept.
fn plain(text: &str) -> String {
    text.lines()
        .map(threadbear_core::sidebar::preview_plain)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The fold's and footer's quiet buttons: a symbol and a word, a pill on hover.
fn foot_button(
    id: SharedString,
    symbol: &'static str,
    label: &'static str,
    tip: &'static str,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let color = style::secondary_text(cx);
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .role(gpui_kit::Role::Button)
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(4.))
            .rounded_full()
            .cursor_pointer()
            .hover(|s| s.bg(style::hover_fill(cx)))
            .text_size(px(13.))
            .line_height(px(16.))
            .text_color(color)
            .on_click(on_click)
            .child(icons::symbol(symbol).with_size(px(13.)).text_color(color))
            .child(label),
        tip,
    )
    .into_any_element()
}

/// A round avatar with letters in it.
fn letters_avatar(letters: &str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.12))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.34))
        .font_semibold()
        .text_color(style::secondary_text(cx))
        .child(letters.to_owned())
        .into_any_element()
}

/// The person's avatar: their initial on a grey circle.
fn person_avatar(name: &str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.2))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.4))
        .font_semibold()
        .text_color(style::label_text(cx))
        .child(
            name.chars()
                .next()
                .map(|c| c.to_uppercase().collect::<String>())
                .unwrap_or_default(),
        )
        .into_any_element()
}

/// A schedule's avatar: its clock.
fn symbol_avatar(symbol: &'static str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.08))
        .flex()
        .items_center()
        .justify_center()
        .child(
            icons::symbol(symbol)
                .with_size(px(size * 0.5))
                .text_color(style::secondary_text(cx)),
        )
        .into_any_element()
}

/// The agent's avatar: its maker's mark on a dark circle (Claude's coral).
fn agent_avatar(provider: &str, size: f32, cx: &App) -> AnyElement {
    let (fill, ink) = match provider {
        "" | "claude" => (
            hsla(18. / 360., 0.2, 0.15, 1.),
            hsla(15. / 360., 0.63, 0.6, 1.),
        ),
        _ => (hsla(0., 0., 0.16, 1.), hsla(0., 0., 0.95, 1.)),
    };
    let _ = cx;
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .child(
            icons::provider_mark(provider)
                .with_size(px(size * 0.55))
                .text_color(ink),
        )
        .into_any_element()
}

/// `feed`, as a script drives it: `open` shows the Feed; with `thread` (its
/// id or title), `fold` (true or false) opens or folds its messages, `full`
/// (a message's seq) opens one, `done` marks it Done, `undo` puts it back,
/// `reply` sends those words from its box, `pick` "ask:choice" answers as a
/// click does (both from 1, 0 for Something else), `show` scrolls it to the
/// top; `top` scrolls to the top.
/// Says the feed after, as the dump does.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    if !app.read(cx).feed_on() {
        return Err("the feed experiment is off".to_owned());
    }
    if cmd["open"].as_bool() == Some(true) {
        app.update(cx, |t, cx| t.show_feed(cx));
    }
    if cmd["top"].as_bool() == Some(true) {
        app.update(cx, |t, cx| t.feed_to_top(cx));
    }
    if let Some(key) = cmd["thread"].as_str() {
        let thread = {
            let t = app.read(cx);
            let cards = t.feed_cards();
            let titles = cards
                .iter()
                .map(|s| s.title.clone())
                .collect::<Vec<_>>()
                .join(", ");
            cards
                .iter()
                .find(|s| s.id == key || s.title == key)
                .map(|s| (**s).clone())
                .ok_or_else(|| format!("no card for {key}; there are {titles}"))?
        };
        let id = thread.id.clone();
        if cmd["show"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_show(&id, cx));
        }
        if let Some(open) = cmd["fold"].as_bool() {
            app.update(cx, |t, cx| {
                if t.inbox_feed.folds.contains(&id) != open {
                    t.feed_toggle_fold(&id, cx);
                }
            });
        }
        if let Some(seq) = cmd["full"].as_u64() {
            app.update(cx, |t, cx| {
                t.inbox_feed.full.insert((id.clone(), seq));
                cx.notify();
            });
        }
        if cmd["done"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_done(&id, cx));
        }
        if cmd["undo"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_undo(&id, cx));
        }
        if let Some(words) = cmd["reply"].as_str() {
            let words = words.to_owned();
            app.update(cx, |t, cx| {
                let input = t.feed_reply_box(&id, window, cx);
                input.update(cx, |s, cx| s.set_value(words, window, cx));
                t.feed_send_reply(&id, window, cx);
            });
        }
        if let Some(pick) = cmd["pick"].as_str() {
            use crate::composer_card::AskHost as _;
            let card = app.update(cx, |t, cx| t.feed_asks(&thread, cx));
            card.update(cx, |card, _| card.prepare(&thread));
            let asks = threadbear_core::projects::decision_asks(&thread);
            let parts: Vec<usize> = pick.split(':').filter_map(|p| p.parse().ok()).collect();
            let [ask, choice] = parts.as_slice() else {
                return Err(format!("no choice {pick}"));
            };
            let Some(the_ask) = asks.get(ask.wrapping_sub(1)) else {
                return Err(format!("no choice {pick}"));
            };
            if *choice > threadbear_core::composer::choices(the_ask).len() {
                return Err(format!("no choice {pick}"));
            }
            let option = if *choice == 0 {
                threadbear_core::composer::OWN_ANSWER
            } else {
                *choice as i64 - 1
            };
            let ask = ask - 1;
            card.update(cx, |card, cx| card.ask_pick_answer(ask, option, window, cx));
        }
    }
    Ok(app.read(cx).feed_dump())
}
