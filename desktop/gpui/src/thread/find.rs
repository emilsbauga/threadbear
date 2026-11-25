// Find in the open thread: ⌘F (Control-F off the Mac) puts the file viewer's
// find bar (file_find.rs, `find_bar`) over the transcript, with the words to
// find, how many there are, ‹ and › (⇧⌘G and ⌘G, Shift-Return and Return in
// the field) and Done (Escape). A file in the pane keeps its own ⌘F.
//
// threadbear_core::thread_find finds the words in every row loaded, folded
// ones too. Getting to a match opens what hides it: the "Worked for" group
// it's folded into, a tool's output, a thought. What was opened for one
// match folds again when the bar moves on to another, and what's open for
// the match picked stays open when the bar closes, so Done leaves you
// reading it. Matches in a reply are marked in its words in yellow (the
// picked one strongly); the row with the picked match has an accent rail beside
// it, as a work link's step has for a moment. Older pages not loaded yet
// aren't searched: going back past the first match loads the page before.
use super::ThreadPane;
use crate::file_find::{find_bar, FindNext, FindPrevious};
use crate::style::px;
use gpui_kit::base::{RangeHighlight, RenderedText, TextViewState};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Mutex;
use std::time::Duration;
use threadbear_core::find::find_all;
use threadbear_core::reducer::RowContent;
use threadbear_core::thread_find::{Hit, ThreadFinder};

/// The key context of a thread's pane, which ⌘G and ⇧⌘G work in.
pub(crate) const CONTEXT: &str = "ThreadPane";

/// How long the rows wait, after they change under the bar (a reply
/// streaming, a page of older history), before they're searched again.
const REFRESH_AFTER: Duration = Duration::from_millis(150);

/// What the bar says while the page before is on its way.
const LOOKING_BACK: &str = "Looking further back…";

/// The words last looked for in any thread: ⌘G with the bar down finds them
/// again, as AppKit's find pasteboard does.
static LAST_QUERY: Mutex<String> = Mutex::new(String::new());

fn last_query() -> String {
    LAST_QUERY.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_last_query(query: &str) {
    *LAST_QUERY.lock().unwrap_or_else(|e| e.into_inner()) = query.to_owned();
}

/// ⌘G and ⇧⌘G in a thread, bound once for every window. ⌘F is the app's
/// own command (`FindInThread`, shell.rs), so it can be given another key.
pub(crate) fn bind_keys(cx: &mut App) {
    static BOUND: std::sync::Once = std::sync::Once::new();
    let mac = cfg!(target_os = "macos");
    BOUND.call_once(|| {
        cx.bind_keys([
            KeyBinding::new(
                if mac { "cmd-g" } else { "ctrl-g" },
                FindNext,
                Some(CONTEXT),
            ),
            KeyBinding::new(
                if mac { "cmd-shift-g" } else { "ctrl-shift-g" },
                FindPrevious,
                Some(CONTEXT),
            ),
        ]);
    });
}

/// The bar, while it's up over the thread.
pub(crate) struct ThreadFind {
    input: Entity<InputState>,
    finder: ThreadFinder,
    /// The match picked, kept so drawing a row doesn't work it out again.
    current: Option<Hit>,
    /// Groups and rows opened to show a match, folded again when it moves on.
    opened: Vec<String>,
    /// Replies whose matches are marked, by their page, and what for: a
    /// page marked for the same words, text and pick is left alone.
    marked: HashMap<String, Marked>,
    /// Each reply's page drawn while the bar's up, watched to mark it again
    /// when its text changes (its parse landing, more of it streaming in).
    watching: HashMap<String, Subscription>,
    /// The picked match is in a reply whose page wasn't ready to scroll to.
    reveal_waiting: bool,
    /// Going back past the first match asked for the page before.
    looking_back: bool,
    /// A search again after the rows changed, on its way.
    refresh: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

#[derive(Clone, PartialEq)]
struct Marked {
    query: String,
    text: RenderedText,
    picked: Option<usize>,
}

impl ThreadFind {
    /// The row with the picked match, for its rail (rows.rs).
    pub(crate) fn picked_row(&self) -> Option<&str> {
        self.current.as_ref().map(|h| h.row_id.as_str())
    }
}

impl ThreadPane {
    /// ⌘F: the bar over the transcript, its words picked to type over, or
    /// put in front again if it's up.
    pub(crate) fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx));
            let sub =
                cx.subscribe_in(
                    &input,
                    window,
                    |this, _, ev: &InputEvent, window, cx| match ev {
                        InputEvent::Change => this.find_changed(window, cx),
                        InputEvent::PressEnter { shift, .. } => this.find_step(*shift, window, cx),
                        _ => {}
                    },
                );
            let query = last_query();
            input.update(cx, |s, cx| s.set_value(query, window, cx));
            self.find = Some(ThreadFind {
                input,
                finder: ThreadFinder::default(),
                current: None,
                opened: Vec::new(),
                marked: HashMap::new(),
                watching: HashMap::new(),
                reveal_waiting: false,
                looking_back: false,
                refresh: None,
                _subs: vec![sub],
            });
            self.find_changed(window, cx);
        }
        if let Some(find) = &self.find {
            find.input.update(cx, |s, cx| {
                s.focus(window, cx);
                crate::web_panels::keyboard_to_app(window);
                s.select_all(window, cx);
            });
        }
        cx.notify();
    }

    /// The words changed: found again from the match picked, or from the
    /// row at the top of the view (the newest match when the view is at
    /// the end, following new lines).
    pub(crate) fn find_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let top = self
            .scroller
            .read(cx)
            .top_row()
            .and_then(|(i, _)| self.feed.model().rows().get(i))
            .map(|r| r.id.clone());
        let at_end = self.scroller.read(cx).following();
        let Some(find) = self.find.as_mut() else {
            return;
        };
        let query = find.input.read(cx).value().to_string();
        set_last_query(&query);
        let model = self.feed.model();
        let from = find.current.as_ref().map(|h| h.row_id.clone()).or(top);
        find.finder.index(model.rows(), model.items());
        find.finder.search(&query, from.as_deref());
        if find.current.is_none() && at_end {
            find.finder.pick_last();
        }
        find.current = find.finder.current();
        find.looking_back = false;
        self.show_match(window, cx);
    }

    /// Return, ⌘G, ›; with `back`, Shift-Return, ⇧⌘G, ‹. Back from the first
    /// match with older history still to load asks for the page before
    /// rather than going round to the newest.
    pub(crate) fn find_step(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let more_above = self.has_more_above();
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.finder.total() == 0 {
            return;
        }
        if back && find.finder.at_first() && more_above {
            find.looking_back = true;
            self.load_older(cx);
            cx.notify();
            return;
        }
        find.current = if back {
            find.finder.previous_match()
        } else {
            find.finder.next_match()
        };
        self.show_match(window, cx);
    }

    /// ⌘G or ⇧⌘G with the bar down finds the last words again, putting the
    /// bar up to say where.
    pub(crate) fn find_again(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.is_none() {
            if last_query().is_empty() {
                return;
            }
            self.open_find(window, cx);
        }
        self.find_step(back, window, cx);
    }

    /// Done or Escape: the bar goes, its marks with it, and the box has the
    /// keys again. What's open for the match picked stays open.
    pub(crate) fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(find) = self.find.take() else {
            return;
        };
        for key in find.marked.keys() {
            if let Some(doc) = self.rows.documents.get(key) {
                doc.update(cx, |s, cx| s.clear_range_highlights(cx));
            }
        }
        if self.subagent_id.is_none() {
            self.focus_composer(window, cx);
        }
        cx.notify();
    }

    /// The rows changed (`apply`, an older page, a new read): searched again
    /// in a moment, keeping to the match picked.
    pub(crate) fn find_rows_changed(&mut self, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.refresh.is_some() || find.finder.query().is_empty() {
            return;
        }
        find.refresh = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REFRESH_AFTER).await;
            this.update(cx, |this, cx| {
                if let Some(find) = this.find.as_mut() {
                    find.refresh = None;
                    let model = this.feed.model();
                    find.finder.refresh(model.rows(), model.items());
                    find.current = find.finder.current();
                    if !this.older.fetching() {
                        find.looking_back = false;
                    }
                }
                this.mark_replies(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Opens what hides the picked match, folds what was opened for the
    /// last one, scrolls it a third of the way down the view and marks it.
    fn show_match(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(hit) = self.find.as_ref().and_then(|f| f.current.clone()) else {
            self.mark_replies(cx);
            cx.notify();
            return;
        };
        let wanted: Vec<&str> = [
            hit.group.as_deref(),
            hit.inside.then_some(hit.row_id.as_str()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let before = self
            .find
            .as_mut()
            .map(|f| std::mem::take(&mut f.opened))
            .unwrap_or_default();
        let mut opened = Vec::new();
        // Newest first: a step folds before the group it's in, so it isn't
        // left open inside it.
        for id in before.into_iter().rev() {
            if wanted.contains(&id.as_str()) {
                opened.push(id);
            } else if let Some(row) = self.feed.model().row(&id).cloned() {
                if self.row_open(&row) {
                    self.set_open(&row, false, cx);
                }
            }
        }
        opened.reverse();
        for id in wanted {
            let Some(row) = self.feed.model().row(id).cloned() else {
                continue;
            };
            // One opened for the last match is in `opened` already.
            if !self.row_open(&row) {
                self.set_open(&row, true, cx);
                opened.push(id.to_owned());
            }
        }
        if let Some(find) = self.find.as_mut() {
            find.opened = opened;
            find.reveal_waiting = hit.doc_key.is_some();
        }
        if let Some(index) = self.feed.model().index_of(&hit.row_id) {
            self.scroller
                .update(cx, |s, cx| s.scroll_to_row(index, px(0.), cx));
            let (scroller, pane) = (self.scroller.clone(), cx.weak_entity());
            window.on_next_frame(move |_, cx| {
                scroller.update(cx, |s, cx| {
                    let down = s.viewport().size.height / 3.;
                    s.back_up(down, cx);
                });
                // A long reply's match can be further down it than that.
                pane.update(cx, |this, cx| this.reveal_picked(cx)).ok();
            });
        }
        self.mark_replies(cx);
        cx.notify();
    }

    /// Scrolls the picked match in a reply into view once its page has its
    /// text, as the row's laid out by then.
    fn reveal_picked(&mut self, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        let Some((key, nth)) = find
            .current
            .as_ref()
            .and_then(|h| Some((h.doc_key.clone()?, h.nth)))
        else {
            return;
        };
        let Some(doc) = self.rows.documents.get(&key).cloned() else {
            return;
        };
        let text = doc.read(cx).rendered_text();
        let found = find_all(text.as_str(), find.finder.query());
        let Some(range) = found.get(nth).or(found.last()).cloned() else {
            return;
        };
        find.reveal_waiting = false;
        doc.update(cx, |s, cx| {
            let _ = s.reveal_range(range, cx);
        });
    }

    /// Marks the matches in every reply that's been drawn: the ones with
    /// matches marked, the ones that had them and have none now cleared.
    fn mark_replies(&mut self, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_ref() else {
            return;
        };
        let found = find.finder.replies_found();
        let keys: Vec<String> = self
            .rows
            .documents
            .keys()
            .filter(|k| found.contains(k.as_str()) || find.marked.contains_key(*k))
            .cloned()
            .collect();
        for key in keys {
            if let Some(doc) = self.rows.documents.get(&key).cloned() {
                self.mark_reply(&key, &doc, cx);
            }
        }
    }

    /// A reply's matches marked softly and the picked one strongly, in
    /// find's yellow (`file_find::match_colours`). Called as the reply's page is
    /// drawn (`markdown_state`) and when its text changes, so it does nothing
    /// when it's already marked for the same.
    pub(crate) fn mark_reply(
        &mut self,
        key: &str,
        doc: &Entity<TextViewState>,
        cx: &mut Context<Self>,
    ) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        let query = find.finder.query().to_owned();
        let text = doc.read(cx).rendered_text();
        let picked = find
            .current
            .as_ref()
            .filter(|h| h.doc_key.as_deref() == Some(key))
            .map(|h| h.nth);
        let marked = Marked {
            query,
            text,
            picked,
        };
        // Drawn every frame: only the first time for these words, this
        // text and this pick does it search.
        if find.marked.get(key) == Some(&marked) {
            return;
        }
        // Watched from here on: a page's parse lands after it's first drawn,
        // with nothing else drawing the thread again.
        if !find.watching.contains_key(key) {
            let watched = key.to_owned();
            let sub = cx.observe(doc, move |this: &mut ThreadPane, doc, cx| {
                this.mark_reply(&watched, &doc, cx);
            });
            find.watching.insert(key.to_owned(), sub);
        }
        let found = if marked.query.is_empty() {
            Vec::new()
        } else {
            find_all(marked.text.as_str(), &marked.query)
        };
        if found.is_empty() {
            find.marked.insert(key.to_owned(), marked);
            doc.update(cx, |s, cx| s.clear_range_highlights(cx));
            return;
        }
        let (selection, faint) = crate::file_find::match_colours();
        // Its own count can differ from the core's (a reply's words as
        // parsed here and as drawn): the last one stands in for one past it.
        let picked_at = picked.map(|n| n.min(found.len() - 1));
        let marks: Vec<RangeHighlight> = found
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                RangeHighlight::new(
                    m,
                    if Some(i) == picked_at {
                        selection
                    } else {
                        faint
                    },
                )
            })
            .collect();
        find.marked.insert(key.to_owned(), marked);
        let reveal = find.reveal_waiting && picked.is_some();
        doc.update(cx, |s, cx| {
            let _ = s.set_range_highlights(marks, cx);
        });
        if reveal {
            self.reveal_picked(cx);
        }
    }

    /// `dump`'s `threadFind`: the bar's line ("the: 2 of 8") and the row with
    /// the picked match, while the bar is up.
    pub(crate) fn find_dump(&self) -> Option<serde_json::Value> {
        let find = self.find.as_ref()?;
        Some(serde_json::json!({
            "line": find.finder.dump_line(),
            "row": find.picked_row(),
        }))
    }

    /// The scripted `threadFind`: the bar up with `query` typed in it.
    pub(crate) fn find_typed(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_find(window, cx);
        let Some(input) = self.find.as_ref().map(|f| f.input.clone()) else {
            return;
        };
        // Setting the value says nothing to the subscription, as typing does.
        input.update(cx, |s, cx| s.set_value(query.to_owned(), window, cx));
        self.find_changed(window, cx);
    }

    /// ⌘F in this pane finds in its thread, whichever panel it's in; ⌘G
    /// and ⇧⌘G step through what it found.
    pub(crate) fn find_keys(el: Div, cx: &mut Context<Self>) -> Div {
        el.key_context(CONTEXT)
            .on_action(
                cx.listener(|this, _: &crate::shell::FindInThread, window, cx| {
                    this.open_find(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &FindNext, window, cx| this.find_again(false, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &FindPrevious, window, cx| this.find_again(true, window, cx)),
            )
    }

    /// What goes over the transcript: the line naming the thread that
    /// started this one, and the find bar while it's up.
    pub(crate) fn above_transcript(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out: Vec<AnyElement> = self.render_started_strip(cx).into_iter().collect();
        out.extend(self.render_find_bar(cx));
        out
    }

    /// The bar over the transcript, when it's up.
    pub(crate) fn render_find_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let find = self.find.as_ref()?;
        let label = if find.looking_back && self.older.fetching() {
            LOOKING_BACK.to_owned()
        } else {
            find.finder.label()
        };
        let (step, done) = (cx.weak_entity(), cx.weak_entity());
        Some(find_bar(
            &find.input,
            label,
            find.finder.total() > 0,
            Rc::new(move |back, window, cx| {
                step.update(cx, |this, cx| this.find_step(back, window, cx))
                    .ok();
            }),
            Rc::new(move |window, cx| {
                done.update(cx, |this, cx| this.close_find(window, cx)).ok();
            }),
            cx,
        ))
    }

    /// The accent rail beside the row with the picked match, held while the
    /// bar is up (a work link's light, without the fade).
    pub(crate) fn find_rail(&self, row_id: &str, cx: &App) -> Option<Div> {
        let picked = self.find.as_ref()?.picked_row()?;
        if picked != row_id {
            return None;
        }
        // A reply's words carry their own marks; the rail says which row.
        let accent = crate::style::control_accent(cx);
        let reply = matches!(
            self.feed.model().row(row_id).map(|r| &r.content),
            Some(RowContent::Assistant(_))
        );
        Some(
            div()
                .absolute()
                .inset_0()
                .rounded(px(6.))
                .when(!reply, |d| d.bg(accent.opacity(0.10)))
                .border_l(px(3.))
                .border_color(accent),
        )
    }
}
