// The # thread picker's rules: typing # at the start of a word in the message
// box lists the other threads, narrowed by what's typed after it, and picking
// one puts a link to it, `[title](thread:<id>)`, where the #word was. The box
// draws that link as the thread's chip, as a pasted id is
// (inline_chips::thread_reference), and the agent reads the thread from it.
// The GPUI picker is desktop/gpui/src/thread_palette.rs; its keys are the
// slash palette's (slash::PaletteKey).
use crate::composer::PICTURE_MARK;
use crate::inbox::{folder_name, ThreadSummary};
use crate::slash::PaletteKey;
use std::sync::Arc;

/// The most threads the picker lists.
pub const MAX_ROWS: usize = 50;

/// A row's height: the title over its folder.
pub const ROW_HEIGHT: f64 = 46.;

/// The "#word" being typed just before the cursor: where its # is (a byte
/// offset into the text) and what's typed after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Typed {
    pub start: usize,
    pub query: String,
}

/// The "#word" just before `cursor` (a byte offset): a # at the start or
/// after a space or line break, then nothing up to the cursor that ends a
/// word. None for "a#b", "##", a URL's "/#part", and once a space follows
/// (so a Markdown heading, "# Title", doesn't open it).
pub fn typed(text: &str, cursor: usize) -> Option<Typed> {
    if cursor == 0 || cursor > text.len() || !text.is_char_boundary(cursor) {
        return None;
    }
    let before = &text[..cursor];
    let (start, _) = before
        .char_indices()
        .rev()
        .find(|(_, c)| ends_word(*c))
        .filter(|(_, c)| *c == '#')?;
    if before[..start]
        .chars()
        .next_back()
        .is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    Some(Typed {
        start,
        query: before[start + 1..].to_owned(),
    })
}

/// What can't be in the word after the #: a space, a picture, a chip's link
/// (its brackets), or a second #.
fn ends_word(c: char) -> bool {
    c.is_whitespace() || matches!(c, '#' | '[' | ']' | '(' | ')' | PICTURE_MARK)
}

/// The title a row shows: the thread's on one line.
pub fn shown_title(thread: &ThreadSummary) -> String {
    let title = thread
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        "Untitled".to_owned()
    } else {
        title
    }
}

/// The threads to offer for `query`: not `current` (the box's own thread),
/// and archived ones only once something's typed, after the rest. Latest
/// first, at most `MAX_ROWS`. A thread matches when its title or folder has
/// what's typed in it, whatever the case, or its id starts with it.
pub fn matches(
    threads: &[Arc<ThreadSummary>],
    query: &str,
    current: Option<&str>,
) -> Vec<Arc<ThreadSummary>> {
    let query = query.to_lowercase();
    let mut found: Vec<Arc<ThreadSummary>> = threads
        .iter()
        .filter(|t| Some(t.id.as_str()) != current)
        .filter(|t| !query.is_empty() || t.archived_at.is_none())
        .filter(|t| {
            query.is_empty()
                || t.id.to_lowercase().starts_with(&query)
                || t.title.to_lowercase().contains(&query)
                || folder_name(&t.cwd).to_lowercase().contains(&query)
        })
        .cloned()
        .collect();
    found.sort_by(|a, b| {
        a.archived_at
            .is_some()
            .cmp(&b.archived_at.is_some())
            .then_with(|| b.last_activity_at.cmp(&a.last_activity_at))
    });
    found.truncate(MAX_ROWS);
    found
}

/// What the composer keeps for its # picker: the thread the arrows are on,
/// and the text Esc closed it at (closed until the text changes).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PickerState {
    pub selected: Option<String>,
    pub closed_at: Option<String>,
}

/// The thread Return would pick: the one the arrows are on if it's still
/// listed, else the first.
pub fn picked<'a>(
    matches: &'a [Arc<ThreadSummary>],
    state: &PickerState,
) -> Option<&'a Arc<ThreadSummary>> {
    matches
        .iter()
        .find(|t| state.selected.as_deref() == Some(t.id.as_str()))
        .or_else(|| matches.first())
}

/// What a key does: Up and Down move the pick, Esc closes the picker at
/// `text`, and Return or Tab give the thread to put in.
pub fn handle_key(
    key: PaletteKey,
    matches: &[Arc<ThreadSummary>],
    state: &mut PickerState,
    text: &str,
) -> Option<Arc<ThreadSummary>> {
    let index = matches
        .iter()
        .position(|t| state.selected.as_deref() == Some(t.id.as_str()))
        .unwrap_or(0);
    let mut select = |i: usize| {
        if let Some(t) = matches.get(i) {
            state.selected = Some(t.id.clone());
        }
    };
    match key {
        PaletteKey::Up => select(index.saturating_sub(1)),
        PaletteKey::Down => select((index + 1).min(matches.len().saturating_sub(1))),
        PaletteKey::Escape => state.closed_at = Some(text.to_owned()),
        PaletteKey::Tab | PaletteKey::Enter => return matches.get(index).cloned(),
    }
    None
}

/// What goes in the message for a picked thread: its link with its title,
/// and a space to carry on typing after it.
pub fn reference(thread: &ThreadSummary) -> String {
    crate::inline_chips::thread_reference(&thread.id, &thread.title) + " "
}

/// The picker's height for `rows` threads in a window `window` tall: as tall
/// as its rows, at most about half the window.
pub fn height(rows: usize, window: f64) -> f64 {
    let rows = rows as f64 * ROW_HEIGHT + 12.;
    rows.min(crate::slash::palette_height(window, 160., 560.))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, title: &str, cwd: &str, at: &str) -> Arc<ThreadSummary> {
        Arc::new(ThreadSummary {
            id: id.into(),
            title: title.into(),
            cwd: cwd.into(),
            last_activity_at: at.into(),
            ..Default::default()
        })
    }

    fn ids(found: &[Arc<ThreadSummary>]) -> Vec<&str> {
        found.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn a_hash_at_the_start_of_a_word_opens_it() {
        let at = |start, query: &str| {
            Some(Typed {
                start,
                query: query.into(),
            })
        };
        assert_eq!(typed("#", 1), at(0, ""));
        assert_eq!(typed("see #ware", 9), at(4, "ware"));
        assert_eq!(typed("one\n#two", 8), at(4, "two"), "after a line break");
        assert_eq!(
            typed("see #ware and more", 9),
            at(4, "ware"),
            "at the cursor"
        );
        assert_eq!(typed("é #x", 5), at(3, "x"), "bytes, as the box counts");
        assert_eq!(typed("a#b", 3), None, "inside a word");
        assert_eq!(typed("# Heading", 9), None, "a space ends it");
        assert_eq!(typed("#one two", 8), None);
        assert_eq!(typed("##", 2), None);
        assert_eq!(typed("https://x.dev/#part", 19), None);
        assert_eq!(typed("no hash", 7), None);
        assert_eq!(typed("#ab", 0), None);
        assert_eq!(typed("#ab", 9), None, "past the end");
        assert_eq!(typed("#é", 2), None, "not on a character's edge");
        // A chip's link right before it, or a picture, isn't a word start.
        assert_eq!(typed("[Fix #1](thread:a)", 18), None);
        assert_eq!(typed("\u{FFFC}#x", 5), None);
    }

    #[test]
    fn matches_by_title_folder_or_id_latest_first() {
        let all = vec![
            thread("aaa-1", "Fix deploy", "/r/warehouse", "2026-11-01"),
            thread("bbb-2", "Storage plan", "/r/warehouse/", "2026-11-03"),
            thread("ccc-3", "Picker", "/Users/t/threadbear", "2026-11-02"),
        ];
        assert_eq!(ids(&matches(&all, "", None)), ["bbb-2", "ccc-3", "aaa-1"]);
        assert_eq!(
            ids(&matches(&all, "", Some("bbb-2"))),
            ["ccc-3", "aaa-1"],
            "not the box's own thread"
        );
        assert_eq!(ids(&matches(&all, "WARE", None)), ["bbb-2", "aaa-1"]);
        assert_eq!(ids(&matches(&all, "deploy", None)), ["aaa-1"]);
        assert_eq!(ids(&matches(&all, "ccc", None)), ["ccc-3"]);
        assert_eq!(
            ids(&matches(&all, "-3", None)),
            Vec::<&str>::new(),
            "an id by its start only"
        );
        assert!(matches(&all, "zzz", None).is_empty());
    }

    #[test]
    fn archived_threads_only_once_something_is_typed_and_after_the_rest() {
        let mut old = (*thread("old", "Picker old", "/x", "2026-11-09")).clone();
        old.archived_at = Some("2026-11-10".into());
        let all = vec![
            Arc::new(old),
            thread("new", "Picker new", "/x", "2026-11-01"),
        ];
        assert_eq!(ids(&matches(&all, "", None)), ["new"]);
        assert_eq!(ids(&matches(&all, "picker", None)), ["new", "old"]);
    }

    #[test]
    fn at_most_max_rows() {
        let all: Vec<_> = (0..MAX_ROWS + 5)
            .map(|i| thread(&format!("t{i}"), "x", "/x", &format!("{i:03}")))
            .collect();
        assert_eq!(matches(&all, "", None).len(), MAX_ROWS);
    }

    #[test]
    fn keys_move_the_pick_and_return_picks_it() {
        let all = vec![thread("a", "A", "/x", "3"), thread("b", "B", "/x", "2")];
        let mut state = PickerState::default();
        assert_eq!(picked(&all, &state).map(|t| t.id.as_str()), Some("a"));
        assert_eq!(handle_key(PaletteKey::Up, &all, &mut state, ""), None);
        assert_eq!(state.selected.as_deref(), Some("a"), "stays at the top");
        assert_eq!(handle_key(PaletteKey::Down, &all, &mut state, ""), None);
        assert_eq!(handle_key(PaletteKey::Down, &all, &mut state, ""), None);
        assert_eq!(state.selected.as_deref(), Some("b"), "stays at the bottom");
        assert_eq!(picked(&all, &state).map(|t| t.id.as_str()), Some("b"));
        let enter = handle_key(PaletteKey::Enter, &all, &mut state, "");
        assert_eq!(enter.map(|t| t.id.clone()).as_deref(), Some("b"));
        let tab = handle_key(PaletteKey::Tab, &all, &mut state, "");
        assert_eq!(tab.map(|t| t.id.clone()).as_deref(), Some("b"));
        assert_eq!(handle_key(PaletteKey::Escape, &all, &mut state, "#x"), None);
        assert_eq!(state.closed_at.as_deref(), Some("#x"));
        // A pick no longer listed falls back to the first.
        state.selected = Some("gone".into());
        assert_eq!(picked(&all, &state).map(|t| t.id.as_str()), Some("a"));
    }

    #[test]
    fn a_pick_goes_in_as_a_titled_link_the_box_draws_as_a_chip() {
        let t = thread("abc-1", "Fix [the]\ndeploy", "/x", "1");
        assert_eq!(reference(&t), "[Fix \\[the\\] deploy](thread:abc-1) ");
        assert!(crate::inline_chips::has_mentions(&reference(&t)));
        assert_eq!(shown_title(&t), "Fix [the] deploy");
        assert_eq!(shown_title(&thread("x", "  ", "/x", "1")), "Untitled");
    }

    #[test]
    fn as_tall_as_its_rows_up_to_half_the_window() {
        assert!(height(1, 1000.) < height(3, 1000.));
        assert_eq!(height(50, 1000.), 500.);
        assert!(height(50, 200.) >= 160., "never squashed to nothing");
    }
}
