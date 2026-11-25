// The composer's quick send times: the arrow beside Send, and Send's
// right-click, offer tonight at 9 pm, tomorrow at 9 am and the next known
// token reset, each opening the schedule editor on Once at that time
// (desktop/gpui/src/composer_send.rs draws them).
use crate::logins::{Account, RunnerLogins};
use crate::new_thread::{main_windows, pool_logins, tightest, usage_of, PICK_FLOOR};
use chrono::{DateTime, TimeZone};

/// A minute after a reset, as the runner's waits end (`WAIT_SLACK_MS` in
/// runner/src/pools.ts), so the provider has caught up.
const RESET_SLACK_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Tonight,
    Tomorrow,
    TokenReset,
}

/// One row of the menu: what it says, and when it would send (None when it
/// can't say, which leaves the row there but disabled).
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub preset: Preset,
    pub title: String,
    pub at: Option<i64>,
}

/// Today at 9 pm, by the local calendar; None once it's gone, so the menu
/// never calls tomorrow night "tonight".
pub fn tonight<Tz: TimeZone>(now: &DateTime<Tz>) -> Option<i64> {
    let at = local_at(now, 0, 21)?;
    (at > now.timestamp_millis()).then_some(at)
}

/// Tomorrow at 9 am, by the local calendar rather than 24 hours on, which
/// a daylight-saving change would put an hour out.
pub fn tomorrow<Tz: TimeZone>(now: &DateTime<Tz>) -> Option<i64> {
    local_at(now, 1, 9)
}

fn local_at<Tz: TimeZone>(now: &DateTime<Tz>, days_on: u64, hour: u32) -> Option<i64> {
    let day = now
        .date_naive()
        .checked_add_days(chrono::Days::new(days_on))?;
    let at = day.and_hms_opt(hour, 0, 0)?;
    now.timezone()
        .from_local_datetime(&at)
        .earliest()
        .map(|d| d.timestamp_millis())
}

/// When the box's login has room again, plus a minute: a pinned login's own
/// reset, or for a pool the earliest among its logins of the box's kind
/// (the schedule keeps the pool, so the runner still picks the login when
/// it runs).
pub fn token_reset(
    logins: &RunnerLogins,
    account_id: &str,
    pool_id: Option<&str>,
    provider: &str,
    now_ms: i64,
) -> Option<i64> {
    match pool_id {
        Some(pool_id) => {
            let pool = logins.pools.iter().find(|p| p.id == pool_id)?;
            pool_logins(pool, &logins.accounts, Some(provider))
                .into_iter()
                .filter_map(|a| account_reset(a, now_ms))
                .min()
        }
        None => account_reset(logins.accounts.iter().find(|a| a.id == account_id)?, now_ms),
    }
}

/// A known reset, never a guess. Out of room: when every window holding it
/// back has reset, as the runner's `backAt` has it (runner/src/pools.ts),
/// the tightest window when the provider says it's blocked with none at its
/// limit. With room: the next reset of a window it has used. Old readings,
/// a reset that's missing or gone by, and a login only signing in again
/// brings back say nothing.
fn account_reset(account: &Account, now_ms: i64) -> Option<i64> {
    if account.signed_out || account.plan_ended {
        return None;
    }
    if account.usage.as_ref()?["stale"].as_bool() == Some(true) {
        return None;
    }
    let usage = usage_of(account)?;
    let main = main_windows(&usage);
    let mut holding: Vec<_> = main
        .iter()
        .copied()
        .filter(|w| w.remaining_percent < PICK_FLOOR)
        .collect();
    if holding.is_empty() && usage.blocked {
        holding.push(tightest(&usage)?);
    }
    let at = if holding.is_empty() {
        main.iter()
            .filter(|w| w.remaining_percent < 100.)
            .filter_map(|w| w.resets_at.filter(|at| *at > now_ms))
            .min()?
    } else {
        holding
            .iter()
            .map(|w| w.resets_at.filter(|at| *at > now_ms))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .max()?
    };
    at.checked_add(RESET_SLACK_MS)
}

/// The menu's quick times, in order. Tonight drops out after 9 pm; the
/// token reset stays, disabled, when no reset is known.
pub fn choices<Tz: TimeZone>(now: &DateTime<Tz>, token_reset: Option<i64>) -> Vec<Choice> {
    let mut out = Vec::new();
    if let Some(at) = tonight(now) {
        out.push(Choice {
            preset: Preset::Tonight,
            title: "Send tonight at 9 pm…".into(),
            at: Some(at),
        });
    }
    out.push(Choice {
        preset: Preset::Tomorrow,
        title: "Send tomorrow at 9 am…".into(),
        at: tomorrow(now),
    });
    out.push(Choice {
        preset: Preset::TokenReset,
        title: match token_reset {
            Some(at) => format!(
                "Send when tokens reset ({})…",
                crate::usage::when(at, now.timestamp_millis(), &now.timezone())
            ),
            None => "Send when tokens reset (time not known)".into(),
        },
        at: token_reset,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logins::Pool;
    use chrono::FixedOffset;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn account(
        id: &str,
        five: f64,
        week: f64,
        five_at: Option<i64>,
        week_at: Option<i64>,
    ) -> Account {
        let iso = |at: Option<i64>| at.map(crate::inbox::iso_time);
        Account {
            id: id.into(),
            provider: "codex".into(),
            usage: Some(json!({ "windows": [
                { "kind": "five_hour", "remainingPercent": five, "resetsAt": iso(five_at) },
                { "kind": "weekly", "remainingPercent": week, "resetsAt": iso(week_at) }
            ]})),
            ..Default::default()
        }
    }

    #[test]
    fn calendar_times_go_by_the_local_clock_and_tonight_goes_at_nine() {
        let tz = FixedOffset::west_opt(8 * 3600).unwrap();
        let ms = |d, h| {
            tz.with_ymd_and_hms(2026, 11, d, h, 0, 0)
                .unwrap()
                .timestamp_millis()
        };
        let five_pm = tz.with_ymd_and_hms(2026, 11, 19, 17, 0, 0).unwrap();
        assert_eq!(tonight(&five_pm), Some(ms(19, 21)));
        assert_eq!(tomorrow(&five_pm), Some(ms(20, 9)));
        let nine_pm = tz.with_ymd_and_hms(2026, 11, 19, 21, 0, 0).unwrap();
        assert_eq!(tonight(&nine_pm), None);
        let titles: Vec<_> = choices(&nine_pm, None)
            .into_iter()
            .map(|c| c.title)
            .collect();
        assert_eq!(
            titles,
            [
                "Send tomorrow at 9 am…",
                "Send when tokens reset (time not known)"
            ]
        );
        let c = choices(&five_pm, Some(ms(19, 18) + 60_000));
        assert_eq!(c[0].title, "Send tonight at 9 pm…");
        assert_eq!(c[2].title, "Send when tokens reset (6:01 pm)…");
    }

    #[test]
    fn out_of_room_waits_for_every_window_holding_it_back_plus_a_minute() {
        let a = account("a", 0., 0., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        assert_eq!(account_reset(&a, NOW), Some(NOW + 24 * HOUR + 60_000));
        let a = account("a", 0., 50., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        assert_eq!(account_reset(&a, NOW), Some(NOW + HOUR + 60_000));
    }

    #[test]
    fn with_room_it_waits_for_the_next_used_window_to_refill() {
        let a = account("a", 30., 60., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        assert_eq!(account_reset(&a, NOW), Some(NOW + HOUR + 60_000));
    }

    #[test]
    fn a_blocked_login_with_room_waits_for_its_tightest_window() {
        let mut a = account("a", 30., 2., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        a.usage.as_mut().unwrap()["blocked"] = json!(true);
        assert_eq!(account_reset(&a, NOW), Some(NOW + 24 * HOUR + 60_000));
    }

    #[test]
    fn missing_old_or_gone_by_resets_arent_guessed() {
        let a = account("a", 0., 0., Some(NOW + HOUR), None);
        assert_eq!(
            account_reset(&a, NOW),
            None,
            "a window holding it back has no reset"
        );
        let a = account("a", 0., 50., Some(NOW - 1), Some(NOW + 24 * HOUR));
        assert_eq!(account_reset(&a, NOW), None, "its reset has gone by");
        let mut a = account("a", 20., 50., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        a.usage.as_mut().unwrap()["stale"] = json!(true);
        assert_eq!(account_reset(&a, NOW), None, "old readings");
        let mut a = account("a", 0., 50., Some(NOW + HOUR), Some(NOW + 24 * HOUR));
        a.signed_out = true;
        assert_eq!(
            account_reset(&a, NOW),
            None,
            "only signing in brings it back"
        );
        assert_eq!(account_reset(&Account::default(), NOW), None, "no readings");
    }

    #[test]
    fn a_pool_goes_by_its_earliest_login_of_the_boxs_kind() {
        let a = account("a", 0., 0., Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        let b = account("b", 0., 50., Some(NOW + 4 * HOUR), None);
        let mut c = account("c", 0., 50., Some(NOW + 2 * HOUR), None);
        c.provider = "claude".into();
        let logins = RunnerLogins {
            accounts: vec![a, b, c],
            pools: vec![Pool {
                id: "p".into(),
                account_ids: vec!["a".into(), "b".into(), "c".into()],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            token_reset(&logins, "a", Some("p"), "codex", NOW),
            Some(NOW + 4 * HOUR + 60_000)
        );
        assert_eq!(
            token_reset(&logins, "a", Some("p"), "claude", NOW),
            Some(NOW + 2 * HOUR + 60_000)
        );
        assert_eq!(
            token_reset(&logins, "a", None, "codex", NOW),
            Some(NOW + 8 * HOUR + 60_000)
        );
        assert_eq!(
            token_reset(&logins, "a", Some("missing"), "codex", NOW),
            None
        );
    }
}
