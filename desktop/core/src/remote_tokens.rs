// Year-long tokens for another runner's Claude logins, from the Runners
// panel (docs/protocol/settings.md, Accounts, "Year-long tokens on another runner",
// and `accounts.yearToken`). The Usage panel's Terminal helper only reaches
// this Mac's logins; for bruce, Tinker Desk or a WSL box the runner there
// runs `claude setup-token` itself and sends back only the claude.ai page to
// approve it on. Mike approves it in his browser, presses Copy code on the
// page it ends on, and Paste code here sends that code to the runner. The
// token never leaves that machine. The words and rules are here; the panel
// (desktop/gpui/src/runners_panel.rs) only draws them.
use crate::inbox::parse_ms;
use crate::logins::{Account, RunnerLogins};
use crate::usage::{sign_in_ends_words, year_token_words};
use chrono::TimeZone;
use serde::Deserialize;

pub const HEADING: &str = "Claude logins";
pub const WAITING: &str =
    "Approve it in your browser, press Copy code on the page it ends on, then Paste code.";
pub const BAD_CODE: &str = "That isn't the code from this page.";
pub const NO_CODE: &str = "There's no code on the clipboard. Press Copy code on the page first.";
pub const DONE: &str = "Year-long token made.";
pub const STARTING: &str = "Starting claude setup-token there…";
pub const CHECKING: &str = "Checking the code…";
pub const NOT_CLAUDE_PAGE: &str =
    "That runner sent a page that isn't claude.ai's, so Threadbear didn't open it.";
pub const NO_LOGINS: &str = "No Claude logins there.";
pub const LOADING: &str = "Looking for its logins…";

/// `accounts.yearToken`'s answer.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Answer {
    pub state: String,
    pub url: Option<String>,
    pub message: Option<String>,
    pub made_at: Option<String>,
}

/// Where one login's token is, as the panel shows it.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// The click is on its way, or setup-token hasn't printed its page yet.
    Starting,
    /// The page is open in the browser; the code is Mike's to paste.
    /// `notice` is a pasted code turned down before it was sent.
    Waiting {
        url: String,
        notice: Option<String>,
    },
    /// The code went; the runner is checking it.
    Checking {
        url: String,
    },
    Done,
    Failed(String),
}

impl Step {
    /// Polling goes on while the runner has something to say next.
    pub fn polls(&self) -> bool {
        matches!(self, Step::Starting | Step::Checking { .. })
    }

    /// The button can't be pressed again while it's going.
    pub fn busy(&self) -> bool {
        matches!(self, Step::Starting | Step::Checking { .. })
    }

    /// Its line under the login, for the panel and the dump.
    pub fn words(&self) -> String {
        match self {
            Step::Starting => STARTING.to_owned(),
            Step::Waiting {
                notice: Some(n), ..
            } => n.clone(),
            Step::Waiting { .. } => WAITING.to_owned(),
            Step::Checking { .. } => CHECKING.to_owned(),
            Step::Done => DONE.to_owned(),
            Step::Failed(m) => m.clone(),
        }
    }

    pub fn url(&self) -> Option<&str> {
        match self {
            Step::Waiting { url, .. } | Step::Checking { url } => Some(url),
            _ => None,
        }
    }
}

/// What an answer makes of the step: a page that isn't claude.ai's is a
/// failure, never something to open.
pub fn step_from(answer: &Answer) -> Step {
    let url = || answer.url.as_deref().and_then(sign_in_page);
    match answer.state.as_str() {
        "starting" => Step::Starting,
        "waiting" | "checking" => match (url(), answer.url.is_some()) {
            (Some(url), _) if answer.state == "waiting" => Step::Waiting { url, notice: None },
            (Some(url), _) => Step::Checking { url },
            (None, true) => Step::Failed(NOT_CLAUDE_PAGE.to_owned()),
            (None, false) => Step::Starting,
        },
        "done" => Step::Done,
        "failed" => Step::Failed(
            answer
                .message
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "The token wasn't made. Try again.".to_owned()),
        ),
        // idle: it stopped (cancelled, or over 10 minutes ago).
        _ => Step::Failed(
            answer
                .message
                .clone()
                .unwrap_or_else(|| "It stopped before the token was made. Try again.".to_owned()),
        ),
    }
}

/// The page, if it's an https page on claude.ai, claude.com or
/// platform.claude.com (a sign-in page from setup-token), else None: a
/// runner is only trusted to send that. Strict rather than parsed: printable
/// ASCII only, no `\`, `@` or an escaped backslash anywhere (a browser
/// takes `https://evil.example\@claude.com/` to evil.example), and the host
/// exactly one of those, lower case, with no port, so what opens is the
/// string checked.
pub fn sign_in_page(url: &str) -> Option<String> {
    if url.len() > 4096
        || !url.chars().all(|c| c.is_ascii_graphic())
        || url.contains(['\\', '@'])
        || url.to_ascii_lowercase().contains("%5c")
    {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    ["claude.ai", "claude.com", "platform.claude.com"]
        .contains(&host)
        .then(|| url.to_owned())
}

/// The page's `state`, which the code it ends on carries after its `#`.
pub fn page_state(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    let query = query.split('#').next().unwrap_or(query);
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("state="))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn code_chars(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// What's on the clipboard, as the code to send for this page: trimmed,
/// `<code>#<state>` with the page's own state, or why not.
pub fn code_for(clipboard: Option<&str>, url: &str) -> Result<String, &'static str> {
    let text = clipboard
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(NO_CODE)?;
    let state = page_state(url).ok_or(BAD_CODE)?;
    let (code, theirs) = text.split_once('#').ok_or(BAD_CODE)?;
    if code_chars(code) && code_chars(theirs) && theirs == state && text.len() <= 1024 {
        Ok(text.to_owned())
    } else {
        Err(BAD_CODE)
    }
}

/// The Claude logins a runner has, in its order.
pub fn claude_logins(logins: &RunnerLogins) -> Vec<&Account> {
    logins
        .accounts
        .iter()
        .filter(|a| a.provider_id() == "claude")
        .collect()
}

/// Whether a token can be made for it from here: not a lapsed plan, which
/// has no Claude Code whatever the sign-in.
pub fn can_token(account: &Account) -> bool {
    account.provider_id() == "claude" && !account.plan_ended
}

pub fn button_label(account: &Account) -> &'static str {
    if account.year_token.is_some() {
        "New token…"
    } else {
        "Year-long token…"
    }
}

pub fn button_tip(account: &Account, runner: &str) -> String {
    format!("Make a year-long token for {} on {runner}, so it doesn't need signing in again every 28 days", account.name())
}

/// The quiet line under a login: its token, its sign-in's end, or that
/// it's signed out. None when there's nothing to say (an older runner
/// sends none of it).
pub fn status<Tz: TimeZone>(account: &Account, now: i64, zone: &Tz) -> Option<String> {
    if account.plan_ended {
        return Some("Plan ended".to_owned());
    }
    if let Some(words) = year_token_words(account, zone) {
        return Some(words);
    }
    if account.signed_out {
        return Some("Signed out".to_owned());
    }
    account
        .login_ends_at
        .as_deref()
        .and_then(parse_ms)
        .map(|at| sign_in_ends_words(at, now, zone))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logins::YearToken;
    use chrono::Utc;

    const PAGE: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0";

    fn answer(state: &str, url: Option<&str>) -> Answer {
        Answer {
            state: state.into(),
            url: url.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn the_code_must_carry_the_pages_own_state() {
        assert_eq!(
            page_state(PAGE).as_deref(),
            Some("Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0")
        );
        let good = "6rrspdXVUDGfsF4pr2VwiXJRNecXr1rliqAIdoQmfroyDg7F#Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0";
        assert_eq!(
            code_for(Some(&format!("  {good}\n")), PAGE).as_deref(),
            Ok(good)
        );
        assert_eq!(
            code_for(
                Some("6rrspdXV#2NTBtmSC9DckEfo_c_gQFgIf9P2jzvmDGrubN3g6ngg"),
                PAGE
            ),
            Err(BAD_CODE),
            "another machine's page"
        );
        assert_eq!(code_for(Some("6rrspdXV"), PAGE), Err(BAD_CODE), "no state");
        assert_eq!(
            code_for(
                Some("6rr\u{1b}[A#Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0"),
                PAGE
            ),
            Err(BAD_CODE),
            "nothing but letters, digits, - and _"
        );
        assert_eq!(
            code_for(
                Some("6rr spd#Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0"),
                PAGE
            ),
            Err(BAD_CODE)
        );
        assert_eq!(code_for(Some("   "), PAGE), Err(NO_CODE));
        assert_eq!(code_for(None, PAGE), Err(NO_CODE));
        assert_eq!(
            code_for(Some("abc#def"), "https://claude.ai/oauth/authorize?x=1"),
            Err(BAD_CODE),
            "a page with no state takes no code"
        );
    }

    #[test]
    fn only_a_claude_page_is_opened() {
        assert_eq!(sign_in_page(PAGE).as_deref(), Some(PAGE));
        assert!(sign_in_page("https://claude.ai/oauth/authorize?state=x").is_some());
        assert!(sign_in_page("http://claude.ai/oauth").is_none());
        assert!(sign_in_page("https://claude.ai.evil.com/oauth").is_none());
        assert!(sign_in_page("https://evilclaude.ai/").is_none());
        assert!(sign_in_page("https://evil.com/?https://claude.ai").is_none());
        assert!(sign_in_page("file:///etc/passwd").is_none());
        assert!(sign_in_page("https://claude.ai/a b").is_none());
        assert!(
            sign_in_page("https://evil.example\\@a.claude.com/").is_none(),
            "a backslash makes evil.example the host"
        );
        assert!(sign_in_page("https://evil.example\\@claude.com/").is_none());
        assert!(
            sign_in_page("https://user:pw@claude.ai/").is_none(),
            "no userinfo"
        );
        assert!(sign_in_page("https://claude.ai@evil.com/").is_none());
        assert!(sign_in_page("https://evil.example%5C@claude.ai/").is_none());
        assert!(sign_in_page("https://claude.ai/x?a=%5c").is_none());
        assert!(
            sign_in_page("https://CLAUDE.AI/oauth").is_none(),
            "the host as setup-token prints it"
        );
        assert!(
            sign_in_page("https://claude.ai:8443/oauth").is_none(),
            "no port"
        );
        assert!(
            sign_in_page("https://a.claude.com/oauth").is_none(),
            "only the three hosts"
        );
        assert!(sign_in_page("https://platform.claude.com/oauth/code/callback").is_some());
        assert!(sign_in_page("https://claude.ai/\u{202e}x").is_none());
        assert_eq!(
            step_from(&answer("waiting", Some("https://evil.com/x"))),
            Step::Failed(NOT_CLAUDE_PAGE.into())
        );
    }

    #[test]
    fn answers_become_steps() {
        assert_eq!(step_from(&answer("starting", None)), Step::Starting);
        assert_eq!(
            step_from(&answer("waiting", Some(PAGE))),
            Step::Waiting {
                url: PAGE.into(),
                notice: None
            }
        );
        assert_eq!(
            step_from(&answer("checking", Some(PAGE))),
            Step::Checking { url: PAGE.into() }
        );
        assert_eq!(step_from(&answer("done", None)), Step::Done);
        assert_eq!(
            step_from(&Answer {
                state: "failed".into(),
                message: Some("Claude didn't take that code.".into()),
                ..Default::default()
            }),
            Step::Failed("Claude didn't take that code.".into())
        );
        assert!(matches!(step_from(&answer("idle", None)), Step::Failed(_)));
        assert!(Step::Starting.polls() && Step::Checking { url: PAGE.into() }.busy());
        assert!(!Step::Waiting {
            url: PAGE.into(),
            notice: None
        }
        .busy());
        assert_eq!(
            Step::Waiting {
                url: PAGE.into(),
                notice: Some(BAD_CODE.into())
            }
            .words(),
            BAD_CODE
        );
    }

    #[test]
    fn a_logins_line_and_button() {
        let zone = Utc;
        let now = parse_ms("2026-11-19T00:00:00Z").unwrap();
        let mut a = Account {
            id: "claude-main".into(),
            provider: "claude".into(),
            email: Some("me@example.com".into()),
            ..Default::default()
        };
        assert_eq!(status(&a, now, &zone), None, "an older runner says nothing");
        assert_eq!(button_label(&a), "Year-long token…");
        a.login_ends_at = Some("2026-12-01T00:00:00Z".into());
        assert!(status(&a, now, &zone).unwrap().starts_with("Sign-in ends"));
        a.signed_out = true;
        assert_eq!(status(&a, now, &zone).as_deref(), Some("Signed out"));
        a.year_token = Some(YearToken {
            made_at: Some("2026-11-18T00:00:00Z".into()),
        });
        assert_eq!(
            status(&a, now, &zone).as_deref(),
            Some("Year-long token until 18 Nov 2027")
        );
        assert_eq!(button_label(&a), "New token…");
        a.plan_ended = true;
        assert!(!can_token(&a));
        assert_eq!(status(&a, now, &zone).as_deref(), Some("Plan ended"));
        let codex = Account {
            id: "codex-main".into(),
            provider: "codex".into(),
            ..Default::default()
        };
        let logins = RunnerLogins {
            accounts: vec![a, codex],
            ..Default::default()
        };
        assert_eq!(claude_logins(&logins).len(), 1);
    }
}
