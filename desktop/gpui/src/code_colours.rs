//! The transcript's code blocks, coloured off the main thread.
//!
//! Syntect (with its pure-Rust regexes) takes about 60 ms to colour a 40-line
//! TypeScript block. Coloured during layout, that was a 60 ms frame each time
//! a reply with code scrolled into view: the stutter Mike saw scrolling on 24
//! Nov, the day code fences got their colours (long-thread.ts on Tinker Desk:
//! worst frame 3.5 ms plain, 60 ms coloured). So a block is drawn plain until
//! its colours are worked out on the background executor, then the windows
//! are drawn again with them. Colours are kept by theme, language and text, so
//! a block that scrolls away and back, or is in another thread, isn't done
//! twice.
//!
//! A block still waiting asks again every frame it's drawn (the kit doesn't
//! keep an empty answer), so the queue can drop what it likes: it keeps the
//! newest few and colours newest first. A fling past fifty replies, or a fence
//! growing word by word as it streams, doesn't leave the block on screen
//! waiting behind ones long gone (Codex and Gemini's review, 24 Nov).

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::channel::mpsc::{unbounded, UnboundedSender};
use futures::StreamExt as _;
use gpui_kit::base::text::CodeBlock;
use gpui_kit::component::highlighter::HighlightTheme;
use gpui_kit::component::text::{shared_code_block_highlighter, SharedCodeBlockHighlighter};
use gpui_kit::{App, HighlightStyle};

type Styles = Vec<(Range<usize>, HighlightStyle)>;
/// The theme's own number (never reused, unlike its address) and a hash of
/// the block's language and text.
type Key = (u64, u64);

/// About a long day's worth of code blocks; each is a short list of ranges.
const KEPT: usize = 4000;
/// Jobs waiting at most; older ones are dropped and asked for again if
/// they're still on screen.
const QUEUED: usize = 32;
/// The windows are drawn again at most this often while colours come in, as
/// a refresh draws every view afresh, cached ones too.
const REDRAW_EVERY: Duration = Duration::from_millis(100);

struct Job {
    key: Key,
    lang: String,
    code: String,
    colour: Arc<SharedCodeBlockHighlighter>,
}

#[derive(Default)]
struct Store {
    done: HashMap<Key, Arc<Styles>>,
    order: VecDeque<Key>,
    asked: HashSet<Key>,
    /// Oldest first; taken from the back.
    queue: VecDeque<Job>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Mutex::default);
/// Wakes the colouring loop; none, or closed, until one is running.
static WAKE: Mutex<Option<UnboundedSender<()>>> = Mutex::new(None);
static THEMES: AtomicU64 = AtomicU64::new(1);

fn store() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The highlighter for `theme`: the same `Arc` every time for a theme, as the
/// kit takes a new one as a reflow and keeps the old selection through it
/// (rows.rs, `code_blocks`).
pub(crate) fn highlighter(
    theme: &Arc<HighlightTheme>,
    cx: &App,
) -> Arc<SharedCodeBlockHighlighter> {
    start(cx);
    thread_local! {
        static MADE: std::cell::RefCell<Vec<(Arc<HighlightTheme>, Arc<SharedCodeBlockHighlighter>)>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }
    MADE.with(|made| {
        let mut made = made.borrow_mut();
        if let Some((_, h)) = made.iter().find(|(t, _)| Arc::ptr_eq(t, theme)) {
            return h.clone();
        }
        let colour = shared_code_block_highlighter(theme);
        let theme_id = THEMES.fetch_add(1, Ordering::Relaxed);
        let h: Arc<SharedCodeBlockHighlighter> =
            Arc::new(move |block: &CodeBlock| lookup(theme_id, &colour, block));
        if made.len() == 4 {
            made.remove(0);
        }
        made.push((theme.clone(), h.clone()));
        h
    })
}

/// A block's colours if they're ready; otherwise none, and they're asked for.
fn lookup(theme_id: u64, colour: &Arc<SharedCodeBlockHighlighter>, block: &CodeBlock) -> Styles {
    let Some(lang) = block.lang() else {
        return Vec::new();
    };
    let code = block.code();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    lang.as_ref().hash(&mut hasher);
    code.as_ref().hash(&mut hasher);
    let key = (theme_id, hasher.finish());
    let mut store = store();
    if let Some(styles) = store.done.get(&key).cloned() {
        drop(store);
        return (*styles).clone();
    }
    if store.asked.insert(key) {
        // One wake per empty queue: the loop runs until it's empty again.
        let was_idle = store.queue.is_empty();
        store.queue.push_back(Job {
            key,
            lang: lang.to_string(),
            code: code.to_string(),
            colour: colour.clone(),
        });
        while store.queue.len() > QUEUED {
            if let Some(old) = store.queue.pop_front() {
                store.asked.remove(&old.key);
            }
        }
        drop(store);
        if was_idle {
            if let Some(wake) = WAKE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let _ = wake.unbounded_send(());
            }
        }
    }
    Vec::new()
}

/// Starts the loop that colours what's asked for, unless one is running.
/// Started again if it ever stops (its app gone, as in tests).
fn start(cx: &App) {
    let mut wake = WAKE.lock().unwrap_or_else(|e| e.into_inner());
    if wake.as_ref().is_some_and(|w| !w.is_closed()) {
        return;
    }
    let (tx, mut rx) = unbounded::<()>();
    // Whatever was asked of a loop that stopped is asked again, and what it
    // was colouring when it stopped is forgotten, so it's asked for anew.
    {
        let mut store = store();
        let queued: HashSet<Key> = store.queue.iter().map(|j| j.key).collect();
        store.asked = queued;
    }
    let _ = tx.unbounded_send(());
    *wake = Some(tx);
    drop(wake);
    cx.spawn(async move |cx| {
        let mut redrawn = Instant::now();
        let mut owed = false;
        loop {
            let job = {
                let mut store = store();
                let job = store.queue.pop_back();
                // A fence that streamed in left a job for each length it
                // had; the newest covers them all.
                if let Some(job) = &job {
                    let mut dropped = Vec::new();
                    store.queue.retain(|older| {
                        let stale = older.lang == job.lang && job.code.starts_with(&older.code);
                        if stale {
                            dropped.push(older.key);
                        }
                        !stale
                    });
                    for key in dropped {
                        store.asked.remove(&key);
                    }
                }
                job
            };
            let Some(job) = job else {
                if owed {
                    let since = redrawn.elapsed();
                    if since < REDRAW_EVERY {
                        cx.background_executor().timer(REDRAW_EVERY - since).await;
                        if !store().queue.is_empty() {
                            continue;
                        }
                    }
                    owed = false;
                    redrawn = Instant::now();
                    cx.update(|cx| cx.refresh_windows());
                }
                if rx.next().await.is_none() {
                    return;
                }
                continue;
            };
            let key = job.key;
            let styles = cx
                .background_executor()
                .spawn(async move {
                    // A grammar that panics on some text leaves that block
                    // plain, not every block after it.
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let block = CodeBlock::from_code(job.code, Some(job.lang));
                        (job.colour)(&block)
                    }))
                    .unwrap_or_default()
                })
                .await;
            // Nothing to show is nothing to draw again for.
            owed |= !styles.is_empty();
            {
                let mut store = store();
                if store.done.insert(key, Arc::new(styles)).is_none() {
                    store.order.push_back(key);
                }
                store.asked.remove(&key);
                while store.order.len() > KEPT {
                    if let Some(old) = store.order.pop_front() {
                        store.done.remove(&old);
                    }
                }
            }
            if owed && redrawn.elapsed() >= REDRAW_EVERY {
                owed = false;
                redrawn = Instant::now();
                cx.update(|cx| cx.refresh_windows());
            }
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not ready the first time, so layout never waits on syntect, and asked
    /// for once however many frames draw it before it's done.
    #[test]
    fn a_block_waits_plain_and_the_queue_keeps_the_newest() {
        let theme = HighlightTheme::default_dark();
        let colour = shared_code_block_highlighter(&theme);
        let block = CodeBlock::from_code("const a = 1; // asked once", Some("ts"));
        let id = THEMES.fetch_add(1, Ordering::Relaxed);
        let queued = || {
            store()
                .queue
                .iter()
                .filter(|j| j.code.contains("// asked once"))
                .count()
        };
        assert!(lookup(id, &colour, &block).is_empty());
        assert_eq!(queued(), 1);
        assert!(lookup(id, &colour, &block).is_empty());
        assert_eq!(queued(), 1);

        // The queue keeps the newest few (one test, as the store is the
        // process's); a dropped block is asked for again when next drawn.
        let first = CodeBlock::from_code("let first = 0; // newest test", Some("ts"));
        lookup(id, &colour, &first);
        for n in 0..QUEUED {
            lookup(
                id,
                &colour,
                &CodeBlock::from_code(format!("let n = {n}; // newest test"), Some("ts")),
            );
        }
        let has_first = || {
            store()
                .queue
                .iter()
                .any(|j| j.code.starts_with("let first"))
        };
        assert!(!has_first());
        assert!(store().queue.len() <= QUEUED);
        lookup(id, &colour, &first);
        assert!(has_first());
    }
}
