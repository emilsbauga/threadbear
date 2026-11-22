// A button an agent put in its reply (docs/protocol/events.md, "Reply buttons";
// Swift's ReplyButton.swift): `add_button` stores one on the thread, the
// reply links it as `[title](button:<id>)`, and Mike's press starts a thread
// with the brief or sends the message, once, or opens another folder's patch
// panel beside the thread, every time. What it looks like, says and
// tips, and which of two snapshots of it is newer.
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReplyButton {
    #[serde(default, deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub created_at: String,
    // Actions must stay strict: losing a run payload would turn a command
    // into an ordinary reply pill while its id still runs the real command.
    #[serde(default)]
    pub start: Option<Start>,
    #[serde(default)]
    pub send: Option<Send>,
    #[serde(default)]
    pub run: Option<Run>,
    #[serde(default)]
    pub panel: Option<PanelTarget>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub running: Option<At>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub pressed: Option<Pressed>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub failed: Option<Failed>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
// Relay snapshots intentionally redact these strings. Keep their types
// required, but accept empty values; presses route by thread/button ids.
pub struct Start {
    pub text: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: Option<String>,
    pub cwd: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    pub thread_id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub thread_title: String,
    pub text: String,
}

/// A folder's web panel the press opens beside the thread.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelTarget {
    pub cwd: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub panel_id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    #[serde(deserialize_with = "crate::wire::id")]
    pub command: String,
    #[serde(deserialize_with = "crate::wire::id")]
    pub cwd: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct At {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub at: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pressed {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub at: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub thread_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Failed {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub at: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub error: String,
}

impl ReplyButton {
    pub fn decode(v: &serde_json::Value) -> Option<ReplyButton> {
        let button: ReplyButton = crate::wire::read(v.clone())?;
        let actions = usize::from(button.start.is_some())
            + usize::from(button.send.is_some())
            + usize::from(button.run.is_some())
            + usize::from(button.panel.is_some());
        if button.id.is_empty() || actions != 1 {
            crate::wire::dropped::<ReplyButton>("button action or identity");
            return None;
        }
        Some(button)
    }

    /// Whether this snapshot is newer than `old`. A button only moves
    /// forward (made, then failed any number of times, then pressed for
    /// good), so its state says which came later even when snapshots arrive
    /// out of order (an older page's event, or `buttons.list` racing a live
    /// `button.updated`).
    pub fn supersedes(&self, old: &ReplyButton) -> bool {
        // A panel button is pressed again and again: the later press wins.
        if self.panel.is_some() {
            let when = |b: &ReplyButton| {
                [
                    b.pressed.as_ref().map(|p| p.at.clone()),
                    b.failed.as_ref().map(|f| f.at.clone()),
                ]
                .into_iter()
                .flatten()
                .max()
            };
            return match (when(self), when(old)) {
                (Some(new), Some(previous)) => new > previous || (new == previous && self != old),
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => self != old,
            };
        }
        if old.pressed.is_some() {
            return false;
        }
        if self.pressed.is_some() {
            return true;
        }
        // Running and failing can alternate (a run pressed again), so the
        // later of the two moments wins.
        let when = |b: &ReplyButton| {
            b.running
                .as_ref()
                .map(|r| r.at.clone())
                .or_else(|| b.failed.as_ref().map(|f| f.at.clone()))
        };
        match (when(self), when(old)) {
            (None, None) => self != old,
            (None, Some(_)) => false,
            (Some(_), None) => true,
            (Some(new), Some(previous)) => new > previous || (new == previous && self != old),
        }
    }
}

/// How a pill looks (`ReplyButtons.Look`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    Start,
    Send,
    Panel,
    Pressing,
    Pressed,
    Failed,
}

pub fn look(button: &ReplyButton, pressing: bool) -> Look {
    // Never spent: each press opens the panel again. A failure since the
    // last press shows.
    if button.panel.is_some() {
        let failed_last = button
            .failed
            .as_ref()
            .is_some_and(|f| button.pressed.as_ref().is_none_or(|p| f.at > p.at));
        return if pressing {
            Look::Pressing
        } else if failed_last {
            Look::Failed
        } else {
            Look::Panel
        };
    }
    if button.pressed.is_some() {
        Look::Pressed
    } else if pressing {
        Look::Pressing
    } else if button.failed.is_some() {
        Look::Failed
    } else if button.send.is_some() {
        Look::Send
    } else {
        Look::Start
    }
}

/// What the pill says: a mark for what it does, then its title.
pub fn label(button: &ReplyButton, look: Look) -> String {
    let mark = match look {
        // U+FE0E keeps ▶ a text glyph rather than the emoji.
        Look::Start => "\u{25B6}\u{FE0E}",
        Look::Send => "\u{21AA}\u{FE0E}",
        // A square with its right half filled: the side pane.
        Look::Panel => "\u{25E8}\u{FE0E}",
        Look::Pressing => "\u{2026}",
        Look::Pressed => "\u{2713}",
        Look::Failed => "!",
    };
    format!("{mark} {}", button.title)
}

/// The pill's tip: what pressing does, in the agent's own words.
pub fn tip(button: &ReplyButton, look: Look) -> String {
    let what = if let Some(start) = &button.start {
        let folder = start
            .cwd
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        format!(
            "Starts a thread in {}: {}",
            if folder.is_empty() {
                start.cwd.as_str()
            } else {
                folder
            },
            excerpt(&start.text, 200)
        )
    } else if let Some(send) = &button.send {
        format!(
            "Sends to \"{}\": {}",
            send.thread_title,
            excerpt(&send.text, 200)
        )
    } else if let Some(panel) = &button.panel {
        let folder = panel
            .cwd
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        format!(
            "Opens {} from {} beside this thread",
            if panel.title.is_empty() {
                "the panel"
            } else {
                panel.title.as_str()
            },
            if folder.is_empty() {
                panel.cwd.as_str()
            } else {
                folder
            }
        )
    } else {
        button.title.clone()
    };
    match look {
        Look::Start | Look::Send | Look::Panel => what,
        Look::Pressing => format!("On its way. {what}"),
        Look::Pressed => format!(
            "{}\n\n{what}",
            if button.send.is_some() {
                "Sent. Click to open the thread it went to."
            } else {
                "Started. Click to open the thread it started."
            }
        ),
        Look::Failed => format!(
            "That didn't work: {}. Click to try again.\n\n{what}",
            button
                .failed
                .as_ref()
                .map_or("unknown error", |f| f.error.as_str())
        ),
    }
}

/// The first `limit` characters, on one line.
pub fn excerpt(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let cut: String = flat.chars().take(limit).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// The ids of the buttons a reply links, in order (`ReplyButtons.ids(in:)`).
pub fn ids_in(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("](button:") {
        let after = &rest[at + "](button:".len()..];
        let Some(end) = after.find(')') else { break };
        let id = after[..end].trim();
        if !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            ids.push(id.to_owned());
        }
        rest = &after[end..];
    }
    ids
}

impl Look {
    /// Its name in the dumps (`Look.rawValue`).
    pub fn name(self) -> &'static str {
        match self {
            Look::Start => "start",
            Look::Send => "send",
            Look::Panel => "panel",
            Look::Pressing => "pressing",
            Look::Pressed => "pressed",
            Look::Failed => "failed",
        }
    }
}

/// A reply's text with every `[words](button:<id>)` whose id `keep` turns
/// down left as its words alone (the GPUI app's `unknown_as_words`: a button
/// it doesn't know, another thread's, or a run's). Brackets inside the words
/// are minded, and the id is read trimmed.
pub fn unlink<'a>(text: &'a str, keep: impl Fn(&str) -> bool) -> std::borrow::Cow<'a, str> {
    if !text.contains("](button:") {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("](button:") {
        let (before, after) = rest.split_at(at);
        let link_end = after.find(')');
        // The link's words: back to the `[` that opens them, minding brackets inside.
        let mut depth = 0i32;
        let open = before.char_indices().rev().find_map(|(i, c)| match c {
            ']' => {
                depth += 1;
                None
            }
            '[' if depth == 0 => Some(i),
            '[' => {
                depth -= 1;
                None
            }
            _ => None,
        });
        match (open, link_end) {
            (Some(open), Some(end)) => {
                let id = after["](button:".len()..end].trim();
                if keep(id) {
                    out.push_str(&rest[..at + end + 1]);
                } else {
                    out.push_str(&before[..open]);
                    out.push_str(&before[open + 1..]);
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[..at + 1]);
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// The button a `button:` link names.
pub fn id_of(url: &str) -> Option<&str> {
    let (scheme, rest) = url.trim().split_once(':')?;
    if !scheme.eq_ignore_ascii_case("button") {
        return None;
    }
    let id = rest.trim();
    (!id.is_empty()).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn button(v: serde_json::Value) -> ReplyButton {
        ReplyButton::decode(&v).unwrap()
    }

    #[test]
    fn looks_and_says_what_it_does() {
        let start = button(
            json!({ "id": "abc12345", "title": "Fill in the form", "start": { "text": "Open the form   and\\nfill it in", "cwd": "/Users/alex/code/misc" } }),
        );
        assert_eq!(look(&start, false), Look::Start);
        assert_eq!(
            label(&start, Look::Start),
            "\u{25B6}\u{FE0E} Fill in the form"
        );
        assert_eq!(
            tip(&start, Look::Start),
            "Starts a thread in misc: Open the form and\\nfill it in"
        );
        assert_eq!(look(&start, true), Look::Pressing);
        let send = button(
            json!({ "id": "x", "title": "Reply yes", "send": { "threadId": "t2", "threadTitle": "Meetup", "text": "yes" } }),
        );
        assert_eq!(
            label(&send, look(&send, false)),
            "\u{21AA}\u{FE0E} Reply yes"
        );
        let failed = button(
            json!({ "id": "x", "title": "Go", "start": { "text": "go", "cwd": "/a" }, "failed": { "at": "2026-11-11T10:00:00Z", "error": "the folder has gone" } }),
        );
        assert!(tip(&failed, look(&failed, false))
            .starts_with("That didn't work: the folder has gone. Click to try again."));
        let pressed = button(
            json!({ "id": "x", "title": "Go", "send": { "threadId": "t", "threadTitle": "T", "text": "a" }, "pressed": { "at": "z", "threadId": "t" } }),
        );
        assert_eq!(
            look(&pressed, true),
            Look::Pressed,
            "pressed wins over a press on its way"
        );
        assert!(
            tip(&pressed, Look::Pressed).starts_with("Sent. Click to open the thread it went to.")
        );
    }

    #[test]
    fn a_panel_button_is_never_spent() {
        let made = button(
            json!({ "id": "p", "title": "Go through comments", "panel": { "cwd": "/Users/alex/code/yt", "panelId": "youtube.youtube", "title": "YouTube" } }),
        );
        assert_eq!(look(&made, false), Look::Panel);
        assert_eq!(
            label(&made, Look::Panel),
            "\u{25E8}\u{FE0E} Go through comments"
        );
        assert_eq!(
            tip(&made, Look::Panel),
            "Opens YouTube from yt beside this thread"
        );
        let pressed = button(
            json!({ "id": "p", "title": "Go", "panel": { "cwd": "/a", "panelId": "x" }, "pressed": { "at": "2026-11-18T10:00:00Z", "threadId": "t" } }),
        );
        assert_eq!(
            look(&pressed, false),
            Look::Panel,
            "pressed, it still opens the panel"
        );
        assert_eq!(look(&pressed, true), Look::Pressing);
        let failed = button(
            json!({ "id": "p", "title": "Go", "panel": { "cwd": "/a", "panelId": "x" }, "pressed": { "at": "2026-11-18T10:00:00Z", "threadId": "t" }, "failed": { "at": "2026-11-18T11:00:00Z", "error": "gone" } }),
        );
        assert_eq!(look(&failed, false), Look::Failed);
        assert!(failed.supersedes(&pressed));
        let again = button(
            json!({ "id": "p", "title": "Go", "panel": { "cwd": "/a", "panelId": "x" }, "pressed": { "at": "2026-11-18T12:00:00Z", "threadId": "t" }, "failed": { "at": "2026-11-18T11:00:00Z", "error": "gone" } }),
        );
        assert_eq!(
            look(&again, false),
            Look::Panel,
            "a press after the failure"
        );
        assert!(again.supersedes(&failed));
        assert!(!pressed.supersedes(&again));
    }

    #[test]
    fn a_newer_snapshot_wins_and_a_pressed_one_stays() {
        let made =
            button(json!({ "id": "x", "title": "Go", "start": {"text":"Brief","cwd":"/work"} }));
        let failed = button(
            json!({ "id": "x", "title": "Go", "start": {"text":"Brief","cwd":"/work"}, "failed": { "at": "2026-11-11T10:00:00Z", "error": "e" } }),
        );
        let pressed = button(
            json!({ "id": "x", "title": "Go", "start": {"text":"Brief","cwd":"/work"}, "pressed": { "at": "2026-11-11T11:00:00Z", "threadId": "t" } }),
        );
        assert!(failed.supersedes(&made));
        assert!(!made.supersedes(&failed));
        assert!(pressed.supersedes(&failed));
        assert!(!failed.supersedes(&pressed));
        assert!(!made.supersedes(&made));
    }

    #[test]
    fn reads_button_links() {
        assert_eq!(id_of("button:abc12345"), Some("abc12345"));
        assert_eq!(id_of("Button: abc "), Some("abc"));
        assert_eq!(id_of("https://example.com"), None);
        assert_eq!(id_of("button:"), None);
        assert_eq!(excerpt("one two three", 7), "one two\u{2026}");
        assert_eq!(
            ids_in("a [x](button:ab12) b [y](button: cd34 ) [z](https://e)"),
            ["ab12", "cd34"]
        );
    }

    fn shared_cases() -> Vec<serde_json::Value> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/cases/reply-buttons.json"
        );
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        file["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["differs"].get("desktop").is_none())
            .cloned()
            .collect()
    }

    /// How a pill looks, against the cases the phones and the website run
    /// too (shared/cases/reply-buttons.json). The pill reads the runner's own
    /// button, so a case's row is made into one, and a press on its way is
    /// `pressing`.
    #[test]
    fn looks_match_the_shared_cases() {
        let cases = shared_cases();
        assert!(cases.len() > 5);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let row = &case["input"]["button"];
            let mut v = json!({ "id": "abcd1234", "title": "Go" });
            if row["kind"] == "send" {
                v["send"] = json!({ "threadId": "t0", "threadTitle": row["target"], "text": "x" });
            } else {
                v["start"] = json!({ "text": "x", "cwd": "/x" });
            }
            if let Some(id) = row["pressedThreadId"].as_str() {
                v["pressed"] = json!({ "at": "2026-11-20T00:00:00Z", "threadId": id });
            }
            if let Some(error) = row["failed"].as_str() {
                v["failed"] = json!({ "at": "2026-11-20T00:00:00Z", "error": error });
            }
            let b = button(v);
            let press = case["input"]["press"]["state"].as_str().unwrap();
            assert!(
                matches!(press, "none" | "sending" | "pending" | "taken"),
                "{name}: the desktop app has no {press} press"
            );
            let got = match look(&b, press != "none") {
                Look::Start | Look::Send | Look::Panel => json!({ "look": "ready" }),
                Look::Pressing => json!({ "look": "pressing" }),
                Look::Pressed => {
                    json!({ "look": "pressed", "threadId": b.pressed.as_ref().map(|p| p.thread_id.clone()) })
                }
                Look::Failed => {
                    json!({ "look": "failed", "error": b.failed.as_ref().map(|f| f.error.clone()) })
                }
            };
            assert_eq!(got, case["expect"], "{name}");
        }
    }

    /// A button link this app can't draw as a pill is its words, against
    /// the phones' cases (shared/cases/reply-button-links.json).
    #[test]
    fn unlinking_matches_the_shared_cases() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/cases/reply-button-links.json"
        );
        let file: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut ran = 0;
        for case in file["cases"].as_array().unwrap() {
            if case["differs"].get("desktop").is_some() || case["input"]["op"] != "unlink" {
                continue;
            }
            let name = case["name"].as_str().unwrap();
            let known: Vec<&str> = case["input"]["known"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|k| k.as_str())
                .collect();
            let text = case["input"]["text"].as_str().unwrap();
            assert_eq!(
                unlink(text, |id| known.contains(&id)),
                case["expect"]["text"].as_str().unwrap(),
                "{name}"
            );
            ran += 1;
        }
        assert!(ran >= 3);
    }
}
