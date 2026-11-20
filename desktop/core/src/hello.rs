//! The hello cards: the first-run setup a new install sees before the app,
//! one small card per decision (Mike picked it on 17 Nov, after trying
//! Capy's). What each card says, which cards show, and what they read from
//! what the app already knows: the logins, the pools, the paired devices.
//! The GPUI app draws them (gpui/src/hello.rs). Help > Take the Tour still
//! has the coach-mark tour (tour.rs) for anyone who wants a look round.

use crate::devices::{Device, Kind};
use crate::logins::{Account, Pool};

/// One card. They go in this order; Phone only shows where there's a
/// backend to pair with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Card {
    Welcome,
    Agents,
    Folder,
    Phone,
    Extras,
}

/// Which of the six bear pictures a card shows (docs/threadbear-design/sprites).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pose {
    Wave,
    Sit,
    Cub,
    Sleep,
    Patch,
    Dizzy,
}

impl Card {
    pub fn name(self) -> &'static str {
        match self {
            Card::Welcome => "welcome",
            Card::Agents => "agents",
            Card::Folder => "folder",
            Card::Phone => "phone",
            Card::Extras => "extras",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Card::Welcome => "Hi, I'm Threadbear",
            Card::Agents => "Your agents",
            Card::Folder => "Where threads start",
            Card::Phone => "Check in from anywhere",
            Card::Extras => "A few things worth turning on",
        }
    }

    /// The line under the title: one short sentence (Mike's rule for the
    /// tour's cards, 29 Oct).
    pub fn body(self, signed_in: bool) -> &'static str {
        match self {
            Card::Welcome => "Let's get your agents set up, which takes about a minute.",
            Card::Agents if signed_in => "These are signed in on this Mac.",
            Card::Agents => "Sign in to Claude Code or Codex to run your threads.",
            Card::Folder => "New threads open in this folder unless you pick another.",
            Card::Phone => "Answer and steer your threads from your phone.",
            Card::Extras => "You can change any of these in Settings later.",
        }
    }

    pub fn pose(self, signed_in: bool) -> Pose {
        match self {
            Card::Welcome => Pose::Wave,
            Card::Agents if signed_in => Pose::Sit,
            Card::Agents => Pose::Dizzy,
            Card::Folder => Pose::Cub,
            Card::Phone => Pose::Sleep,
            Card::Extras => Pose::Patch,
        }
    }

    /// The default button's words.
    pub fn primary(self) -> &'static str {
        match self {
            Card::Welcome => "Let's go",
            // The last card: Done opens a new thread, ready to type in.
            Card::Extras => "Done",
            _ => "Continue",
        }
    }
}

/// The cards for this install: Phone only where pairing works (a backend,
/// not this Mac only).
pub fn cards(can_pair: bool) -> Vec<Card> {
    [Card::Welcome, Card::Agents, Card::Folder, Card::Phone, Card::Extras].into_iter().filter(|c| *c != Card::Phone || can_pair).collect()
}

/// The first launch shows the cards, as it showed the tour: never once the
/// tour or the cards have been seen (the same flag, so a Mac that joined
/// with setup's `--existing`, or finished the Swift app's tour, skips them).
pub fn due(seen: Option<bool>) -> bool {
    seen != Some(true)
}

/// A login's row on the Agents card.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRow {
    pub id: String,
    pub provider: String,
    /// "Claude Code", "Codex".
    pub name: String,
    /// Who and which plan: "alex@example.com, Max plan".
    pub detail: String,
    pub state: AgentState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    /// Signed in, with an address the CLI wrote when it signed in.
    Ready,
    /// The folder's there but nobody's signed in to it yet, or its sign-in
    /// ended.
    SignedOut,
    /// A Claude plan that lapsed to the free one, which has no Claude Code.
    PlanEnded,
}

/// The Agents card's rows: Claude's and Codex's logins (the ones a person
/// signs in to; Grok, Cursor and OpenCode come with their own CLIs and show
/// in Usage).
pub fn agent_rows(accounts: &[Account]) -> Vec<AgentRow> {
    accounts
        .iter()
        .filter(|a| matches!(a.provider_id(), "claude" | "codex"))
        .map(|a| {
            let provider = a.provider_id().to_owned();
            let state = if a.plan_ended {
                AgentState::PlanEnded
            } else if a.signed_out || (provider == "claude" && a.email.as_deref().unwrap_or("").is_empty()) {
                // A Claude login writes its address when it signs in, so a
                // folder without one hasn't been signed in to yet.
                AgentState::SignedOut
            } else {
                AgentState::Ready
            };
            let who = a.email.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| a.name());
            let detail = match (state, a.plan.as_deref().filter(|p| !p.is_empty())) {
                (AgentState::PlanEnded, _) => format!("{who}, plan ended"),
                (AgentState::SignedOut, _) => "Not signed in yet".to_owned(),
                (AgentState::Ready, Some(plan)) => format!("{who}, {plan} plan"),
                (AgentState::Ready, None) => who,
            };
            AgentRow { id: a.id.clone(), name: if provider == "codex" { "Codex".into() } else { "Claude Code".into() }, provider, detail, state }
        })
        .collect()
}

/// The rows the card shows: each login while there are a few, and past
/// four, one row per provider for the signed-in ones ("a@b.c and 3 more"),
/// so a Mac with many logins still fits the card on the screen. A login that
/// needs signing in keeps a row of its own, for its Sign in….
pub fn shown_rows(rows: Vec<AgentRow>) -> Vec<AgentRow> {
    if rows.len() <= 4 {
        return rows;
    }
    let mut out: Vec<AgentRow> = vec![];
    for provider in ["claude", "codex"] {
        let ready: Vec<&AgentRow> = rows.iter().filter(|r| r.provider == provider && r.state == AgentState::Ready).collect();
        if let Some(first) = ready.first() {
            let who = first.detail.split(", ").next().unwrap_or(&first.detail).to_owned();
            let detail = match ready.len() {
                1 => first.detail.clone(),
                n => format!("{who} and {} more", n - 1),
            };
            out.push(AgentRow { detail, ..(*first).clone() });
        }
        out.extend(rows.iter().filter(|r| r.provider == provider && r.state == AgentState::SignedOut).cloned());
    }
    out
}

/// Whether any Claude or Codex login can run a thread now.
pub fn any_ready(accounts: &[Account]) -> bool {
    agent_rows(accounts).iter().any(|r| r.state == AgentState::Ready)
}

/// The folder for another Claude login: the next `claude-N` after the ones
/// there are, in the runner's `accounts` folder (how anyone adds a login,
/// docs/guide.md, "Accounts, pools and Usage").
pub fn next_login_id(accounts: &[Account]) -> String {
    let top = accounts.iter().filter_map(|a| a.id.strip_prefix("claude-")?.parse::<u32>().ok()).max().unwrap_or(0);
    format!("claude-{}", top + 1)
}

/// The line under the logins once a pool holds two or more of one
/// provider's, so a thread moves on when one runs low: "Claude: 2 logins in
/// one pool". The built-in pools gather every login of a provider by
/// themselves, so there's nothing to switch on.
pub fn pool_line(pools: &[Pool], accounts: &[Account]) -> Option<String> {
    let pool = pools.iter().filter(|p| p.account_ids.iter().filter(|id| accounts.iter().any(|a| &a.id == *id)).count() >= 2).max_by_key(|p| p.account_ids.len())?;
    let n = pool.account_ids.iter().filter(|id| accounts.iter().any(|a| &a.id == *id)).count();
    Some(format!("{}: {n} logins in one pool, so a thread moves on when one runs low", pool.title))
}

/// A phone paired since the Phone card came up (`before`: the phone ids
/// paired then), for the card's tick.
pub fn newly_paired<'a>(devices: &'a [Device], before: &[String]) -> Option<&'a Device> {
    devices.iter().find(|d| d.kind == Kind::Phone && !d.expired && !before.contains(&d.id))
}

/// A phone paired already, before the card came up.
pub fn paired_phone(devices: &[Device]) -> Option<&Device> {
    devices.iter().find(|d| d.kind == Kind::Phone && !d.expired)
}

/// Where the iPhone app is.
pub const APP_STORE: &str = "https://apps.apple.com/app/id6827837354";

/// GitHub's sign-in, from `gh auth status`'s words: the account, or None
/// when it says nobody's signed in. It prints to stderr on older versions,
/// so both are given.
pub fn gh_account(output: &str) -> Option<String> {
    // "✓ Logged in to github.com account mikecann (keyring)" or, older,
    // "✓ Logged in to github.com as mikecann (...)".
    output.lines().find_map(|line| {
        let rest = line.split("Logged in to github.com").nth(1)?;
        let rest = rest.trim_start().strip_prefix("account ").or_else(|| rest.trim_start().strip_prefix("as "))?;
        let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        (!name.is_empty()).then_some(name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(id: &str, provider: &str, email: Option<&str>) -> Account {
        serde_json::from_value(json!({ "id": id, "provider": provider, "title": id, "email": email })).unwrap()
    }

    #[test]
    fn every_card_says_one_short_sentence() {
        for card in cards(true) {
            for signed_in in [true, false] {
                let body = card.body(signed_in);
                assert_eq!(body.matches(". ").count(), 0, "one sentence: {body}");
                assert!(body.chars().count() <= 90, "short: {body}");
                assert!(!body.contains('\u{2014}') && !card.title().contains('\u{2014}'), "no em dashes: {body}");
                assert!(card.title().chars().count() <= 30, "short title: {}", card.title());
            }
        }
    }

    #[test]
    fn the_phone_card_only_shows_where_a_phone_can_pair() {
        assert!(cards(true).contains(&Card::Phone));
        assert!(!cards(false).contains(&Card::Phone));
        assert_eq!(cards(false).len(), 4);
        assert_eq!(cards(true).first(), Some(&Card::Welcome));
        assert_eq!(cards(true).last(), Some(&Card::Extras));
    }

    #[test]
    fn they_come_up_once() {
        assert!(due(None));
        assert!(due(Some(false)));
        assert!(!due(Some(true)));
    }

    #[test]
    fn a_login_without_an_address_hasnt_been_signed_in_to() {
        let rows = agent_rows(&[account("claude-main", "claude", Some("a@b.c")), account("claude-1", "claude", None), account("codex-main", "codex", None), account("grok", "grok", None)]);
        assert_eq!(rows.len(), 3, "Grok and the others aren't on the card");
        assert_eq!(rows[0].state, AgentState::Ready);
        assert_eq!(rows[0].detail, "a@b.c");
        assert_eq!(rows[1].state, AgentState::SignedOut);
        assert_eq!(rows[2].state, AgentState::Ready, "Codex is only listed once it has a sign-in");
        assert_eq!(rows[2].name, "Codex");
    }

    #[test]
    fn many_logins_fold_into_one_row_a_provider() {
        let mut accounts: Vec<Account> = (1..=5).map(|i| account(&format!("claude-{i}"), "claude", Some(&format!("{i}@b.c")))).collect();
        accounts.push(account("claude-9", "claude", None));
        accounts.push(account("codex-main", "codex", None));
        let rows = shown_rows(agent_rows(&accounts));
        let details: Vec<&str> = rows.iter().map(|r| r.detail.as_str()).collect();
        assert_eq!(details, ["1@b.c and 4 more", "Not signed in yet", "codex-main"]);
        assert_eq!(shown_rows(agent_rows(&accounts[..3])).len(), 3, "a few stay one each");
    }

    #[test]
    fn a_plan_shows_beside_the_address() {
        let mut a = account("claude-main", "claude", Some("a@b.c"));
        a.plan = Some("Max".into());
        assert_eq!(agent_rows(&[a])[0].detail, "a@b.c, Max plan");
    }

    #[test]
    fn ready_needs_a_signed_in_login() {
        assert!(!any_ready(&[]));
        assert!(!any_ready(&[account("claude-1", "claude", None)]));
        assert!(any_ready(&[account("claude-1", "claude", Some("a@b.c"))]));
    }

    #[test]
    fn another_login_takes_the_next_number() {
        assert_eq!(next_login_id(&[]), "claude-1");
        assert_eq!(next_login_id(&[account("claude-main", "claude", None)]), "claude-1");
        assert_eq!(next_login_id(&[account("claude-1", "claude", None), account("claude-3", "claude", None), account("codex-7", "codex", None)]), "claude-4");
    }

    #[test]
    fn the_pool_line_needs_two_logins_in_a_pool() {
        let accounts = [account("claude-main", "claude", Some("a")), account("claude-1", "claude", Some("b"))];
        let pool = |ids: &[&str]| -> Pool { serde_json::from_value(json!({ "id": "claude", "title": "Claude", "accountIds": ids })).unwrap() };
        assert_eq!(pool_line(&[pool(&["claude-main"])], &accounts), None);
        assert_eq!(pool_line(&[pool(&["claude-main", "claude-1"])], &accounts).as_deref(), Some("Claude: 2 logins in one pool, so a thread moves on when one runs low"));
        assert_eq!(pool_line(&[pool(&["claude-main", "gone"])], &accounts), None, "only logins that are there count");
    }

    #[test]
    fn a_phone_paired_while_the_card_was_up() {
        let phone = |id: &str, expired: bool| Device::decode(&json!({ "id": id, "kind": "phone", "name": "iPhone", "expired": expired })).unwrap();
        let devices = [phone("old", false), phone("new", false)];
        assert_eq!(newly_paired(&devices, &["old".into()]).map(|d| d.id.as_str()), Some("new"));
        assert!(newly_paired(&devices, &["old".into(), "new".into()]).is_none());
        assert!(paired_phone(&[phone("x", true)]).is_none(), "an expired one isn't paired");
    }

    #[test]
    fn github_says_who_is_signed_in() {
        assert_eq!(gh_account("github.com\n  ✓ Logged in to github.com account mikecann (keyring)\n").as_deref(), Some("mikecann"));
        assert_eq!(gh_account("✓ Logged in to github.com as some-one (oauth_token)").as_deref(), Some("some-one"));
        assert_eq!(gh_account("You are not logged into any GitHub hosts. To log in, run: gh auth login"), None);
    }
}
