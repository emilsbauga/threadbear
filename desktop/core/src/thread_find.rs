// Find in the open thread (⌘F over the transcript), with no UI in it: what
// each row says in words, where the words typed are among them, and which
// row has to open for a match to be seen. The bar itself is the file
// viewer's (desktop/gpui/src/file_find.rs), and the counting and stepping
// round are `find::Finder`'s, run over every row's words joined into one
// text.
//
// Matches folded away are found too: a step folded into a "Worked for"
// group, a tool's output, a thinking row's words. The app opens what's in the
// way when the bar gets to one (desktop/gpui/src/thread/find.rs).
use crate::find::{self, Finder};
use crate::reducer::{Row, RowContent};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::ops::Range;

/// Between two rows' words in the joined text: nobody types a NUL, so no
/// match runs from one row into the next.
const BETWEEN: &str = "\n\u{0}\n";

/// A match, as the transcript has to show it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    /// The row the words are in: its own row once nothing folds it away.
    pub row_id: String,
    /// The "Worked for" group it's in, to open first when that's closed.
    pub group: Option<String>,
    /// In what the row only shows opened: a tool's output, a thought.
    pub inside: bool,
    /// Which of its row's matches it is, from 0, for marking it in a reply.
    pub nth: usize,
    /// Its reply's parsed page, for a reply drawn from Markdown.
    pub doc_key: Option<String>,
}

/// One row's words in the joined text.
#[derive(Clone, Debug)]
struct Part {
    start: usize,
    end: usize,
    row_id: String,
    group: Option<String>,
    /// How much of the words the closed row shows (a tool's title); a
    /// match past it is `inside`. None when the row shows them all.
    shown: Option<usize>,
    doc_key: Option<String>,
}

/// A search over a thread's rows: the words, the matches and the one picked.
#[derive(Clone, Debug, Default)]
pub struct ThreadFinder {
    finder: Finder,
    text: String,
    parts: Vec<Part>,
    /// Each row's words by row id, with a hash of what they came from, so a
    /// reply streaming in doesn't parse every other reply's Markdown again.
    words: HashMap<String, (u64, String)>,
}

impl ThreadFinder {
    /// Takes in the rows as the transcript has them now (`rows`) and every
    /// item, folded or not (`items`), keeping the words typed and the match
    /// picked as near as there's one. Call `search` after it to find.
    pub fn index(&mut self, rows: &[Row], items: &[Row]) {
        let by_id: HashMap<&str, &Row> = items.iter().map(|r| (r.id.as_str(), r)).collect();
        // An open group's steps are rows after it, still in it.
        let mut group_of: HashMap<&str, &String> = HashMap::new();
        for row in rows {
            if let RowContent::Group(group) = &row.content {
                for member in &group.member_ids {
                    group_of.insert(member.as_str(), &row.id);
                }
            }
        }
        let mut text = String::new();
        let mut parts = Vec::new();
        let mut kept = HashMap::new();
        for row in rows {
            match &row.content {
                // A closed group's steps aren't rows: their words are found
                // under the group. An open one's follow it as rows.
                RowContent::Group(group) if !group.is_expanded => {
                    for member in &group.member_ids {
                        if let Some(item) = by_id.get(member.as_str()) {
                            self.add(item, Some(&row.id), &mut text, &mut parts, &mut kept);
                        }
                    }
                }
                _ => {
                    let group = group_of.get(row.id.as_str()).copied();
                    self.add(row, group, &mut text, &mut parts, &mut kept)
                }
            }
        }
        self.words = kept;
        self.text = text;
        self.parts = parts;
    }

    fn add(
        &self,
        row: &Row,
        group: Option<&String>,
        text: &mut String,
        parts: &mut Vec<Part>,
        kept: &mut HashMap<String, (u64, String)>,
    ) {
        let Some(source) = Source::of(row) else {
            return;
        };
        let hash = source.hash();
        let words = match self.words.get(&row.id) {
            Some((h, words)) if *h == hash => words.clone(),
            _ => source.words(),
        };
        if words.is_empty() {
            return;
        }
        if !text.is_empty() {
            text.push_str(BETWEEN);
        }
        let start = text.len();
        text.push_str(&words);
        parts.push(Part {
            start,
            end: text.len(),
            row_id: row.id.clone(),
            group: group.cloned(),
            shown: source.shown(),
            doc_key: source.doc_key(),
        });
        kept.insert(row.id.clone(), (hash, words));
    }

    /// Finds `query`, picking the first match in or after the row `from`
    /// (the one at the top of the view), round to the first if none is.
    pub fn search(&mut self, query: &str, from: Option<&str>) {
        let at = from
            .and_then(|id| self.parts.iter().find(|p| p.row_id == id))
            .map_or(0, |p| p.start);
        self.finder.search(&self.text, query, at);
    }

    /// The rows changed under the search (more of a reply, older pages, a
    /// group opened): the same words found again, keeping to the match
    /// picked when it's still there.
    pub fn refresh(&mut self, rows: &[Row], items: &[Row]) {
        let picked = self.current().map(|h| (h.row_id, h.nth));
        self.index(rows, items);
        let query = self.finder.query.clone();
        self.search(&query, picked.as_ref().map(|(id, _)| id.as_str()));
        if let Some((id, nth)) = picked {
            let found = (0..self.finder.matches.len())
                .find(|&i| self.hit(i).is_some_and(|h| h.row_id == id && h.nth == nth));
            if found.is_some() {
                self.finder.current = found;
            }
        }
    }

    pub fn query(&self) -> &str {
        &self.finder.query
    }

    pub fn total(&self) -> usize {
        self.finder.matches.len()
    }

    /// The match picked, as the transcript has to show it.
    pub fn current(&self) -> Option<Hit> {
        self.hit(self.finder.current?)
    }

    /// ⌘G, Return, ›: the next match, round to the first after the last.
    pub fn next_match(&mut self) -> Option<Hit> {
        self.finder.next_match();
        self.current()
    }

    /// ⇧⌘G, Shift-Return, ‹: the one before, round to the last.
    pub fn previous_match(&mut self) -> Option<Hit> {
        self.finder.previous_match();
        self.current()
    }

    /// The picked match is the first, so going back goes round to the last.
    pub fn at_first(&self) -> bool {
        self.finder.current == Some(0)
    }

    /// The replies with matches, by their parsed page, for marking them.
    pub fn replies_found(&self) -> HashSet<&str> {
        self.finder
            .matches
            .iter()
            .filter_map(|m| self.part_at(m.start)?.doc_key.as_deref())
            .collect()
    }

    /// Picks the last match, the newest: where a search starts with the
    /// view at the end of the thread.
    pub fn pick_last(&mut self) {
        self.finder.current = self.finder.matches.len().checked_sub(1);
    }

    /// "3 of 8", "Not found", or nothing before anything's typed.
    pub fn label(&self) -> String {
        self.finder.label()
    }

    /// The dump's line: "the: 3 of 8", "the: not found".
    pub fn dump_line(&self) -> String {
        find::dump_line(
            &self.finder.query,
            self.finder.current,
            self.finder.matches.len(),
        )
    }

    fn part_at(&self, at: usize) -> Option<&Part> {
        let i = self
            .parts
            .partition_point(|p| p.start <= at)
            .checked_sub(1)?;
        self.parts.get(i).filter(|p| at < p.end)
    }

    fn hit(&self, index: usize) -> Option<Hit> {
        let range: Range<usize> = self.finder.matches.get(index)?.clone();
        let part = self.part_at(range.start)?;
        let nth = self.finder.matches[..index]
            .iter()
            .rev()
            .take_while(|m| m.start >= part.start)
            .count();
        Some(Hit {
            row_id: part.row_id.clone(),
            group: part.group.clone(),
            inside: part
                .shown
                .is_some_and(|shown| range.end > part.start + shown),
            nth,
            doc_key: part.doc_key.clone(),
        })
    }
}

/// What a row says, before it's turned into words.
enum Source<'a> {
    /// Words shown as they are.
    Plain(&'a str),
    /// A reply or a thought, drawn from Markdown: its words without the
    /// marks. `doc_key` is its parsed page, `folded` when a closed row
    /// hides them.
    Markdown {
        text: &'a str,
        doc_key: Option<&'a str>,
        folded: bool,
    },
    /// A tool's line, and the output it opens to.
    Tool { title: String, output: &'a str },
}

impl<'a> Source<'a> {
    fn of(row: &'a Row) -> Option<Self> {
        Some(match &row.content {
            RowContent::User(message) => Source::Plain(&message.text),
            RowContent::Assistant(item) => Source::Markdown {
                text: &item.text,
                doc_key: Some(&item.item_id),
                folded: false,
            },
            RowContent::Reasoning(item) => Source::Markdown {
                text: &item.text,
                doc_key: None,
                folded: true,
            },
            RowContent::Tool(tool) => Source::Tool {
                title: tool.title(),
                output: match &tool.result {
                    Some(result) => &result.text,
                    None => &tool.live_output,
                },
            },
            RowContent::Note(note) => Source::Plain(note),
            RowContent::Error { message, .. } => Source::Plain(message),
            _ => return None,
        })
    }

    fn hash(&self) -> u64 {
        let mut h = DefaultHasher::new();
        match self {
            Source::Plain(text) => text.hash(&mut h),
            Source::Markdown { text, .. } => text.hash(&mut h),
            Source::Tool { title, output } => (title, output).hash(&mut h),
        }
        h.finish()
    }

    fn words(&self) -> String {
        match self {
            Source::Plain(text) => (*text).to_owned(),
            Source::Markdown { text, .. } => markdown_words(text),
            Source::Tool { title, output: "" } => title.clone(),
            Source::Tool { title, output } => format!("{title}\n{output}"),
        }
    }

    fn shown(&self) -> Option<usize> {
        match self {
            Source::Tool { title, .. } => Some(title.len()),
            Source::Markdown { folded: true, .. } => Some(0),
            _ => None,
        }
    }

    fn doc_key(&self) -> Option<String> {
        match self {
            Source::Markdown { doc_key, .. } => doc_key.map(str::to_owned),
            _ => None,
        }
    }
}

/// A reply's words as it's drawn: no `**`, `#` or link addresses, a line
/// between blocks, code as it is.
pub fn markdown_words(text: &str) -> String {
    let Ok(tree) = markdown::to_mdast(text, &markdown::ParseOptions::gfm()) else {
        return text.to_owned();
    };
    let mut out = String::new();
    collect(&tree, &mut out);
    out.trim_end().to_owned()
}

fn collect(node: &markdown::mdast::Node, out: &mut String) {
    use markdown::mdast::Node;
    match node {
        Node::Text(t) => out.push_str(&t.value),
        Node::InlineCode(c) => out.push_str(&c.value),
        Node::InlineMath(m) => out.push_str(&m.value),
        Node::Code(c) => {
            out.push_str(&c.value);
            out.push('\n');
        }
        Node::Math(m) => {
            out.push_str(&m.value);
            out.push('\n');
        }
        Node::Break(_) => out.push('\n'),
        Node::Html(_) | Node::Image(_) | Node::Definition(_) => {}
        other => {
            for child in other.children().into_iter().flatten() {
                collect(child, out);
            }
            let block = matches!(
                other,
                Node::Paragraph(_)
                    | Node::Heading(_)
                    | Node::ListItem(_)
                    | Node::TableRow(_)
                    | Node::Blockquote(_)
                    | Node::ThematicBreak(_)
            );
            if block && !out.ends_with('\n') {
                out.push('\n');
            } else if matches!(other, Node::TableCell(_)) {
                out.push('\t');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reducer::{TextItem, ToolItem, ToolResult, UserMessage, WorkGroup};

    fn reply(id: &str, text: &str) -> Row {
        Row::new(
            id,
            1,
            None,
            RowContent::Assistant(TextItem {
                item_id: id.to_owned(),
                text: text.to_owned(),
                ..Default::default()
            }),
        )
    }

    fn mine(id: &str, text: &str) -> Row {
        Row::new(
            id,
            1,
            None,
            RowContent::User(UserMessage {
                text: text.to_owned(),
                ..Default::default()
            }),
        )
    }

    fn tool(id: &str, title: &str, output: &str) -> Row {
        let mut item = ToolItem {
            item_id: id.to_owned(),
            ..Default::default()
        };
        item.call = Some(crate::reducer::event::ToolCall::new(
            id,
            "Bash",
            Default::default(),
            title,
            serde_json::Value::Null,
        ));
        item.result = Some(ToolResult::new(id, true, output));
        Row::new(id, 1, None, RowContent::Tool(item))
    }

    fn group(id: &str, members: &[&str], open: bool) -> Row {
        Row::new(
            id,
            1,
            None,
            RowContent::Group(WorkGroup {
                member_ids: members.iter().map(|m| (*m).to_owned()).collect(),
                summary: "Ran 2 commands".into(),
                failed_count: 0,
                is_expanded: open,
                is_live: false,
                current_action: None,
            }),
        )
    }

    #[test]
    fn a_reply_is_searched_as_its_words_not_its_marks() {
        assert_eq!(
            markdown_words("## The **upload**\n\nIt [stalls](https://x.dev/stalls) at `90%`."),
            "The upload\nIt stalls at 90%."
        );
        let mut f = ThreadFinder::default();
        let rows = [reply("r1", "See [the docs](https://example.com/docs)")];
        f.index(&rows, &rows);
        f.search("example", None);
        assert_eq!(f.label(), "Not found", "a link's address isn't drawn");
        f.search("THE DOCS", None);
        assert_eq!(f.label(), "1 of 1");
    }

    #[test]
    fn counts_and_steps_round_across_rows() {
        let rows = [
            mine("m1", "Why does the upload stall?"),
            reply("r1", "The upload stalls at 90%, then the upload retries."),
        ];
        let mut f = ThreadFinder::default();
        f.index(&rows, &rows);
        f.search("upload", None);
        assert_eq!(f.dump_line(), "upload: 1 of 3");
        assert_eq!(f.current().map(|h| h.row_id), Some("m1".into()));
        let second = f.next_match().unwrap();
        assert_eq!((second.row_id.as_str(), second.nth), ("r1", 0));
        assert_eq!(second.doc_key.as_deref(), Some("r1"));
        assert_eq!(f.next_match().map(|h| h.nth), Some(1));
        assert_eq!(
            f.next_match().map(|h| h.row_id),
            Some("m1".into()),
            "round to the first"
        );
        assert!(f.at_first());
        assert_eq!(
            f.previous_match().map(|h| h.nth),
            Some(1),
            "and back to the last"
        );
        assert_eq!(f.replies_found(), HashSet::from(["r1"]));
        f.pick_last();
        assert_eq!(f.label(), "3 of 3");
    }

    #[test]
    fn a_search_starts_from_the_row_at_the_top_of_the_view() {
        let rows = [mine("m1", "upload"), mine("m2", "upload again")];
        let mut f = ThreadFinder::default();
        f.index(&rows, &rows);
        f.search("upload", Some("m2"));
        assert_eq!(f.label(), "2 of 2");
    }

    #[test]
    fn no_match_runs_from_one_row_into_the_next() {
        let rows = [mine("m1", "abc"), mine("m2", "def")];
        let mut f = ThreadFinder::default();
        f.index(&rows, &rows);
        f.search("c\nd", None);
        assert_eq!(f.total(), 0);
    }

    #[test]
    fn matches_in_a_closed_group_or_a_tools_output_say_what_to_open() {
        let t1 = tool("t1", "npm test", "3 failing: upload.test.ts");
        let t2 = tool("t2", "grep upload", "");
        let closed = group("g:t1", &["t1", "t2"], false);
        let items = [t1.clone(), t2.clone()];
        let mut f = ThreadFinder::default();
        f.index(std::slice::from_ref(&closed), &items);
        f.search("upload", None);
        assert_eq!(f.total(), 2);
        let hit = f.current().unwrap();
        assert_eq!(hit.row_id, "t1");
        assert_eq!(hit.group.as_deref(), Some("g:t1"));
        assert!(hit.inside, "in its output, so the tool row opens");
        let title = f.next_match().unwrap();
        assert_eq!(title.row_id, "t2");
        assert!(!title.inside, "its title shows on the closed line");

        // Opened, the group's steps are rows of their own.
        let open = [group("g:t1", &["t1", "t2"], true), t1, t2];
        f.refresh(&open, &items);
        let hit = f.current().unwrap();
        assert_eq!(hit.row_id, "t2", "kept to the match picked");
        assert_eq!(
            hit.group.as_deref(),
            Some("g:t1"),
            "still in the group, open now"
        );
    }

    #[test]
    fn a_thought_opens_to_show_its_match() {
        let thought = Row::new(
            "th1",
            1,
            None,
            RowContent::Reasoning(TextItem {
                item_id: "th1".into(),
                text: "Maybe the **upload** times out".into(),
                ..Default::default()
            }),
        );
        let rows = [thought];
        let mut f = ThreadFinder::default();
        f.index(&rows, &rows);
        f.search("upload", None);
        let hit = f.current().unwrap();
        assert!(hit.inside);
        assert_eq!(
            hit.doc_key, None,
            "a thought isn't drawn from a parsed page"
        );
    }
}
