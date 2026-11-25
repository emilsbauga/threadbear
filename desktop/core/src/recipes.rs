// Recipes (the `recipes` experiment, docs/protocol/projects.md "Recipes"): techniques
// someone found worth keeping, which an agent sets up for anyone. This is the
// model and the rules the Recipes view draws from: decoding the runner's
// answers, the order of the list, what a card and a sidebar row say, the
// switch's guess while `recipes.setOn` is on its way, and the page's strip of
// the last 30 days.
use crate::inbox::parse_ms;
use chrono::{DateTime, Datelike, Local, TimeZone};
use serde_json::Value;

/// The experiment that turns the view on (hello's `experiments`).
pub const EXPERIMENT: &str = "recipes";

/// How many days the page's strip and the stats cover.
pub const DAYS: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipeState {
    /// Not added yet.
    Add,
    /// Its setup thread is at work.
    SettingUp,
    On,
    Off,
}

impl RecipeState {
    fn decode(v: &Value) -> RecipeState {
        match v.as_str() {
            Some("settingUp") => RecipeState::SettingUp,
            Some("on") => RecipeState::On,
            Some("off") => RecipeState::Off,
            _ => RecipeState::Add,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            RecipeState::Add => "add",
            RecipeState::SettingUp => "settingUp",
            RecipeState::On => "on",
            RecipeState::Off => "off",
        }
    }

    /// Whether it's one of the user's: added, in any state since.
    pub fn added(self) -> bool {
        self != RecipeState::Add
    }

    /// What its switch shows: on while on, and while setting up unless it
    /// was switched off meanwhile (the runner then says off).
    pub fn switch_on(self) -> bool {
        matches!(self, RecipeState::On | RecipeState::SettingUp)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecipeSchedule {
    pub id: String,
    pub title: String,
    pub paused: bool,
    pub next_run_ms: Option<i64>,
    pub when_text: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecipeStats {
    pub runs: u32,
    pub needed_you: u32,
    pub seen: u32,
    pub last_run_ms: Option<i64>,
    pub last_headline: Option<String>,
}

/// A recipe's habit: what every thread's agent is told while it's on.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecipeHabit {
    /// As its file has it now.
    pub text: String,
    pub bytes: u32,
    /// Agents are being told it (as it was when it was switched on).
    pub given: bool,
    /// The file's wording isn't what was switched on.
    pub changed: bool,
    /// What agents are told, when that's not `text`.
    pub given_text: Option<String>,
}

/// `RecipeSummary`.
#[derive(Clone, Debug, PartialEq)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub by: Option<String>,
    pub yours: bool,
    pub experiment: Option<String>,
    pub when: Option<String>,
    pub color: Option<String>,
    pub header: Option<String>,
    pub state: RecipeState,
    pub setup_thread_id: Option<String>,
    pub habit: Option<RecipeHabit>,
    /// Only a habit: Add is its switch, and there's no setup thread.
    pub instant: bool,
    pub schedules: Vec<RecipeSchedule>,
    pub stats: RecipeStats,
}

/// `RecipeRun`: a thread one of its schedules started.
#[derive(Clone, Debug, PartialEq)]
pub struct RecipeRun {
    pub thread_id: String,
    pub title: String,
    pub at_ms: i64,
    pub headline: Option<String>,
    pub needs_you: bool,
    pub seen: bool,
    pub archived: bool,
}

/// The end card of an example run: its headline and its answers.
#[derive(Clone, Debug, PartialEq)]
pub struct ExampleCard {
    pub headline: String,
    pub options: Vec<String>,
}

/// `RecipeExample`: a made-up run as its thread would show it.
#[derive(Clone, Debug, PartialEq)]
pub struct RecipeExample {
    /// The thread's title.
    pub title: Option<String>,
    /// What the user said first, for a habit.
    pub you: Option<String>,
    /// The agent's reply, in Markdown.
    pub reply: String,
    pub card: Option<ExampleCard>,
}

impl RecipeExample {
    fn decode(v: &Value) -> Option<RecipeExample> {
        let reply = text(&v["reply"]).unwrap_or_default();
        let you = text(&v["you"]);
        let card = text(&v["card"]["headline"]).map(|headline| ExampleCard {
            headline,
            options: v["card"]["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(text)
                .collect(),
        });
        // One with nothing to show is left out.
        (!reply.is_empty() || you.is_some() || card.is_some()).then(|| RecipeExample {
            title: text(&v["title"]),
            you,
            reply,
            card,
        })
    }

    /// The title its little thread shows: its own, else the recipe's name.
    pub fn title_or<'a>(&'a self, recipe: &'a Recipe) -> &'a str {
        self.title.as_deref().unwrap_or(&recipe.name)
    }
}

/// `recipes.get`'s answer: the summary and the page's parts.
#[derive(Clone, Debug, PartialEq)]
pub struct RecipeDetail {
    pub recipe: Recipe,
    pub about: String,
    /// Its made-up runs: `examples`, or from a runner before those, `example`
    /// as one reply.
    pub examples: Vec<RecipeExample>,
    pub file: String,
    pub runs: Vec<RecipeRun>,
}

/// "Example 2 of 3", a dot's tip.
pub fn example_tip(index: usize, count: usize) -> String {
    format!("Example {} of {count}", index + 1)
}

/// The example shown after a step of `by` (-1 back, 1 on) from `index`, kept
/// in range.
pub fn step_example(index: usize, by: isize, count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    (index as isize + by).clamp(0, count as isize - 1) as usize
}

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn time(v: &Value) -> Option<i64> {
    v.as_str().and_then(parse_ms)
}

fn count(v: &Value) -> u32 {
    v.as_u64().map_or(0, |n| n.min(u32::MAX as u64) as u32)
}

impl Recipe {
    /// One `RecipeSummary`; None without an id.
    pub fn decode(v: &Value) -> Option<Recipe> {
        let id = text(&v["id"])?;
        let schedules = v["schedules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                Some(RecipeSchedule {
                    id: text(&s["id"])?,
                    title: text(&s["title"]).unwrap_or_default(),
                    paused: s["paused"].as_bool().unwrap_or(false),
                    next_run_ms: time(&s["nextRunAt"]),
                    when_text: text(&s["whenText"]).unwrap_or_default(),
                })
            })
            .collect();
        let st = &v["stats"];
        Some(Recipe {
            name: text(&v["name"]).unwrap_or_else(|| id.clone()),
            icon: text(&v["icon"]).unwrap_or_else(|| "📖".to_owned()),
            description: text(&v["description"]).unwrap_or_default(),
            by: text(&v["by"]),
            yours: v["source"].as_str() == Some("yours"),
            experiment: text(&v["experiment"]),
            when: text(&v["when"]),
            color: text(&v["color"]),
            header: text(&v["header"]),
            state: RecipeState::decode(&v["state"]),
            setup_thread_id: text(&v["setupThreadId"]),
            habit: v["habit"].is_object().then(|| {
                let h = &v["habit"];
                RecipeHabit {
                    text: text(&h["text"]).unwrap_or_default(),
                    bytes: count(&h["bytes"]),
                    given: h["given"].as_bool().unwrap_or(false),
                    changed: h["changed"].as_bool().unwrap_or(false),
                    given_text: text(&h["givenText"]),
                }
            }),
            instant: v["instant"].as_bool().unwrap_or(false),
            schedules,
            stats: RecipeStats {
                runs: count(&st["runs"]),
                needed_you: count(&st["neededYou"]),
                seen: count(&st["seen"]),
                last_run_ms: time(&st["lastRunAt"]),
                last_headline: text(&st["lastHeadline"]),
            },
            id,
        })
    }

    /// `recipes.list`'s `recipes`, in the view's order.
    pub fn decode_list(v: &Value) -> Vec<Recipe> {
        let mut list: Vec<Recipe> = v
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Recipe::decode)
            .collect();
        sort(&mut list);
        list
    }

    /// The card's tag beside its name.
    pub fn tag(&self) -> &'static str {
        match self.state {
            RecipeState::Add => "+ Add",
            RecipeState::SettingUp => "Setting up",
            RecipeState::On => "On",
            RecipeState::Off => "Off",
        }
    }

    /// The card's line under its description: how it's been going, or how
    /// often it would run.
    pub fn stat_line(&self) -> String {
        if self.stats.runs > 0 {
            let runs = plural(self.stats.runs, "run", "runs");
            if self.stats.needed_you > 0 {
                return format!("{runs} in 30 days · {} needed you", self.stats.needed_you);
            }
            return format!("{runs} in 30 days");
        }
        match (&self.when, self.state) {
            (Some(when), _) => when.clone(),
            (None, RecipeState::SettingUp) => "Being set up".to_owned(),
            (None, _) => String::new(),
        }
    }

    /// Under its habit on the page: whether agents are being told it, and
    /// what it costs every thread.
    pub fn habit_line(&self) -> Option<String> {
        let h = self.habit.as_ref()?;
        // What it adds to every thread, in round terms.
        let size = format!("about {} tokens", h.bytes.div_ceil(4).max(1));
        Some(match (self.state.switch_on(), h.given, h.changed) {
            (true, true, true) => "Its wording has changed since you switched it on. Agents are still told the old one.".to_owned(),
            (true, false, _) => "Agents aren't being told this: its wording isn't what you switched on.".to_owned(),
            (true, true, false) => format!("Every thread's agent is being told this · {size}"),
            (false, ..) if self.state == RecipeState::Off => {
                format!("Off, so no agent is told this · {size}")
            }
            (false, ..) => format!("Every thread's agent is told this while it's on · {size}"),
        })
    }

    /// Whether the page offers "Use the new wording": it's on, and what's
    /// given isn't what its file says.
    pub fn habit_stale(&self) -> bool {
        self.state.switch_on() && self.habit.as_ref().is_some_and(|h| h.changed || !h.given)
    }

    /// The next run of its schedules that aren't paused.
    pub fn next_run_ms(&self) -> Option<i64> {
        self.schedules
            .iter()
            .filter(|s| !s.paused)
            .filter_map(|s| s.next_run_ms)
            .min()
    }

    /// The sidebar row's line under its name: what it last did and when it
    /// runs next, or that it's being set up, or off.
    pub fn status_line(&self, now: DateTime<Local>) -> String {
        match self.state {
            RecipeState::Add => self.when.clone().unwrap_or_default(),
            RecipeState::SettingUp => "Setting up: open its thread to finish".to_owned(),
            RecipeState::Off => match &self.when {
                Some(when) => format!("Off · {}", lower_first(when)),
                None => "Off".to_owned(),
            },
            RecipeState::On => {
                let mut parts = vec![];
                if let Some(last) = self.stats.last_run_ms {
                    parts.push(format!("Ran {}", day_time(last, now)));
                }
                if let Some(next) = self.next_run_ms() {
                    parts.push(format!("next {}", day_time(next, now)));
                }
                if parts.is_empty() {
                    return match (&self.experiment, &self.when) {
                        (_, Some(when)) => when.clone(),
                        (Some(_), None) => "On".to_owned(),
                        (None, None) => "On, nothing run yet".to_owned(),
                    };
                }
                parts.join(" · ")
            }
        }
    }

    /// "By Mike · Every day at 6:30", for the page under its name.
    pub fn byline(&self) -> String {
        let mut parts = vec![];
        if let Some(by) = &self.by {
            parts.push(format!("By {by}"));
        } else if self.yours {
            parts.push("Yours".to_owned());
        }
        if let Some(when) = &self.when {
            parts.push(lower_after_first(when, parts.is_empty()));
        }
        parts.join(" · ")
    }

    /// The header's colours when it has no picture: its own colour fading to
    /// a darker one, or a neutral grey.
    pub fn header_colors(&self) -> (u32, u32) {
        let base = self
            .color
            .as_deref()
            .and_then(parse_hex)
            .unwrap_or(0x5a_60_6e);
        (base, darken(base, 0.45))
    }
}

/// On first (then setting up, off), then the rest; by name within each.
pub fn sort(list: &mut [Recipe]) {
    let rank = |s: RecipeState| match s {
        RecipeState::On => 0,
        RecipeState::SettingUp => 1,
        RecipeState::Off => 2,
        RecipeState::Add => 3,
    };
    list.sort_by(|a, b| {
        rank(a.state)
            .cmp(&rank(b.state))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// How many are on, for the sidebar's heading ("4 on").
pub fn on_count(list: &[Recipe]) -> usize {
    list.iter().filter(|r| r.state == RecipeState::On).count()
}

/// The sidebar's rows: the recipes the user has added.
pub fn added(list: &[Recipe]) -> Vec<&Recipe> {
    list.iter().filter(|r| r.state.added()).collect()
}

/// The switch's guess while `recipes.setOn` is on its way. One still being
/// set up stays so: the runner only records the choice.
pub fn guess_on(recipe: &Recipe, on: bool) -> Recipe {
    let mut r = recipe.clone();
    if let Some(h) = &mut r.habit {
        // On takes the wording as it is now.
        h.given = on;
        h.changed = false;
        h.given_text = None;
    }
    r.state = match (r.state, on) {
        (RecipeState::SettingUp, true) => RecipeState::SettingUp,
        (_, true) => RecipeState::On,
        (_, false) => RecipeState::Off,
    };
    for s in &mut r.schedules {
        s.paused = !on;
    }
    r
}

impl RecipeDetail {
    pub fn decode(v: &Value) -> Option<RecipeDetail> {
        let recipe = Recipe::decode(v)?;
        let mut runs: Vec<RecipeRun> = v["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                Some(RecipeRun {
                    thread_id: text(&r["threadId"])?,
                    title: text(&r["title"]).unwrap_or_default(),
                    at_ms: time(&r["at"])?,
                    headline: text(&r["headline"]),
                    needs_you: r["needsYou"].as_bool().unwrap_or(false),
                    seen: r["seen"].as_bool().unwrap_or(false),
                    archived: r["archived"].as_bool().unwrap_or(false),
                })
            })
            .collect();
        runs.sort_by_key(|a| std::cmp::Reverse(a.at_ms));
        Some(RecipeDetail {
            recipe,
            about: text(&v["about"]).unwrap_or_default(),
            examples: {
                let list: Vec<RecipeExample> = v["examples"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(RecipeExample::decode)
                    .collect();
                if list.is_empty() {
                    text(&v["example"])
                        .map(|reply| RecipeExample {
                            title: None,
                            you: None,
                            reply,
                            card: None,
                        })
                        .into_iter()
                        .collect()
                } else {
                    list
                }
            },
            file: text(&v["file"]).unwrap_or_default(),
            runs,
        })
    }

    /// The page's four numbers: from the runs it was sent, so they match the
    /// strip and the log, else the summary's.
    pub fn numbers(&self) -> [(u32, &'static str); 3] {
        let s = &self.recipe.stats;
        if self.runs.is_empty() {
            return [
                (s.runs, "runs"),
                (s.needed_you, "needed you"),
                (s.seen, "you opened"),
            ];
        }
        let n = self.runs.len() as u32;
        let needed = self.runs.iter().filter(|r| r.needs_you).count() as u32;
        let seen = self.runs.iter().filter(|r| r.seen).count() as u32;
        [(n, "runs"), (needed, "needed you"), (seen, "you opened")]
    }
}

/// One square of the page's strip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Day {
    /// Nothing ran that day.
    Quiet,
    Ran,
    /// A run that day needed the user.
    NeededYou,
}

/// The last `DAYS` days, oldest first, ending today.
pub fn strip(runs: &[RecipeRun], now: DateTime<Local>) -> Vec<Day> {
    let today = now.date_naive();
    let mut days = vec![Day::Quiet; DAYS];
    for run in runs {
        let Some(at) = Local.timestamp_millis_opt(run.at_ms).single() else {
            continue;
        };
        let back = (today - at.date_naive()).num_days();
        if !(0..DAYS as i64).contains(&back) {
            continue;
        }
        let slot = &mut days[DAYS - 1 - back as usize];
        *slot = match (*slot, run.needs_you) {
            (_, true) | (Day::NeededYou, _) => Day::NeededYou,
            _ => Day::Ran,
        };
    }
    days
}

/// A log row's time: "Fri 20 Nov, 6:30".
pub fn log_time(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(at) => format!("{}, {}", at.format("%a %-d %b"), clock(at)),
        None => String::new(),
    }
}

/// "6:30", "21:30": the day's time as the rest of the app writes it.
fn clock(at: DateTime<Local>) -> String {
    at.format("%-H:%M").to_string()
}

/// "6:30" today, "Thu 6:30" this week, "12 Nov 6:30" further.
fn day_time(ms: i64, now: DateTime<Local>) -> String {
    let Some(at) = Local.timestamp_millis_opt(ms).single() else {
        return String::new();
    };
    let days = (at.date_naive() - now.date_naive()).num_days();
    match days {
        0 => clock(at),
        1 => format!("tomorrow {}", clock(at)),
        -1 => format!("yesterday {}", clock(at)),
        d if d.abs() < 7 => format!("{} {}", at.format("%a"), clock(at)),
        _ if at.year() == now.year() => format!("{} {}", at.format("%-d %b"), clock(at)),
        _ => format!("{} {}", at.format("%-d %b %Y"), clock(at)),
    }
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// "Every day at 6:30" read mid-line: "every day at 6:30". A day's or a
/// month's name ("Sundays at 19:00") keeps its capital.
fn lower_first(s: &str) -> String {
    const COMMON: [&str; 9] = [
        "Every", "Each", "When", "Daily", "Before", "Once", "Twice", "Weekly", "In",
    ];
    let first = s
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches(',');
    if !COMMON.contains(&first) {
        return s.to_owned();
    }
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

fn lower_after_first(s: &str, first: bool) -> String {
    if first {
        s.to_owned()
    } else {
        lower_first(s)
    }
}

/// "#rrggbb" (or "rrggbb") as 0xrrggbb.
pub fn parse_hex(s: &str) -> Option<u32> {
    let h = s.trim().trim_start_matches('#');
    (h.len() == 6)
        .then(|| u32::from_str_radix(h, 16).ok())
        .flatten()
}

fn darken(rgb: u32, by: f32) -> u32 {
    let ch = |shift: u32| ((((rgb >> shift) & 0xff) as f32) * (1. - by)).round() as u32;
    (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 20, 10, 0, 0).unwrap()
    }

    fn ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn iso(ms: i64) -> String {
        crate::inbox::iso_time(ms)
    }

    fn summary(id: &str, state: &str) -> Value {
        json!({ "id": id, "name": id, "icon": "☀️", "description": "d", "source": "builtin", "state": state, "schedules": [], "stats": { "runs": 0, "neededYou": 0, "seen": 0 } })
    }

    #[test]
    fn decodes_a_summary() {
        let v = json!({
            "id": "daily-brief", "name": "Daily brief", "icon": "☀️", "description": "A short note", "by": "Mike",
            "source": "builtin", "when": "Every day at 6:30", "color": "#f2a65a", "header": "/x/header.jpg",
            "state": "on", "setupThreadId": "t1",
            "schedules": [{ "id": "s1", "title": "Daily brief", "paused": false, "nextRunAt": iso(ms(2026, 11, 21, 6, 30)), "whenText": "Every day at 6:30" }],
            "stats": { "runs": 24, "neededYou": 9, "seen": 20, "lastRunAt": iso(ms(2026, 11, 20, 6, 30)), "lastHeadline": "2 emails need you" }
        });
        let r = Recipe::decode(&v).unwrap();
        assert_eq!(r.state, RecipeState::On);
        assert_eq!(r.by.as_deref(), Some("Mike"));
        assert!(!r.yours);
        assert_eq!(r.schedules.len(), 1);
        assert_eq!(r.stats.runs, 24);
        assert_eq!(r.stat_line(), "24 runs in 30 days · 9 needed you");
        assert_eq!(r.status_line(now()), "Ran 6:30 · next tomorrow 6:30");
        assert_eq!(r.byline(), "By Mike · every day at 6:30");
        assert_eq!(r.tag(), "On");
    }

    fn habit(state: &str, given: bool, changed: bool) -> Recipe {
        let mut v = summary("options", state);
        v["instant"] = json!(true);
        v["when"] = json!("In every thread");
        v["habit"] = json!({ "text": "Show three options.", "bytes": 19, "given": given });
        if changed {
            v["habit"]["changed"] = json!(true);
            v["habit"]["givenText"] = json!("Show two options.");
        }
        Recipe::decode(&v).unwrap()
    }

    #[test]
    fn a_habit_says_whether_agents_are_told_it_and_what_it_costs() {
        let add = habit("add", false, false);
        assert!(add.instant);
        assert_eq!(add.habit.as_ref().unwrap().text, "Show three options.");
        assert_eq!(
            add.habit_line().unwrap(),
            "Every thread's agent is told this while it's on · about 5 tokens"
        );
        assert_eq!(add.stat_line(), "In every thread");
        let on = habit("on", true, false);
        assert_eq!(
            on.habit_line().unwrap(),
            "Every thread's agent is being told this · about 5 tokens"
        );
        assert_eq!(on.status_line(now()), "In every thread");
        assert!(!on.habit_stale());
        assert_eq!(
            habit("off", false, false).habit_line().unwrap(),
            "Off, so no agent is told this · about 5 tokens"
        );
        let changed = habit("on", true, true);
        assert!(changed.habit_stale());
        assert_eq!(
            changed.habit.as_ref().unwrap().given_text.as_deref(),
            Some("Show two options.")
        );
        assert!(changed
            .habit_line()
            .unwrap()
            .starts_with("Its wording has changed"));
        assert!(habit("on", false, true)
            .habit_line()
            .unwrap()
            .starts_with("Agents aren't"));
        assert!(Recipe::decode(&summary("x", "on"))
            .unwrap()
            .habit_line()
            .is_none());
    }

    #[test]
    fn switching_a_habit_guesses_it_given_and_adds_one_that_needs_no_setup() {
        let on = guess_on(&habit("add", false, false), true);
        assert_eq!(on.state, RecipeState::On);
        assert!(on.habit.as_ref().unwrap().given);
        let off = guess_on(&habit("on", true, true), false);
        assert_eq!(off.state, RecipeState::Off);
        assert!(!off.habit.as_ref().unwrap().given);
        assert!(!off.habit_stale());
    }

    #[test]
    fn a_summary_without_an_id_is_skipped_and_unknown_states_are_add() {
        assert!(Recipe::decode(&json!({ "name": "x" })).is_none());
        let r = Recipe::decode(&json!({ "id": "x", "state": "somethingNew" })).unwrap();
        assert_eq!(r.state, RecipeState::Add);
        assert_eq!(r.name, "x");
        assert_eq!(r.tag(), "+ Add");
    }

    #[test]
    fn the_list_puts_on_first_then_setting_up_off_and_the_rest_by_name() {
        let v = json!([
            summary("b", "add"),
            summary("a", "add"),
            summary("z", "on"),
            summary("m", "off"),
            summary("y", "settingUp"),
            summary("c", "on")
        ]);
        let list = Recipe::decode_list(&v);
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["c", "z", "y", "m", "a", "b"]);
        assert_eq!(on_count(&list), 2);
        assert_eq!(added(&list).len(), 4);
    }

    #[test]
    fn the_switch_guess_turns_schedules_with_it_and_setting_up_stays() {
        let mut r = Recipe::decode(&summary("x", "on")).unwrap();
        r.schedules.push(RecipeSchedule {
            id: "s".into(),
            title: "t".into(),
            paused: false,
            next_run_ms: None,
            when_text: String::new(),
        });
        let off = guess_on(&r, false);
        assert_eq!(off.state, RecipeState::Off);
        assert!(off.schedules[0].paused);
        assert_eq!(guess_on(&off, true).state, RecipeState::On);
        let setting = Recipe::decode(&summary("y", "settingUp")).unwrap();
        assert_eq!(guess_on(&setting, true).state, RecipeState::SettingUp);
        assert_eq!(guess_on(&setting, false).state, RecipeState::Off);
    }

    #[test]
    fn stat_and_status_lines_without_runs() {
        let mut r = Recipe::decode(&summary("x", "add")).unwrap();
        assert_eq!(r.stat_line(), "");
        r.when = Some("Sundays at 19:00".into());
        assert_eq!(r.stat_line(), "Sundays at 19:00");
        r.state = RecipeState::Off;
        assert_eq!(r.status_line(now()), "Off · Sundays at 19:00");
        r.when = Some("Every Sunday".into());
        assert_eq!(r.status_line(now()), "Off · every Sunday");
        r.when = Some("Sundays at 19:00".into());
        r.state = RecipeState::SettingUp;
        assert_eq!(
            r.status_line(now()),
            "Setting up: open its thread to finish"
        );
        r.state = RecipeState::On;
        r.when = None;
        assert_eq!(r.status_line(now()), "On, nothing run yet");
        r.experiment = Some("mailWatch".into());
        assert_eq!(r.status_line(now()), "On");
        r.stats.runs = 1;
        assert_eq!(r.stat_line(), "1 run in 30 days");
    }

    #[test]
    fn the_strip_marks_each_day_and_keeps_needed_you() {
        let runs = vec![
            RecipeRun {
                thread_id: "a".into(),
                title: String::new(),
                at_ms: ms(2026, 11, 20, 6, 30),
                headline: None,
                needs_you: true,
                seen: true,
                archived: false,
            },
            RecipeRun {
                thread_id: "b".into(),
                title: String::new(),
                at_ms: ms(2026, 11, 20, 8, 0),
                headline: None,
                needs_you: false,
                seen: false,
                archived: false,
            },
            RecipeRun {
                thread_id: "c".into(),
                title: String::new(),
                at_ms: ms(2026, 11, 19, 6, 30),
                headline: None,
                needs_you: false,
                seen: true,
                archived: false,
            },
            // Too old for the strip.
            RecipeRun {
                thread_id: "d".into(),
                title: String::new(),
                at_ms: ms(2026, 10, 1, 6, 30),
                headline: None,
                needs_you: true,
                seen: true,
                archived: false,
            },
        ];
        let days = strip(&runs, now());
        assert_eq!(days.len(), DAYS);
        assert_eq!(days[DAYS - 1], Day::NeededYou);
        assert_eq!(days[DAYS - 2], Day::Ran);
        assert_eq!(days[DAYS - 3], Day::Quiet);
        assert_eq!(days.iter().filter(|d| **d != Day::Quiet).count(), 2);
    }

    #[test]
    fn a_detail_decodes_runs_newest_first_and_counts_them() {
        let v = json!({
            "id": "x", "name": "X", "state": "on", "about": "What it does", "example": "**Today**", "file": "/r/RECIPE.md",
            "runs": [
                { "threadId": "a", "title": "A", "at": iso(ms(2026, 11, 18, 6, 30)), "needsYou": false, "seen": true, "archived": true },
                { "threadId": "b", "title": "B", "at": iso(ms(2026, 11, 20, 6, 30)), "headline": "2 emails", "needsYou": true, "seen": false, "archived": false },
                { "title": "no id", "at": iso(ms(2026, 11, 19, 6, 30)) }
            ]
        });
        let d = RecipeDetail::decode(&v).unwrap();
        assert_eq!(d.runs.len(), 2);
        assert_eq!(d.runs[0].thread_id, "b");
        assert_eq!(
            d.numbers(),
            [(2, "runs"), (1, "needed you"), (1, "you opened")]
        );
        assert_eq!(d.examples.len(), 1, "an older runner's one example");
        assert_eq!(d.examples[0].reply, "**Today**");
        assert_eq!(d.examples[0].title_or(&d.recipe), "X");
        assert_eq!(log_time(ms(2026, 11, 20, 6, 30)), "Fri 20 Nov, 6:30");
    }

    #[test]
    fn examples_decode_with_their_title_message_and_card() {
        let v = json!({
            "id": "x", "name": "X", "state": "add", "example": "ignored",
            "examples": [
                { "title": "Daily standup", "reply": "**Yesterday**", "card": { "headline": "Draft ready", "options": ["Posted", "Skip"] } },
                { "you": "Too cluttered", "reply": "Three ideas" },
                { "reply": "" }
            ]
        });
        let d = RecipeDetail::decode(&v).unwrap();
        assert_eq!(d.examples.len(), 2, "an empty one is left out");
        assert_eq!(d.examples[0].title_or(&d.recipe), "Daily standup");
        let card = d.examples[0].card.as_ref().unwrap();
        assert_eq!(card.headline, "Draft ready");
        assert_eq!(card.options, vec!["Posted", "Skip"]);
        assert_eq!(d.examples[1].you.as_deref(), Some("Too cluttered"));
        assert!(d.examples[1].card.is_none());
        assert_eq!(example_tip(1, 3), "Example 2 of 3");
        assert_eq!(step_example(0, -1, 3), 0);
        assert_eq!(step_example(1, 1, 3), 2);
        assert_eq!(step_example(2, 1, 3), 2);
        assert_eq!(step_example(0, 1, 0), 0);
    }

    #[test]
    fn header_colours_come_from_its_colour_or_grey() {
        let mut r = Recipe::decode(&summary("x", "add")).unwrap();
        assert_eq!(r.header_colors().0, 0x5a606e);
        r.color = Some("#f2a65a".into());
        let (a, b) = r.header_colors();
        assert_eq!(a, 0xf2a65a);
        assert!(b < a);
        assert_eq!(parse_hex("nope"), None);
    }

    #[test]
    fn day_times_read_naturally() {
        let n = now();
        assert_eq!(day_time(ms(2026, 11, 20, 6, 30), n), "6:30");
        assert_eq!(day_time(ms(2026, 11, 19, 21, 30), n), "yesterday 21:30");
        assert_eq!(day_time(ms(2026, 11, 22, 19, 0), n), "Sun 19:00");
        assert_eq!(day_time(ms(2026, 12, 4, 9, 0), n), "4 Dec 9:00");
    }
}
