// The Feed (experiment `feed`, runner/src/experiments/feed.md): the Inbox
// drawn as one card per thread, one after another, in the main panel, as
// Mike picked on 20 Nov 2026 (feed-mockups r3-c-status). What's here is what
// it knows with no window: which threads it shows and in what order, what a
// card says at the top and in its "where it's at" box, and the messages its
// fold opens onto, read from the thread's events.
use crate::inbox::{self, ThreadSummary, Wake};
use chrono::{DateTime, Datelike as _, TimeZone};
use serde_json::Value;
use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};

pub const EXPERIMENT: &str = "feed";

/// How many messages the fold shows before "Show N earlier messages".
pub const FOLD_SHOWS: usize = 4;

/// How far down the feed counts as scrolled away from the top, for the
/// "↑ N new" pill.
pub const AWAY_FROM_TOP: f32 = 80.;

/// Where a card stands, which picks its pill and what its box shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardState {
    /// Waiting on Mike: a card of asks, a question or permission, a design
    /// review, or a finished turn that says it needs him.
    NeedsYou,
    /// A turn under way, or work going on in the background.
    Running,
    /// The rest of the Inbox: done, or nothing for him.
    Quiet,
}

impl CardState {
    pub fn name(self) -> &'static str {
        match self {
            CardState::NeedsYou => "needsYou",
            CardState::Running => "running",
            CardState::Quiet => "quiet",
        }
    }
}

/// Which section the sidebar would put it in, a star aside: the feed has no
/// Starred heading, so a starred thread goes where it would without its star.
fn section(t: &ThreadSummary, now_ms: i64, wakes: &HashMap<String, Wake>) -> &'static str {
    if t.is_starred() && !t.is_archived() {
        let mut plain = t.clone();
        plain.starred_at = None;
        return inbox::section_of(&plain, now_ms, wakes);
    }
    inbox::section_of(t, now_ms, wakes)
}

/// The card's state, from the sidebar's own rules: Running is what the
/// sidebar puts under Running, Needs you the Inbox's threads that want Mike.
pub fn card_state(t: &ThreadSummary, now_ms: i64, wakes: &HashMap<String, Wake>) -> CardState {
    match section(t, now_ms, wakes) {
        "running" => CardState::Running,
        _ if t.wants_you() || t.waiting_on_mike() => CardState::NeedsYou,
        _ => CardState::Quiet,
    }
}

/// The threads the feed shows, in its order: those that need Mike, then the
/// running ones, then the rest of the Inbox, each newest first (a stuck card
/// first among those that need him, as the Inbox has it). Hibernating and
/// archived threads aren't in it, except the ones in `kept`: threads Mike
/// marked Done here, which keep their place as a one-line row until he
/// leaves the feed (sorted as they were before he archived them).
pub fn feed_threads<'a, T: Borrow<ThreadSummary> + Clone + 'a>(
    threads: impl IntoIterator<Item = &'a T>,
    now_ms: i64,
    wakes: &HashMap<String, Wake>,
    kept: &HashSet<String>,
) -> Vec<T> {
    let mut cards: Vec<(u8, bool, i64, String, T)> = Vec::new();
    for row in threads {
        let t: &ThreadSummary = row.borrow();
        let state = if t.is_archived() && kept.contains(&t.id) {
            let mut was = t.clone();
            was.archived_at = None;
            if matches!(section(&was, now_ms, wakes), "hibernating" | "archived") {
                continue;
            }
            card_state(&was, now_ms, wakes)
        } else {
            if matches!(section(t, now_ms, wakes), "hibernating" | "archived") {
                continue;
            }
            card_state(t, now_ms, wakes)
        };
        let rank = match state {
            CardState::NeedsYou => 0,
            CardState::Running => 1,
            CardState::Quiet => 2,
        };
        cards.push((
            rank,
            !t.on_card(),
            t.activity_ms(),
            t.id.clone(),
            row.clone(),
        ));
    }
    cards.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(b.2.cmp(&a.2))
            .then(a.3.cmp(&b.3))
    });
    cards.into_iter().map(|c| c.4).collect()
}

/// Who a card's top line is from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Starter {
    /// Mike started it: his name, then what he asked.
    Mike,
    /// Another thread started it ("Started by <its title>").
    Thread,
    /// A schedule did (its title).
    Schedule,
    /// A tool, or the runner, did (its label).
    Tool,
}

/// A card's top: whose it is, the name beside the avatar, and the line under
/// it (his request, or for one he didn't start, the thread's title).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Top {
    pub from: Starter,
    /// "Started by GPUI Port Coordinator", "Kite watch", "Sentry"; empty for Mike.
    pub name: String,
    pub line: String,
    /// The avatar's letters, for one that isn't Mike's.
    pub initials: String,
}

fn title_of(t: &ThreadSummary) -> String {
    if t.title.trim().is_empty() {
        "Untitled".to_owned()
    } else {
        t.title.clone()
    }
}

/// Up to two letters from a name's words: "GPUI Port Coordinator" is "GP".
pub fn initials(name: &str) -> String {
    let letters: String = name
        .split_whitespace()
        .filter_map(|w| w.chars().find(|c| c.is_alphanumeric()))
        .take(2)
        .collect();
    if letters.is_empty() {
        "?".to_owned()
    } else {
        letters.to_uppercase()
    }
}

/// The card's top line: Mike's first message to the thread (`request`), or
/// its title when that's missing (a thread from before it, or another Mac on
/// an older backend). For a thread he didn't start, who did and its title.
pub fn top(t: &ThreadSummary) -> Top {
    let started = t.started_by.as_ref();
    let kind = started
        .and_then(|s| s.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let label = started
        .and_then(|s| s.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let schedule = t
        .schedule
        .as_ref()
        .and_then(|s| s.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let title = title_of(t);
    if kind == "thread" || kind == "librarian" {
        let by = started
            .and_then(|s| s.get("threadTitle"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if label.is_empty() {
                    "Agent".to_owned()
                } else {
                    label.clone()
                }
            });
        return Top {
            from: Starter::Thread,
            initials: initials(&by),
            name: format!("Started by {by}"),
            line: title,
        };
    }
    if kind == "schedule" || (started.is_none() && schedule.is_some()) {
        let name = schedule.map(str::to_owned).unwrap_or_else(|| {
            if label.is_empty() {
                "Schedule".to_owned()
            } else {
                label.clone()
            }
        });
        return Top {
            from: Starter::Schedule,
            initials: String::new(),
            name,
            line: title,
        };
    }
    if started.is_some() {
        let name = if label.is_empty() {
            "Threadbear".to_owned()
        } else {
            label
        };
        return Top {
            from: Starter::Tool,
            initials: initials(&name),
            name,
            line: title,
        };
    }
    let line = t
        .request
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or(title);
    Top {
        from: Starter::Mike,
        name: String::new(),
        line,
        initials: String::new(),
    }
}

/// The "where it's at" box's words: the latest turn's headline, its first
/// line in plain words. None before the thread has said anything.
pub fn headline(t: &ThreadSummary) -> Option<String> {
    let line = crate::sidebar::preview_plain(t.preview.lines().next().unwrap_or(""))
        .trim()
        .to_owned();
    (!line.is_empty()).then_some(line)
}

/// The headline in full, where the card has read the thread's messages: the
/// summary's is cut at 140 characters, so the first paragraph of the reply
/// it comes from, when that's the agent's last message (three lines of it
/// show). None when the messages don't say more than the summary.
pub fn fuller_headline(t: &ThreadSummary, messages: &[Message]) -> Option<String> {
    let short = headline(t)?;
    let reply = messages.iter().rev().find(|m| m.author == Author::Agent)?;
    let first = reply
        .text
        .split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty())?;
    let para =
        crate::sidebar::preview_plain(&first.lines().map(str::trim).collect::<Vec<_>>().join(" "))
            .trim()
            .to_owned();
    let start: String = short
        .trim_end_matches('\u{2026}')
        .chars()
        .take(40)
        .collect();
    (para.len() > short.len() && para.starts_with(&start)).then_some(para)
}

/// What a running card's spinner line says: the newest background job the
/// thread has going, else "Working".
pub fn live_line(t: &ThreadSummary) -> String {
    if t.busy() {
        if t.status == "starting" {
            return "Starting".to_owned();
        }
        return "Working".to_owned();
    }
    if let Some(what) = t.waiting_to_land() {
        return what;
    }
    if t.waiting_on_work() {
        if t.awaiting_app_restart == Some(true) {
            return "Waiting for the app to restart onto it".to_owned();
        }
        let titles: Vec<String> = t
            .waiting_on
            .iter()
            .flatten()
            .filter(|w| w.get("done").and_then(Value::as_bool) != Some(true))
            .filter_map(|w| w.get("title").and_then(Value::as_str).map(str::to_owned))
            .collect();
        if let Some(first) = titles.first() {
            return format!("Waiting on {first}");
        }
    }
    t.background_tasks()
        .into_iter()
        .rev()
        .map(|b| b.description.trim().to_owned())
        .find(|d| !d.is_empty())
        .unwrap_or_else(|| "Working".to_owned())
}

/// The agent's name on the fold and its messages: "Claude", "Codex".
pub fn agent_name(provider: &str) -> String {
    match provider {
        "" | "claude" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "grok" => "Grok".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        "cursor" => "Cursor".to_owned(),
        "antigravity" => "Gemini".to_owned(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        }
    }
}

/// The fold's words: "Claude · 9 messages", or just the agent's name before
/// its messages have been read.
pub fn fold_label(provider: &str, count: Option<usize>, more_before: bool) -> String {
    let name = agent_name(provider);
    match count {
        Some(1) if !more_before => format!("{name} \u{b7} 1 message"),
        Some(n) if more_before => format!("{name} \u{b7} {n}+ messages"),
        Some(n) => format!("{name} \u{b7} {n} messages"),
        None => name,
    }
}

/// A Done card's one line: "✓ title · headline · Undo" is drawn from these.
pub fn done_line(t: &ThreadSummary) -> (String, Option<String>) {
    (title_of(t), headline(t))
}

/// "3:10 pm" today, "Tue 3:10 pm" this week, "12 Nov" before that.
pub fn when<Tz: TimeZone>(at_ms: i64, now: &DateTime<Tz>) -> String {
    let Some(at) = now.timezone().timestamp_millis_opt(at_ms).single() else {
        return String::new();
    };
    let clock = crate::new_thread::clock(&at);
    let days = (now.clone().date_naive() - at.date_naive()).num_days();
    if days <= 0 {
        clock
    } else if days < 6 {
        const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        format!(
            "{} {clock}",
            WEEKDAYS[at.weekday().num_days_from_monday() as usize]
        )
    } else {
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        format!("{} {}", at.day(), MONTHS[at.month0() as usize])
    }
}

/// Who wrote a message in the fold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Author {
    Mike,
    Agent,
    /// The runner, a schedule or another agent sent it.
    Other,
}

/// A message in a card's fold: Mike's, or the agent's reply to a turn.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub seq: u64,
    pub author: Author,
    /// "Schedule", "Threadbear", "Agent" for an `Other` message.
    pub by: String,
    pub text: String,
    pub at_ms: i64,
}

/// The conversation as the fold shows it, oldest first, from a page of the
/// thread's events (`threads.events`): each message Mike sent, and the
/// agent's reply to each turn (its last block of words, a narration aside).
/// Events an edit cut out (`thread.rewound`) aren't in it.
pub fn messages(events: &[Value]) -> Vec<Message> {
    let mut cut: Vec<(u64, u64)> = Vec::new();
    for e in events {
        if e.get("type").and_then(Value::as_str) == Some("thread.rewound") {
            if let (Some(from), Some(to)) = (
                e.get("fromSeq").and_then(Value::as_u64),
                e.get("toSeq").and_then(Value::as_u64),
            ) {
                cut.push((from, to));
            }
        }
    }
    let gone = |seq: u64| cut.iter().any(|(a, b)| seq >= *a && seq <= *b);
    let mut out: Vec<Message> = Vec::new();
    // The agent's reply so far in the turn under way: its message's place in
    // `out` and the turn it's for, replaced by a later block in that turn.
    let mut reply: Option<(usize, String)> = None;
    let mut items: HashMap<String, usize> = HashMap::new();
    for e in events {
        let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
        if gone(seq) {
            continue;
        }
        let at_ms = e
            .get("ts")
            .and_then(Value::as_str)
            .and_then(inbox::parse_ms)
            .unwrap_or(0);
        let turn = e
            .get("turnId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match e.get("type").and_then(Value::as_str) {
            Some("user.message") => {
                let text = e
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                if text.is_empty() {
                    continue;
                }
                let origin = e.get("origin").and_then(Value::as_str).unwrap_or("");
                let by_agent = e
                    .get("sentByAgent")
                    .is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
                let (author, by) = match origin {
                    "runner" => (Author::Other, "Threadbear"),
                    "schedule" => (Author::Other, "Schedule"),
                    _ if by_agent => (Author::Other, "Agent"),
                    _ => (Author::Mike, ""),
                };
                out.push(Message {
                    seq,
                    author,
                    by: by.to_owned(),
                    text,
                    at_ms,
                });
                reply = None;
            }
            Some("assistant.text") => {
                if e.get("narration").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let text = e
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                if text.is_empty() {
                    continue;
                }
                let item = e
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let message = Message {
                    seq,
                    author: Author::Agent,
                    by: String::new(),
                    text,
                    at_ms,
                };
                // The same block again replaces it where it stands.
                if let Some(&at) = items.get(&item).filter(|_| !item.is_empty()) {
                    if let Some(slot) = out.get_mut(at) {
                        *slot = message;
                    }
                    continue;
                }
                match &reply {
                    Some((at, t)) if *t == turn => {
                        out[*at] = message;
                        if !item.is_empty() {
                            items.insert(item, *at);
                        }
                    }
                    _ => {
                        out.push(message);
                        reply = Some((out.len() - 1, turn));
                        if !item.is_empty() {
                            items.insert(item, out.len() - 1);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// How many cards the "↑ N new" pill counts: ones in the feed now that
/// weren't when Mike last saw its top.
pub fn new_count<'a>(shown: impl IntoIterator<Item = &'a str>, seen: &HashSet<String>) -> usize {
    shown.into_iter().filter(|id| !seen.contains(*id)).count()
}

/// "↑ 3 new".
pub fn new_pill(count: usize) -> String {
    format!("\u{2191} {count} new")
}

/// The first word of a person's full name, for "Mike" over his messages;
/// "You" when there's none.
pub fn first_name(full: &str) -> String {
    full.split_whitespace()
        .next()
        .map(str::to_owned)
        .unwrap_or_else(|| "You".to_owned())
}

/// A card as the dump has it, one line: "[needsYou] Title: top line | where
/// it's at", with "(done)" for a Done row.
pub fn dump_line(t: &ThreadSummary, state: CardState, done: bool) -> String {
    let top = top(t);
    let head = headline(t).unwrap_or_default();
    if done {
        return format!("[done] {}: {head}", title_of(t));
    }
    format!("[{}] {}: {} | {head}", state.name(), title_of(t), top.line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_763_600_000_000;

    fn thread(id: &str, minutes_ago: i64, extra: Value) -> ThreadSummary {
        let mut v = json!({
            "id": id, "title": format!("Thread {id}"), "cwd": "/x", "provider": "claude", "accountId": "a", "permissionMode": "full",
            "status": "idle", "needsYou": false, "preview": "", "lastSeq": 3, "lastSeenSeq": 3,
            "lastActivityAt": inbox::iso_time(NOW - minutes_ago * 60_000),
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    fn ids(list: &[ThreadSummary]) -> Vec<&str> {
        list.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn needs_you_then_running_then_the_rest_each_newest_first() {
        let threads = vec![
            thread("quiet_old", 50, json!({ "needs": "nothing" })),
            thread("run_old", 30, json!({ "status": "running" })),
            thread(
                "needs_old",
                40,
                json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Pick one" }], "asksSeq": 3 }),
            ),
            thread("quiet_new", 1, json!({ "needs": "nothing" })),
            thread("run_new", 2, json!({ "status": "running" })),
            thread("needs_new", 5, json!({ "needs": "you", "needsYou": true })),
            thread(
                "asleep",
                0,
                json!({ "snoozedUntil": inbox::iso_time(NOW + 3_600_000) }),
            ),
            thread("archived", 0, json!({ "archivedAt": inbox::iso_time(NOW) })),
        ];
        let shown = feed_threads(&threads, NOW, &HashMap::new(), &HashSet::new());
        assert_eq!(
            ids(&shown),
            [
                "needs_new",
                "needs_old",
                "run_new",
                "run_old",
                "quiet_new",
                "quiet_old"
            ]
        );
    }

    #[test]
    fn a_thread_stuck_on_a_card_comes_first_and_a_starred_one_goes_where_it_would() {
        let threads = vec![
            thread("needs", 1, json!({ "needs": "you", "needsYou": true })),
            thread("stuck", 30, json!({ "status": "waiting" })),
            thread(
                "starred_running",
                3,
                json!({ "status": "running", "starredAt": inbox::iso_time(NOW) }),
            ),
            thread(
                "starred_asleep",
                3,
                json!({ "starredAt": inbox::iso_time(NOW), "snoozedUntil": inbox::iso_time(NOW + 3_600_000) }),
            ),
        ];
        let shown = feed_threads(&threads, NOW, &HashMap::new(), &HashSet::new());
        assert_eq!(ids(&shown), ["stuck", "needs", "starred_running"]);
    }

    #[test]
    fn a_done_card_keeps_its_place_until_mike_leaves_the_feed() {
        let threads = vec![
            thread("a", 1, json!({ "needs": "nothing" })),
            thread(
                "done",
                2,
                json!({ "needs": "nothing", "archivedAt": inbox::iso_time(NOW) }),
            ),
            thread("b", 3, json!({ "needs": "nothing" })),
        ];
        let kept: HashSet<String> = ["done".to_owned()].into();
        assert_eq!(
            ids(&feed_threads(&threads, NOW, &HashMap::new(), &kept)),
            ["a", "done", "b"]
        );
        assert_eq!(
            ids(&feed_threads(
                &threads,
                NOW,
                &HashMap::new(),
                &HashSet::new()
            )),
            ["a", "b"]
        );
    }

    #[test]
    fn card_states() {
        let w = HashMap::new();
        assert_eq!(
            card_state(
                &thread(
                    "x",
                    1,
                    json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Go?" }] })
                ),
                NOW,
                &w
            ),
            CardState::NeedsYou
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "status": "waiting" })), NOW, &w),
            CardState::NeedsYou
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "status": "running" })), NOW, &w),
            CardState::Running
        );
        assert_eq!(
            card_state(
                &thread(
                    "x",
                    1,
                    json!({ "background": [{ "kind": "shell", "description": "npm test" }] })
                ),
                NOW,
                &w
            ),
            CardState::Running
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "needs": "nothing" })), NOW, &w),
            CardState::Quiet
        );
        // A finished turn that didn't say is still something for him to read.
        assert_eq!(
            card_state(&thread("x", 1, json!({ "needsYou": true })), NOW, &w),
            CardState::NeedsYou
        );
    }

    #[test]
    fn the_top_is_mikes_request_or_who_started_it() {
        let mine = thread(
            "x",
            1,
            json!({ "title": "Bedtime Tube", "request": "Bedtime Tube hasn't put anything on my phone for ages", "asked": "and the alert?" }),
        );
        assert_eq!(
            top(&mine),
            Top {
                from: Starter::Mike,
                name: String::new(),
                line: "Bedtime Tube hasn't put anything on my phone for ages".into(),
                initials: String::new()
            }
        );
        // No request (an older runner): the title.
        assert_eq!(
            top(&thread("x", 1, json!({ "title": "Keep main green" }))).line,
            "Keep main green"
        );
        let by_thread = thread(
            "x",
            1,
            json!({ "title": "Browser pane: back button", "startedBy": { "kind": "thread", "label": "Agent", "threadId": "c", "threadTitle": "GPUI Port Coordinator" } }),
        );
        let t = top(&by_thread);
        assert_eq!(
            (
                t.from,
                t.name.as_str(),
                t.line.as_str(),
                t.initials.as_str()
            ),
            (
                Starter::Thread,
                "Started by GPUI Port Coordinator",
                "Browser pane: back button",
                "GP"
            )
        );
        let scheduled = thread(
            "x",
            1,
            json!({ "title": "Kite check", "startedBy": { "kind": "schedule", "label": "Schedule" }, "schedule": { "id": "s", "title": "Kite watch" } }),
        );
        assert_eq!(
            (top(&scheduled).from, top(&scheduled).name),
            (Starter::Schedule, "Kite watch".to_owned())
        );
        let tool = thread(
            "x",
            1,
            json!({ "title": "Sentry: TypeError", "startedBy": { "kind": "tool", "label": "Sentry" } }),
        );
        assert_eq!(
            (top(&tool).from, top(&tool).name, top(&tool).line),
            (
                Starter::Tool,
                "Sentry".to_owned(),
                "Sentry: TypeError".to_owned()
            )
        );
    }

    #[test]
    fn where_its_at_and_the_live_line() {
        let t = thread(
            "x",
            1,
            json!({ "preview": "**Fixed**, and the [backlog](https://x) is on your phone.\nmore" }),
        );
        assert_eq!(
            headline(&t).as_deref(),
            Some("Fixed, and the backlog is on your phone.")
        );
        assert_eq!(headline(&thread("x", 1, json!({}))), None);
        assert_eq!(
            live_line(&thread("x", 1, json!({ "status": "running" }))),
            "Working"
        );
        assert_eq!(
            live_line(&thread(
                "x",
                1,
                json!({ "background": [{ "kind": "shell", "description": "" }, { "kind": "monitor", "description": "Waiting on the next Desktop run" }] })
            )),
            "Waiting on the next Desktop run"
        );
    }

    #[test]
    fn the_folds_words() {
        assert_eq!(
            fold_label("claude", Some(9), false),
            "Claude \u{b7} 9 messages"
        );
        assert_eq!(
            fold_label("codex", Some(1), false),
            "Codex \u{b7} 1 message"
        );
        assert_eq!(
            fold_label("claude", Some(40), true),
            "Claude \u{b7} 40+ messages"
        );
        assert_eq!(fold_label("claude", None, false), "Claude");
        assert_eq!(new_pill(3), "\u{2191} 3 new");
        assert_eq!(first_name("Mike Cann"), "Mike");
        assert_eq!(first_name(""), "You");
    }

    #[test]
    fn the_folds_messages_are_mikes_and_each_turns_reply() {
        let events = vec![
            json!({ "seq": 1, "ts": "2026-11-20T02:00:00.000Z", "type": "user.message", "turnId": "t1", "text": "Fix the thing" }),
            json!({ "seq": 2, "type": "turn.started", "turnId": "t1" }),
            json!({ "seq": 3, "type": "assistant.text", "turnId": "t1", "itemId": "a", "text": "Looking." }),
            json!({ "seq": 4, "type": "tool.started", "turnId": "t1" }),
            json!({ "seq": 5, "type": "assistant.text", "turnId": "t1", "itemId": "b", "text": "Fixed it." }),
            json!({ "seq": 6, "type": "assistant.text", "turnId": "t1", "itemId": "n", "text": "thinking aloud", "narration": true }),
            json!({ "seq": 7, "type": "turn.completed", "turnId": "t1" }),
            json!({ "seq": 8, "type": "user.message", "turnId": "t2", "text": "Runner restarted", "origin": "runner" }),
            json!({ "seq": 9, "type": "assistant.text", "turnId": "t2", "itemId": "c", "text": "Carrying on." }),
            json!({ "seq": 10, "type": "user.message", "turnId": "t3", "text": "an edit cut this" }),
            json!({ "seq": 11, "type": "thread.rewound", "fromSeq": 10, "toSeq": 10 }),
            json!({ "seq": 12, "type": "user.message", "turnId": "t4", "text": "Thanks", "editOf": 10 }),
        ];
        let all = messages(&events);
        let got: Vec<(Author, &str, &str)> = all
            .iter()
            .map(|m| (m.author, m.by.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (Author::Mike, "", "Fix the thing"),
                (Author::Agent, "", "Fixed it."),
                (Author::Other, "Threadbear", "Runner restarted"),
                (Author::Agent, "", "Carrying on."),
                (Author::Mike, "", "Thanks"),
            ]
        );
        assert!(all[0].at_ms > 0);
    }

    #[test]
    fn the_headline_in_full_once_the_messages_are_read() {
        let long = "The guide and FAQ are written. A T3 contributor found a 4th bug caused by the custom label: Claude Code switches off MCP Tasks for a label it doesn't recognise.";
        let t = thread("x", 1, json!({ "preview": &long[..140] }));
        let said = |text: &str| {
            vec![Message {
                seq: 1,
                author: Author::Agent,
                by: String::new(),
                text: text.to_owned(),
                at_ms: 0,
            }]
        };
        assert_eq!(
            fuller_headline(&t, &said(&format!("{long}\n\nMore below."))).as_deref(),
            Some(long)
        );
        // Another reply than the one the summary has: the summary's stays.
        assert_eq!(fuller_headline(&t, &said("Something else entirely.")), None);
        assert_eq!(fuller_headline(&t, &[]), None);
    }

    #[test]
    fn new_cards_are_the_ones_not_seen_at_the_top() {
        let seen: HashSet<String> = ["a".to_owned(), "b".to_owned()].into();
        assert_eq!(new_count(["c", "a", "d", "b"], &seen), 2);
    }

    #[test]
    fn times_on_a_card() {
        let zone = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let now = zone.with_ymd_and_hms(2026, 11, 20, 17, 0, 0).unwrap();
        let at = |d: u32, h: u32, m: u32| {
            zone.with_ymd_and_hms(2026, 11, d, h, m, 0)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(when(at(20, 15, 10), &now), "3:10 pm");
        assert_eq!(when(at(17, 15, 10), &now), "Tue 3:10 pm");
        assert_eq!(when(at(2, 9, 0), &now), "2 Nov");
    }

    #[test]
    fn the_dump_line() {
        let t = thread(
            "x",
            1,
            json!({ "title": "Kite", "request": "Is it windy?", "preview": "19 kn WSW" }),
        );
        assert_eq!(
            dump_line(&t, CardState::Quiet, false),
            "[quiet] Kite: Is it windy? | 19 kn WSW"
        );
        assert_eq!(
            dump_line(&t, CardState::Quiet, true),
            "[done] Kite: 19 kn WSW"
        );
    }
}
