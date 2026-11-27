//! The runner's message when another lab's review comes back
//! (runner/src/runner/hibernation.ts `deliverReview`, lab-review.ts
//! `panelWake` and `findingLine`), read back into its findings so the
//! transcript can draw a checklist rather than the whole message.
//!
//! The message is written for the agent: the findings numbered, the
//! reviewer's reply repeating them in detail, then how to answer them in
//! end_turn. Drawn as it was, a centred wall of grey text with raw markdown
//! (Mike, 25 Nov 2026: "Can we render these code review sections a little
//! bit nicer?"). He picked a live checklist: a row per finding, its case on
//! a click, and what the agent did about it filled in once it answers (from
//! the turn's ledger, `LabReview`).
//!
//! A message this can't read stays the plain note it was, so a change to the
//! runner's wording costs looks, not the message.

use super::event::ReviewFinding;

/// A review that came back, as its message says.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ReviewNote {
    /// Who reviewed: "Codex", or a panel's names ("Codex and Gemini").
    pub reviewer: String,
    /// The review threads' short ids, in the message's order.
    pub thread_ids: Vec<String>,
    /// 1 unless the message says which round it was.
    pub round: i64,
    /// Numbered findings; empty when nothing held up.
    pub findings: Vec<ReviewFinding>,
    /// The reviewers' own replies (markdown), and anything else the runner
    /// told the agent about the review, without the instructions on how to
    /// answer it.
    pub reply: String,
}

const SINGLE: &str = " reviewed the change you just made";
const PANEL: &str = "A review panel checked the change you just made";
const NUMBERED: &str = " Its findings, numbered:\n\n";
const PANEL_NUMBERED: &str = " Their findings, numbered together";
const NOTHING: &str = " and found nothing that holds up.";
const PANEL_NOTHING: &str = " None of them found anything that holds up.";
/// Where the instructions to the agent start: none of this is Mike's.
const TAILS: [&str; 2] = [
    "\n\nCheck each finding against the code:",
    "\n\nSay so in a line in your reply",
];

impl ReviewNote {
    /// The review in a runner's message, or None when it isn't one this
    /// knows how to read (an unstructured review's message, say).
    pub fn parse(text: &str) -> Option<ReviewNote> {
        let text = text.trim();
        if let Some(rest) = text.strip_prefix(PANEL) {
            return Self::parse_panel(rest);
        }
        let at = text.find(SINGLE)?;
        let who = &text[..at];
        if who.is_empty() || who.contains('\n') || who.len() > 60 {
            return None;
        }
        let rest = &text[at + SINGLE.len()..];
        let (round, rest) = take_round(rest);
        let rest = rest.strip_prefix(" (thread ")?;
        let (id, rest) = rest.split_once(')')?;
        let mut note = ReviewNote {
            reviewer: who.to_owned(),
            thread_ids: vec![id.to_owned()],
            round,
            ..ReviewNote::default()
        };
        if let Some(rest) = rest.strip_prefix(NOTHING) {
            note.reply = reply_part(rest, &["Its reply:\n\n"]);
            return Some(note);
        }
        let rest = rest.strip_prefix('.')?.strip_prefix(NUMBERED)?;
        let (findings, rest) = findings_block(rest)?;
        note.findings = findings;
        note.reply = reply_part(rest, &["Its reply, with the detail:\n\n"]);
        Some(note)
    }

    fn parse_panel(rest: &str) -> Option<ReviewNote> {
        let (round, rest) = take_round(rest);
        let rest = rest.strip_prefix(", each on their own: ")?;
        // The names run to the first ". " that isn't inside brackets:
        // "Codex (thread 1a2b3c4d), Gemini (opencode-main) (thread 5e6f7a8b)."
        let end = sentence_end(rest)?;
        let (names, rest) = (&rest[..end], &rest[end + 1..]);
        let mut note = ReviewNote {
            reviewer: panel_names(names),
            thread_ids: thread_ids(names),
            round,
            ..ReviewNote::default()
        };
        if let Some(rest) = rest.strip_prefix(PANEL_NOTHING) {
            note.reply = reply_part(rest, &[]);
            return Some(note);
        }
        let rest = rest.strip_prefix(PANEL_NUMBERED)?;
        let (_, rest) = rest.split_once(":\n\n")?;
        let (findings, rest) = findings_block(rest)?;
        note.findings = findings;
        note.reply = reply_part(rest, &[]);
        Some(note)
    }

    /// The heading over the checklist: "Codex · 3 findings", with the round
    /// from the second on.
    pub fn heading(&self) -> String {
        let count = match self.findings.len() {
            0 => "nothing found".to_owned(),
            1 => "1 finding".to_owned(),
            n => format!("{n} findings"),
        };
        let round = if self.round > 1 {
            format!(" · round {}", self.round)
        } else {
            String::new()
        };
        format!("{} · {count}{round}", self.reviewer)
    }
}

/// " (review round 2)" at the front, as the round and what follows.
fn take_round(rest: &str) -> (i64, &str) {
    if let Some(r) = rest.strip_prefix(" (review round ") {
        if let Some((n, after)) = r.split_once(')') {
            if let Ok(n) = n.parse() {
                return (n, after);
            }
        }
    }
    (1, rest)
}

/// The index of the "." that ends the panel's list of names: the first one
/// outside brackets followed by a space or the end.
fn sentence_end(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'.' if depth == 0 && matches!(bytes.get(i + 1), None | Some(b' ' | b'\n')) => {
                return Some(i)
            }
            _ => {}
        }
    }
    None
}

/// "Codex (thread 1a2b3c4d), Gemini (opencode-main) (thread 5e6f7a8b)" as
/// "Codex and Gemini": names without their logins or threads.
fn panel_names(names: &str) -> String {
    let names: Vec<&str> = split_top(names)
        .into_iter()
        .map(|n| n.split(" (").next().unwrap_or(n).trim())
        .filter(|n| !n.is_empty())
        .collect();
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.concat(),
    }
}

/// The list split at the commas outside brackets.
fn split_top(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut from) = (0i32, 0);
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&text[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[from..]);
    out
}

fn thread_ids(names: &str) -> Vec<String> {
    names
        .split("(thread ")
        .skip(1)
        .filter_map(|s| s.split_once(')').map(|(id, _)| id.to_owned()))
        .collect()
}

/// The numbered findings up to the first blank line, and the rest. A
/// finding whose claim or case ran over a line keeps its later lines.
fn findings_block(text: &str) -> Option<(Vec<ReviewFinding>, &str)> {
    let (block, rest) = text.split_once("\n\n").unwrap_or((text, ""));
    let mut findings: Vec<ReviewFinding> = Vec::new();
    for line in block.lines() {
        if let Some(finding) = parse_finding(line) {
            findings.push(finding);
            continue;
        }
        // A line before any finding: not a list this can read.
        let last = findings.last_mut()?;
        let field = last.case.as_mut().unwrap_or(&mut last.claim);
        field.push(' ');
        field.push_str(line.trim());
    }
    (!findings.is_empty()).then_some((findings, rest))
}

/// `findingLine`: `#1 [medium] (Codex) disk_watch.sh:33: claim Case: case`,
/// the reviewer and the place each there or not.
fn parse_finding(line: &str) -> Option<ReviewFinding> {
    let rest = line.strip_prefix('#')?;
    let (number, rest) = rest.split_once(' ')?;
    let id: i64 = number.parse().ok()?;
    let rest = rest.strip_prefix('[')?;
    let (severity, mut rest) = rest.split_once(']')?;
    if !matches!(severity, "high" | "medium" | "low") {
        return None;
    }
    let mut by = None;
    if let Some(inner) = rest.strip_prefix(" (") {
        // Its own brackets can hold a login: "(Gemini (opencode-main))".
        let mut depth = 1i32;
        let close = inner.char_indices().find_map(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(i)
        })?;
        by = Some(inner[..close].to_owned());
        rest = &inner[close + 1..];
    }
    let mut rest = rest.strip_prefix(' ').unwrap_or(rest);
    let mut place = None;
    if let Some((token, after)) = rest.split_once(": ") {
        if !token.is_empty() && !token.contains(' ') && (token.contains('/') || token.contains('.'))
        {
            place = Some(token.to_owned());
            rest = after;
        }
    }
    let (claim, case) = match rest.split_once(" Case: ") {
        Some((claim, case)) => (claim, Some(case.trim().to_owned())),
        None => (rest, None),
    };
    Some(ReviewFinding {
        id,
        round: 0,
        severity: severity.to_owned(),
        claim: claim.trim().to_owned(),
        where_: place,
        case,
        outcome: None,
        note: None,
        by,
    })
}

/// What's left after the findings, without its own heading or the
/// instructions on how to answer.
fn reply_part(rest: &str, headings: &[&str]) -> String {
    let mut rest = rest.trim_start_matches('\n');
    for heading in headings {
        if let Some(r) = rest.strip_prefix(heading) {
            rest = r;
        }
    }
    let end = TAILS
        .iter()
        .filter_map(|tail| rest.rfind(tail))
        .min()
        .unwrap_or(rest.len());
    rest[..end].trim().to_owned()
}

/// A finding's place as a short name: `/a/b/disk_watch.sh:33` is
/// `disk_watch.sh:33`.
pub fn short_place(place: &str) -> &str {
    place.rsplit('/').next().unwrap_or(place)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SINGLE_MSG: &str = "Codex reviewed the change you just made (thread 3f88a92e). Its findings, numbered:\n\n#1 [medium] /Users/m/dev/bruce-ops/disk_watch.sh:33: An empty timestamp file causes arithmetic errors. Case: If a full disk leaves last-snapshot empty, age produces no number; reproduced with Bash.\n#2 [high] disk_watch.sh:22: The scanned roots omit system logs.\n#3 [low] The baseline is skipped. Case: With no state and 10 GB free.\n\nIts reply, with the detail:\n\n1. **Medium — [disk_watch.sh:33](/x)**: Empty timestamps.\n\n2. More.\n\nCheck each finding against the code: fix what holds up and run the tests again. When you call end_turn, answer every one.";

    #[test]
    fn reads_a_single_review() {
        let note = ReviewNote::parse(SINGLE_MSG).expect("parses");
        assert_eq!(note.reviewer, "Codex");
        assert_eq!(note.thread_ids, vec!["3f88a92e"]);
        assert_eq!(note.round, 1);
        assert_eq!(note.findings.len(), 3);
        let f = &note.findings[0];
        assert_eq!(f.id, 1);
        assert_eq!(f.severity, "medium");
        assert_eq!(
            f.where_.as_deref(),
            Some("/Users/m/dev/bruce-ops/disk_watch.sh:33")
        );
        assert_eq!(f.claim, "An empty timestamp file causes arithmetic errors.");
        assert!(f.case.as_deref().unwrap().starts_with("If a full disk"));
        assert_eq!(note.findings[1].severity, "high");
        assert_eq!(note.findings[1].case, None);
        assert_eq!(note.findings[2].where_, None);
        assert_eq!(note.findings[2].claim, "The baseline is skipped.");
        assert_eq!(
            note.reply,
            "1. **Medium — [disk_watch.sh:33](/x)**: Empty timestamps.\n\n2. More."
        );
        assert_eq!(note.heading(), "Codex · 3 findings");
        assert_eq!(
            short_place(f.where_.as_deref().unwrap()),
            "disk_watch.sh:33"
        );
    }

    #[test]
    fn reads_a_later_round_with_nothing_found() {
        let text = "Gemini reviewed the change you just made (review round 2) (thread 0a1b2c3d) and found nothing that holds up.\n\nIts reply:\n\nAll good.\n\nSay so in a line in your reply and finish as you were.";
        let note = ReviewNote::parse(text).expect("parses");
        assert_eq!(note.round, 2);
        assert!(note.findings.is_empty());
        assert_eq!(note.reply, "All good.");
        assert_eq!(note.heading(), "Gemini · nothing found · round 2");
    }

    #[test]
    fn reads_a_panel() {
        let text = "A review panel checked the change you just made, each on their own: Codex (thread 11111111), Gemini (opencode-main) (thread 22222222). Their findings, numbered together (one may repeat another's: answer it the same way):\n\n#4 [high] (Gemini (opencode-main)) src/a.ts:9: Breaks.\n   still the claim\n#5 [medium] (Codex) Slow.\n\nCodex's reply:\n\nSlow.\n\nGemini (opencode-main)'s reply:\n\nBreaks.\n\nCheck each finding against the code: fix what holds up.";
        let note = ReviewNote::parse(text).expect("parses");
        assert_eq!(note.reviewer, "Codex and Gemini");
        assert_eq!(note.thread_ids, vec!["11111111", "22222222"]);
        assert_eq!(note.findings[0].id, 4);
        assert_eq!(
            note.findings[0].by.as_deref(),
            Some("Gemini (opencode-main)")
        );
        assert_eq!(note.findings[0].where_.as_deref(), Some("src/a.ts:9"));
        assert_eq!(note.findings[0].claim, "Breaks. still the claim");
        assert_eq!(note.findings[1].by.as_deref(), Some("Codex"));
        assert!(note.reply.starts_with("Codex's reply:"));
        assert!(note.reply.ends_with("Breaks."));
    }

    #[test]
    fn leaves_other_messages_alone() {
        for text in [
            "Codex reviewed the change you just made (thread 3f88a92e). Its findings:\n\nfree text",
            "The review of your change (thread 3f88a92e) was archived before it finished.",
            "Moved to another login",
            "",
        ] {
            assert_eq!(ReviewNote::parse(text), None, "{text}");
        }
    }
}
