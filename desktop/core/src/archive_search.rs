// Agent Archive in the sidebar's search (the `archive` experiment,
// runner/src/experiments/archive.md; docs/protocol/threads.md, "Searching
// Agent Archive"): after the app's own threads, the archive's sessions with
// the words, from every agent and machine and from before Threadbear. One
// opens read-only in the thread's place. What's here has no window in it:
// reading the runner's answers, which hits to show, where the words are in a
// line, and the lines under a hit and over its page.
use crate::find::find_all;
use chrono::{DateTime, Datelike as _, TimeZone};
use serde_json::Value;
use std::collections::HashSet;
use std::ops::Range;

/// The experiment's id in hello's `experiments`.
pub const EXPERIMENT: &str = "archive";
/// The fewest characters a search needs before the archive is asked:
/// fewer match half of everything ever said.
pub const MIN_CHARS: usize = 3;
/// How long typing has to pause before the archive is asked.
pub const PAUSE_MS: u64 = 400;
/// How many sessions a search asks for.
pub const LIMIT: usize = 20;
/// How many messages of a session its page asks for, around the match.
pub const READ_LIMIT: usize = 80;

/// The Threadbear thread an archived session belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub thread_id: String,
    pub title: String,
}

/// One archived session with the words (`ArchiveHit`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub thread_id: String,
    pub title: String,
    pub agent: String,
    pub folder: Option<String>,
    pub machine: Option<String>,
    pub updated_at: i64,
    pub sequence: i64,
    pub snippet: String,
    pub threadbear: Option<Linked>,
}

/// A search's answer for its words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Results {
    pub query: String,
    pub hits: Vec<Hit>,
    pub more: bool,
}

/// What a search came back with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Found(Results),
    /// The archive isn't on for this runner (`off`, or a runner from before
    /// that doesn't know the method): nothing is shown for it.
    Off,
}

/// The session a page shows (`ArchiveThread`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub thread_id: String,
    pub title: String,
    pub agent: String,
    pub folder: Option<String>,
    pub machine: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    pub messages: i64,
    pub url: Option<String>,
    pub threadbear: Option<Linked>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One message of a session (`ArchiveItem`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub sequence: i64,
    pub role: Role,
    pub text: String,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn number(v: &Value, key: &str) -> Option<i64> {
    v[key]
        .as_i64()
        .or_else(|| v[key].as_f64().map(|f| f as i64))
}

fn linked(v: &Value) -> Option<Linked> {
    let thread_id = text(v, "threadId")?;
    Some(Linked {
        title: text(v, "title").unwrap_or_else(|| "Untitled".to_owned()),
        thread_id,
    })
}

impl Hit {
    /// A hit as the runner sends it. One without an id is left out; anything
    /// else missing has a fallback, as both sides read leniently.
    pub fn decode(v: &Value) -> Option<Self> {
        Some(Self {
            thread_id: text(v, "threadId")?,
            title: text(v, "title").unwrap_or_else(|| "Untitled".to_owned()),
            agent: text(v, "agent").unwrap_or_default(),
            folder: text(v, "folder"),
            machine: text(v, "machine"),
            updated_at: number(v, "updatedAt").unwrap_or(0),
            sequence: number(v, "sequence").unwrap_or(0),
            // One line, whatever it came as.
            snippet: v["snippet"]
                .as_str()
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            threadbear: linked(&v["threadbear"]),
        })
    }
}

/// `archive.search`'s answer for `query`.
pub fn decode_search(query: &str, v: &Value) -> Answer {
    if v.get("off").is_some_and(|o| !o.is_null()) {
        return Answer::Off;
    }
    let hits = v["hits"]
        .as_array()
        .map(|a| a.iter().filter_map(Hit::decode).collect())
        .unwrap_or_default();
    Answer::Found(Results {
        query: query.to_owned(),
        hits,
        more: v["more"].as_bool() == Some(true),
    })
}

/// `archive.read`'s answer: the session and its messages in order. None
/// when there's no session in it.
pub fn decode_read(v: &Value) -> Option<(Session, Vec<Item>)> {
    let t = &v["thread"];
    let session = Session {
        thread_id: text(t, "threadId")?,
        title: text(t, "title").unwrap_or_else(|| "Untitled".to_owned()),
        agent: text(t, "agent").unwrap_or_default(),
        folder: text(t, "folder"),
        machine: text(t, "machine"),
        created_at: number(t, "createdAt"),
        updated_at: number(t, "updatedAt").unwrap_or(0),
        messages: number(t, "messages").unwrap_or(0),
        url: text(t, "url").filter(|u| u.starts_with("https://") || u.starts_with("http://")),
        threadbear: linked(&t["threadbear"]),
    };
    let mut items: Vec<Item> = v["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    let role = match i["role"].as_str()? {
                        "user" => Role::User,
                        "assistant" => Role::Assistant,
                        _ => return None,
                    };
                    let text = i["text"].as_str()?.to_owned();
                    (!text.trim().is_empty()).then(|| Item {
                        sequence: number(i, "sequence").unwrap_or(0),
                        role,
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by_key(|i| i.sequence);
    Some((session, items))
}

/// The message a hit found, among a page's: the one at its sequence, or as
/// a hit can be a tool call or its result, which a page leaves out, the
/// nearest before it, else the first after.
pub fn found_index(items: &[Item], sequence: i64) -> Option<usize> {
    items
        .iter()
        .rposition(|i| i.sequence <= sequence)
        .or_else(|| (!items.is_empty()).then_some(0))
}

/// Whether these words are enough to ask the archive.
pub fn searchable(query: &str) -> bool {
    query.trim().chars().count() >= MIN_CHARS
}

/// The words of a search, as marked in what it found: each word on its own,
/// without quotes or the punctuation round it, single letters left out.
pub fn words(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in query.split_whitespace() {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric());
        if w.chars().count() < 2 {
            continue;
        }
        let lower = w.to_lowercase();
        if !out.iter().any(|o| o.to_lowercase() == lower) {
            out.push(w.to_owned());
        }
    }
    out
}

/// Where a search's words are in `text`, as byte ranges left to right, any
/// that overlap joined. Case doesn't matter.
pub fn marks(text: &str, query: &str) -> Vec<Range<usize>> {
    let mut all: Vec<Range<usize>> = words(query)
        .iter()
        .flat_map(|w| find_all(text, w))
        .collect();
    all.sort_by_key(|r| (r.start, r.end));
    let mut out: Vec<Range<usize>> = Vec::new();
    for r in all {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

/// The hits to list under the app's own: one whose Threadbear thread is
/// already among the search's own results would be the same thing twice.
pub fn shown<'a>(hits: &'a [Hit], own: &HashSet<&str>) -> Vec<&'a Hit> {
    hits.iter()
        .filter(|h| {
            h.threadbear
                .as_ref()
                .is_none_or(|t| !own.contains(t.thread_id.as_str()))
        })
        .collect()
}

/// "Claude", "Codex": who the session was with.
pub fn agent_name(agent: &str) -> String {
    match agent {
        "claude" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "grok" => "Grok".to_owned(),
        "muse" => "Muse".to_owned(),
        "" => "An agent".to_owned(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }
    }
}

/// The last part of a session's folder: "photo-sync" for
/// "/Users/alex/dev/photo-sync", on any system.
pub fn folder_name(folder: &str) -> Option<String> {
    folder
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// "24 Oct", or "24 Oct 2025" from another year, in `now`'s time zone.
pub fn date_label<Tz: TimeZone>(at_ms: i64, now: &DateTime<Tz>) -> String {
    let Some(d) = now.timezone().timestamp_millis_opt(at_ms).single() else {
        return String::new();
    };
    let day = format!("{} {}", d.day(), MONTHS[d.month0() as usize]);
    if d.year() == now.year() {
        day
    } else {
        format!("{day} {}", d.year())
    }
}

/// "23 to 25 Oct", "30 Sep to 2 Oct", or one day: when a session ran.
pub fn dates_label<Tz: TimeZone>(from: Option<i64>, to: i64, now: &DateTime<Tz>) -> String {
    let tz = now.timezone();
    let (Some(a), Some(b)) = (
        from.and_then(|f| tz.timestamp_millis_opt(f).single()),
        tz.timestamp_millis_opt(to).single(),
    ) else {
        return date_label(to, now);
    };
    if a.date_naive() >= b.date_naive() {
        return date_label(to, now);
    }
    let end = date_label(to, now);
    if a.year() == b.year() && a.month() == b.month() {
        format!("{} to {end}", a.day())
    } else if a.year() == b.year() {
        format!("{} {} to {end}", a.day(), MONTHS[a.month0() as usize])
    } else {
        format!("{} to {end}", date_label(from.unwrap_or(to), now))
    }
}

/// The line under a hit's title: "Claude · photo-sync · 24 Oct".
pub fn hit_line<Tz: TimeZone>(hit: &Hit, now: &DateTime<Tz>) -> String {
    let mut parts = vec![agent_name(&hit.agent)];
    if let Some(f) = hit.folder.as_deref().and_then(folder_name) {
        parts.push(f);
    }
    if hit.updated_at > 0 {
        parts.push(date_label(hit.updated_at, now));
    }
    parts.join(" \u{b7} ")
}

/// The line beside a session's title over its page:
/// "Claude on mac · photo-sync · 23 to 25 Oct".
pub fn session_line<Tz: TimeZone>(s: &Session, now: &DateTime<Tz>) -> String {
    let who = match &s.machine {
        Some(m) => format!("{} on {m}", agent_name(&s.agent)),
        None => agent_name(&s.agent),
    };
    let mut parts = vec![who];
    if let Some(f) = s.folder.as_deref().and_then(folder_name) {
        parts.push(f);
    }
    if s.updated_at > 0 {
        parts.push(dates_label(s.created_at, s.updated_at, now));
    }
    parts.join(" \u{b7} ")
}

/// The heading's count: "5", or "20+" when there were more than came.
pub fn count_label(shown: usize, more: bool) -> String {
    if more {
        format!("{shown}+")
    } else {
        shown.to_string()
    }
}

/// New thread from this: the new thread's first words, naming the session
/// so its agent can read it with the archive's tools.
pub fn new_thread_words(title: &str, thread_id: &str) -> String {
    format!("Pick up from this archived session: \"{title}\" (Agent Archive thread {thread_id})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 23, 3, 0, 0).unwrap()
    }

    fn ms(y: i32, m: u32, d: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, 9, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn hit(id: &str, linked: Option<&str>) -> Hit {
        Hit::decode(&json!({
            "threadId": id, "title": "A session", "agent": "claude", "updatedAt": 1, "sequence": 2,
            "snippet": "words",
            "threadbear": linked.map(|l| json!({ "threadId": l, "title": "Its thread" })),
        }))
        .unwrap()
    }

    #[test]
    fn a_search_answer_is_read_leniently() {
        let v = json!({ "hits": [
            { "threadId": "abc", "title": "Keep the queue in SQLite", "agent": "claude", "folder": "/Users/alex/dev/photo-sync",
              "updatedAt": 1_700_000_000_000_i64, "sequence": 14, "snippet": "so the queue\nlives in   SQLite",
              "threadbear": { "threadId": "t1", "title": "Uploads" }, "newField": true },
            { "title": "no id, left out" },
            { "threadId": "def", "updatedAt": 5.0 },
        ], "more": true });
        let Answer::Found(r) = decode_search("sqlite", &v) else {
            panic!("off");
        };
        assert_eq!(r.query, "sqlite");
        assert!(r.more);
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.hits[0].snippet, "so the queue lives in SQLite");
        assert_eq!(r.hits[0].threadbear.as_ref().unwrap().thread_id, "t1");
        assert_eq!(r.hits[1].title, "Untitled");
        assert_eq!(r.hits[1].updated_at, 5);
    }

    #[test]
    fn off_means_nothing_is_shown() {
        assert_eq!(
            decode_search("x", &json!({ "hits": [], "off": "experiment" })),
            Answer::Off
        );
        assert!(matches!(
            decode_search("x", &json!({ "hits": [] })),
            Answer::Found(_)
        ));
    }

    #[test]
    fn a_session_page_keeps_user_and_assistant_messages_in_order() {
        let v = json!({
            "thread": { "threadId": "abc", "title": "T", "agent": "codex", "updatedAt": 10, "createdAt": 5,
                        "messages": 30, "url": "https://archive.example/?thread=abc" },
            "items": [
                { "sequence": 9, "role": "assistant", "text": "after" },
                { "sequence": 3, "role": "user", "text": "first" },
                { "sequence": 4, "role": "tool", "text": "left out" },
                { "sequence": 5, "role": "user", "text": "   " },
            ],
        });
        let (s, items) = decode_read(&v).unwrap();
        assert_eq!(
            s.url.as_deref(),
            Some("https://archive.example/?thread=abc")
        );
        assert_eq!(s.created_at, Some(5));
        assert_eq!(
            items
                .iter()
                .map(|i| (i.sequence, i.role))
                .collect::<Vec<_>>(),
            vec![(3, Role::User), (9, Role::Assistant)]
        );
        assert!(decode_read(&json!({ "items": [] })).is_none());
        // Only a web page opens from Open in the archive.
        let odd = json!({ "thread": { "threadId": "a", "url": "file:///etc/passwd" } });
        assert_eq!(decode_read(&odd).unwrap().0.url, None);
    }

    #[test]
    fn a_hit_on_a_tool_call_finds_the_message_before_it() {
        let items: Vec<Item> = [3, 9, 14]
            .into_iter()
            .map(|sequence| Item {
                sequence,
                role: Role::Assistant,
                text: "x".into(),
            })
            .collect();
        assert_eq!(found_index(&items, 9), Some(1));
        assert_eq!(found_index(&items, 12), Some(1));
        assert_eq!(found_index(&items, 99), Some(2));
        assert_eq!(found_index(&items, 1), Some(0));
        assert_eq!(found_index(&[], 1), None);
    }

    #[test]
    fn three_characters_are_needed_before_the_archive_is_asked() {
        assert!(!searchable("  ab "));
        assert!(searchable("abc"));
        assert!(searchable("é漢字"));
    }

    #[test]
    fn every_word_of_the_search_is_marked_whatever_its_case() {
        let line = "Keep the upload queue in SQLite: sqlite handles it";
        let got: Vec<&str> = marks(line, "SQLite queue")
            .into_iter()
            .map(|r| &line[r])
            .collect();
        assert_eq!(got, vec!["queue", "SQLite", "sqlite"]);
    }

    #[test]
    fn marks_that_overlap_are_joined_and_quotes_and_single_letters_dropped() {
        let line = "a database and data";
        let got: Vec<&str> = marks(line, "\"data\" database a")
            .into_iter()
            .map(|r| &line[r])
            .collect();
        assert_eq!(got, vec!["database", "data"]);
        assert_eq!(words("\"SQLite,\" a sqlite b2"), vec!["SQLite", "b2"]);
        assert!(marks("Ünïcode text", "ünï").first() == Some(&(0..5)));
    }

    #[test]
    fn a_hit_whose_thread_is_among_the_search_results_is_left_out() {
        let hits = vec![hit("a", Some("t1")), hit("b", Some("t2")), hit("c", None)];
        let own: HashSet<&str> = ["t1"].into_iter().collect();
        let ids: Vec<&str> = shown(&hits, &own)
            .iter()
            .map(|h| h.thread_id.as_str())
            .collect();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[test]
    fn the_line_under_a_hit_says_who_where_and_when() {
        let mut h = hit("a", None);
        h.folder = Some("/Users/alex/dev/photo-sync/".into());
        h.updated_at = ms(2026, 10, 24);
        assert_eq!(
            hit_line(&h, &now()),
            "Claude \u{b7} photo-sync \u{b7} 24 Oct"
        );
        h.agent = "codex".into();
        h.folder = Some("C:\\Users\\alex\\code\\misc".into());
        h.updated_at = ms(2025, 12, 30);
        assert_eq!(hit_line(&h, &now()), "Codex \u{b7} misc \u{b7} 30 Dec 2025");
        h.folder = None;
        h.updated_at = 0;
        h.agent = "opencode".into();
        assert_eq!(hit_line(&h, &now()), "Opencode");
    }

    #[test]
    fn a_session_over_several_days_says_from_when_to_when() {
        let n = now();
        assert_eq!(
            dates_label(Some(ms(2026, 10, 23)), ms(2026, 10, 25), &n),
            "23 to 25 Oct"
        );
        assert_eq!(
            dates_label(Some(ms(2026, 9, 30)), ms(2026, 10, 2), &n),
            "30 Sep to 2 Oct"
        );
        assert_eq!(
            dates_label(Some(ms(2025, 12, 30)), ms(2026, 1, 2), &n),
            "30 Dec 2025 to 2 Jan"
        );
        assert_eq!(
            dates_label(Some(ms(2026, 10, 25)), ms(2026, 10, 25), &n),
            "25 Oct"
        );
        assert_eq!(dates_label(None, ms(2026, 10, 25), &n), "25 Oct");
        let s = Session {
            thread_id: "a".into(),
            title: "T".into(),
            agent: "claude".into(),
            folder: Some("/x/misc".into()),
            machine: Some("mac".into()),
            created_at: Some(ms(2026, 10, 23)),
            updated_at: ms(2026, 10, 25),
            messages: 3,
            url: None,
            threadbear: None,
        };
        assert_eq!(
            session_line(&s, &n),
            "Claude on mac \u{b7} misc \u{b7} 23 to 25 Oct"
        );
    }

    #[test]
    fn the_count_says_when_there_were_more() {
        assert_eq!(count_label(5, false), "5");
        assert_eq!(count_label(20, true), "20+");
    }

    #[test]
    fn a_new_thread_from_a_session_names_it_for_its_agent() {
        assert_eq!(
            new_thread_words("Keep the queue in SQLite", "k57a2mq9"),
            "Pick up from this archived session: \"Keep the queue in SQLite\" (Agent Archive thread k57a2mq9)"
        );
    }
}
