// Use this Mac's Claude logins on another runner, from the Runners panel
// (docs/protocol/settings.md, Accounts, "This Mac's logins on another
// runner"; `runners.sharedLogins` and `runners.shareLogins`). On, the main
// Mac's runner sends its Claude logins that have year-long tokens to that
// runner, sealed to its key, and again whenever one is renewed; off, that
// runner removes the ones it got this way. The words and rules are here; the
// panel (desktop/gpui/src/runners_panel.rs) only draws them.
use serde::Deserialize;
use serde_json::Value;

pub const SWITCH: &str = "Use this Mac's Claude logins";
pub const SENDING: &str = "Sending this Mac's logins…";
pub const REMOVING: &str = "Taking this Mac's logins off…";
pub const NONE_TO_SHARE: &str = "This Mac has no logins with year-long tokens to share.";

/// One login's line in that runner's answer.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SharedLogin {
    pub email: String,
    pub state: String,
    pub account_id: Option<String>,
    pub message: Option<String>,
}

/// `runners.sharedLogins`' row for one runner, or `runners.shareLogins`' answer.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Share {
    pub runner_id: String,
    pub on: bool,
    pub state: String,
    pub at: Option<String>,
    pub message: Option<String>,
    pub logins: Vec<SharedLogin>,
}

/// `runners.sharedLogins`' answer: each runner's row, and why this Mac can't
/// share at all (a runner key, sync off, an older backend), which hides the
/// switch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shares {
    pub rows: Vec<Share>,
    pub blocked: Option<String>,
}

pub fn decode(value: &Value) -> Shares {
    Shares {
        rows: value["runners"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| serde_json::from_value::<Share>(r.clone()).ok())
            .filter(|r| !r.runner_id.is_empty())
            .collect(),
        blocked: value["blocked"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    }
}

/// The switch's tooltip: what a click does now.
pub fn tip(on: bool, runner: &str) -> String {
    if on {
        format!("Take this Mac's Claude logins off {runner}")
    } else {
        format!("Send this Mac's Claude logins with year-long tokens to {runner}, and keep them up to date")
    }
}

/// The lines under the switch: what's going on, or what's there from this
/// Mac and what's in the way. `going` is the click still on its way, and
/// which way.
pub fn lines(share: Option<&Share>, going: Option<bool>) -> Vec<String> {
    match going {
        Some(true) => return vec![SENDING.to_owned()],
        Some(false) => return vec![REMOVING.to_owned()],
        None => {}
    }
    let Some(s) = share.filter(|s| s.on || s.state != "off") else {
        return Vec::new();
    };
    if s.state == "sending" {
        return vec![if s.on { SENDING } else { REMOVING }.to_owned()];
    }
    let mut out = Vec::new();
    if s.on {
        let from_here: Vec<&str> = s
            .logins
            .iter()
            .filter(|l| matches!(l.state.as_str(), "added" | "updated" | "same" | "adopted"))
            .map(|l| l.email.as_str())
            .collect();
        let here: Vec<&str> = s
            .logins
            .iter()
            .filter(|l| l.state == "here")
            .map(|l| l.email.as_str())
            .collect();
        if !from_here.is_empty() {
            out.push(format!("From this Mac: {}", from_here.join(", ")));
        }
        if !here.is_empty() {
            out.push(format!("Signed in there already: {}", here.join(", ")));
        }
        if s.state == "ok" && s.logins.is_empty() {
            out.push(NONE_TO_SHARE.to_owned());
        }
    }
    if let Some(m) = s
        .message
        .as_deref()
        .filter(|m| !m.trim().is_empty() && s.state != "ok")
    {
        out.push(m.to_owned());
    }
    out
}

/// The switch's state as drawn: the click on its way wins, then the runner's.
pub fn shown_on(share: Option<&Share>, going: Option<bool>) -> bool {
    going.unwrap_or_else(|| share.is_some_and(|s| s.on))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(on: bool, state: &str, logins: Value, message: Option<&str>) -> Share {
        decode(&json!({ "runners": [{ "runnerId": "bruce", "on": on, "state": state, "logins": logins, "message": message }] }))
            .rows
            .remove(0)
    }

    #[test]
    fn rows_decode_and_blocked_hides_the_switch() {
        let s = decode(
            &json!({ "runners": [{ "runnerId": "bruce", "on": true, "state": "ok", "logins": [{ "email": "a@x.com", "state": "added", "accountId": "claude-5" }] }, { "on": true }] }),
        );
        assert_eq!(s.rows.len(), 1, "a row with no runner is dropped");
        assert_eq!(s.rows[0].logins[0].account_id.as_deref(), Some("claude-5"));
        assert_eq!(s.blocked, None);
        assert_eq!(
            decode(&json!({ "runners": [], "blocked": "Only the main Mac's runner shares its logins." })).blocked.as_deref(),
            Some("Only the main Mac's runner shares its logins.")
        );
    }

    #[test]
    fn the_lines_say_what_came_from_here_and_what_was_there() {
        let s = row(
            true,
            "ok",
            json!([{ "email": "a@x.com", "state": "added" }, { "email": "b@x.com", "state": "same" }, { "email": "c@x.com", "state": "here" }]),
            None,
        );
        assert_eq!(
            lines(Some(&s), None),
            vec![
                "From this Mac: a@x.com, b@x.com",
                "Signed in there already: c@x.com"
            ]
        );
        assert_eq!(
            lines(Some(&row(true, "ok", json!([]), None)), None),
            vec![NONE_TO_SHARE]
        );
        assert_eq!(
            lines(
                Some(&row(
                    true,
                    "waiting",
                    json!([]),
                    Some("bruce is offline: they go when it's back.")
                )),
                None
            ),
            vec!["bruce is offline: they go when it's back."]
        );
        assert_eq!(
            lines(Some(&row(false, "off", json!([]), None)), None),
            Vec::<String>::new()
        );
        assert_eq!(lines(None, Some(true)), vec![SENDING]);
        assert_eq!(lines(Some(&s), Some(false)), vec![REMOVING]);
        assert!(
            shown_on(Some(&s), None)
                && !shown_on(Some(&s), Some(false))
                && shown_on(None, Some(true))
        );
    }

    #[test]
    fn the_tip_says_what_a_click_does() {
        assert!(tip(false, "bruce").starts_with("Send this Mac's Claude logins"));
        assert_eq!(
            tip(true, "bruce"),
            "Take this Mac's Claude logins off bruce"
        );
    }
}
