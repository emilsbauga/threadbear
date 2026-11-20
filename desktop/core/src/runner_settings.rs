// The runner's settings as the Settings window shows them (docs/protocol.md,
// "Settings and models"), all kept in the runner's runner.json, and the words
// around them: a port of the Swift app's RunnerSettings and SettingsText.
// Decoded as forgivingly as the other models, so a missing field takes its
// default and an older runner's fields are ignored.
use serde_json::Value;

/// How often a fork's runner starts a thread to bring in Mike's releases:
/// every so many days, only for ones he marks important, or never.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BringIn {
    Every(i64),
    Important,
    Off,
}

impl BringIn {
    pub const STANDARD: BringIn = BringIn::Every(5);

    pub fn json(self) -> Value {
        match self {
            BringIn::Every(days) => Value::from(days),
            BringIn::Important => Value::from("important"),
            BringIn::Off => Value::from("off"),
        }
    }

    pub fn title(self) -> String {
        match self {
            BringIn::Every(1) => "Every day".into(),
            BringIn::Every(7) => "Every week".into(),
            BringIn::Every(14) => "Every 2 weeks".into(),
            BringIn::Every(n) => format!("Every {n} days"),
            BringIn::Important => "Only important ones".into(),
            BringIn::Off => "Never".into(),
        }
    }

    /// The choices, with a custom number of days from runner.json kept as its
    /// own one (`bringInChoices`).
    pub fn choices(current: BringIn) -> Vec<BringIn> {
        let mut days = vec![1, 3, 5, 7, 14];
        if let BringIn::Every(n) = current {
            if !days.contains(&n) {
                days.push(n);
                days.sort();
            }
        }
        days.into_iter().map(BringIn::Every).chain([BringIn::Important, BringIn::Off]).collect()
    }
}

/// One experiment (runner/src/experiments/<id>.md) and its switch.
#[derive(Clone, Debug, PartialEq)]
pub struct Experiment {
    pub id: String,
    pub name: String,
    /// The guide's paragraph, as Markdown.
    pub does: String,
    pub on: bool,
}

/// One reviewer in Settings > General > Code review (runner/src/lab-reviewers.ts):
/// a provider, with the model and effort it reviews on when it names them
/// (else the provider's default, at high). It's on one of two lists:
/// "Every change" (runner.json `labReviewers`), in Mike's order, where the
/// first that can review does; or "Big or risky changes" (`labPanel`), who
/// all review a big or risky change at once. A provider can be on a list
/// more than once on different models, so a row is known by its place in
/// its list, not its provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabReviewer {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl LabReviewer {
    pub fn new(provider: &str) -> LabReviewer {
        LabReviewer { provider: provider.to_owned(), model: None, effort: None }
    }

    fn decode(v: &Value) -> Option<LabReviewer> {
        let provider = v["provider"].as_str().filter(|p| !p.is_empty())?.to_owned();
        let text = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        Some(LabReviewer { provider, model: text("model"), effort: text("effort") })
    }

    pub fn json(&self) -> Value {
        let mut v = serde_json::json!({ "provider": self.provider });
        if let Some(model) = &self.model {
            v["model"] = Value::from(model.clone());
        }
        if let Some(effort) = &self.effort {
            v["effort"] = Value::from(effort.clone());
        }
        v
    }

    /// The lab an OpenCode reviewer's model is from ("Gemini" for
    /// google/gemini-…), as the runner names it (lab-review.ts, labOfModel).
    /// None for any other provider, or a model it doesn't know.
    pub fn lab(&self) -> Option<&'static str> {
        if self.provider != "opencode" {
            return None;
        }
        self.model.as_deref().and_then(lab_of_model)
    }
}

/// The lab a model id is from, by its name (lab-review.ts, labOfModel).
pub fn lab_of_model(model: &str) -> Option<&'static str> {
    let m = model.to_lowercase();
    if m.contains("gemini") {
        Some("Gemini")
    } else if m.contains("claude") {
        Some("Claude")
    } else if m.contains("gpt") || m.contains("codex") {
        Some("GPT")
    } else if m.contains("grok") {
        Some("Grok")
    } else {
        None
    }
}

/// The change `settings.update` takes for the whole "Every change" list.
pub fn reviewers_change(list: &[LabReviewer]) -> Value {
    serde_json::json!({ "labReviewers": list.iter().map(LabReviewer::json).collect::<Vec<_>>() })
}

/// The change `settings.update` takes for the whole "Big or risky changes"
/// list.
pub fn panel_change(list: &[LabReviewer]) -> Value {
    serde_json::json!({ "labPanel": list.iter().map(LabReviewer::json).collect::<Vec<_>>() })
}

/// How many lines of code make a change big enough for the panel when the
/// runner doesn't say (runner.json `labPanelLines`).
pub const PANEL_LINES: u32 = 150;

/// The list with the reviewer at `from` dropped on the row at `to`: it takes
/// that place and the rest close up, as a runner card dropped on another
/// does. None when nothing moves.
pub fn reviewer_dropped(list: &[LabReviewer], from: usize, to: usize) -> Option<Vec<LabReviewer>> {
    if from == to || from >= list.len() || to >= list.len() {
        return None;
    }
    let mut out = list.to_vec();
    let moved = out.remove(from);
    out.insert(to, moved);
    Some(out)
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunnerSettings {
    pub default_cwd: String,
    /// Review by another lab: on unless turned off.
    pub lab_review: bool,
    /// Whether the runner sends `labReview` at all; an older one doesn't, and
    /// Settings then shows no switch.
    pub lab_review_supported: bool,
    /// Who reviews every change, in order. None from a runner from before
    /// the list, and Settings then shows only the switch.
    pub lab_reviewers: Option<Vec<LabReviewer>>,
    /// Who reviews a big or risky change, all at once (`labPanel`). From a
    /// runner from before that list, the reviewers it ticked `panel: true`
    /// in `labReviewers`; None when there's no `labReviewers` either.
    pub lab_panel: Option<Vec<LabReviewer>>,
    /// The lines of code that make a change big (`labPanelLines`).
    pub lab_panel_lines: u32,
    /// Keep the Mac out of idle sleep while threads work. None from a runner
    /// that isn't on a Mac (or is too old), and Settings then hides it.
    pub keep_awake: Option<bool>,
    /// Full sync (runner.json's sync.full), as it'll be from the runner's next
    /// start. None from a runner from before it, and Settings then hides it.
    pub full_sync: Option<bool>,
    /// A thread suggesting work when a login's week is about to go unused
    /// (runner.json `spareWeek`). None from a runner from before it, and
    /// Settings then hides the switch.
    pub spare_week: Option<bool>,
    pub bring_in: BringIn,
    pub bring_in_supported: bool,
    /// The pool whose Claude logins answer small jobs (titles, the
    /// librarian); None means none, so those are off.
    pub pool: Option<String>,
    /// Whether the runner sends `models.pool` at all.
    pub pool_supported: bool,
    /// Folders whose thread text is never sent, as written ("~/" kept).
    pub private_folders: Vec<String>,
    /// Every experiment there is, oldest first.
    pub experiments: Vec<Experiment>,
}

impl RunnerSettings {
    pub fn decode(v: &Value) -> RunnerSettings {
        let bring_in = match &v["bringIn"] {
            Value::Number(n) => n.as_i64().filter(|d| *d >= 1).map(BringIn::Every),
            Value::String(s) if s == "important" => Some(BringIn::Important),
            Value::String(s) if s == "off" => Some(BringIn::Off),
            _ => None,
        };
        let models = &v["models"];
        RunnerSettings {
            default_cwd: v["defaultCwd"].as_str().unwrap_or("").to_owned(),
            lab_review: v["labReview"].as_bool().unwrap_or(true),
            lab_review_supported: v.get("labReview").is_some_and(Value::is_boolean),
            lab_reviewers: v["labReviewers"].as_array().map(|list| list.iter().filter_map(LabReviewer::decode).collect()),
            lab_panel: match (v["labPanel"].as_array(), v["labReviewers"].as_array()) {
                (Some(panel), _) => Some(panel.iter().filter_map(LabReviewer::decode).collect()),
                (None, Some(old)) => Some(old.iter().filter(|r| r["panel"] == Value::Bool(true)).filter_map(LabReviewer::decode).collect()),
                (None, None) => None,
            },
            lab_panel_lines: v["labPanelLines"].as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0).unwrap_or(PANEL_LINES),
            keep_awake: v["keepAwake"].as_bool(),
            full_sync: v["fullSync"].as_bool(),
            spare_week: v["spareWeek"].as_bool(),
            bring_in_supported: bring_in.is_some(),
            bring_in: bring_in.unwrap_or(BringIn::STANDARD),
            pool: models["pool"].as_str().filter(|p| !p.is_empty()).map(str::to_owned),
            pool_supported: models.get("pool").is_some(),
            private_folders: models["privateFolders"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_owned)).collect(),
            experiments: v["experiments"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| {
                    let id = e["id"].as_str()?.to_owned();
                    Some(Experiment { name: e["name"].as_str().map_or_else(|| id.clone(), str::to_owned), does: e["does"].as_str().unwrap_or("").to_owned(), on: e["on"].as_bool().unwrap_or(false), id })
                })
                .collect(),
        }
    }
}

/// An experiment's paragraph as plain text for its ⓘ: the guide writes it in
/// Markdown, so code marks and doubled spaces go (`experimentAbout`).
pub fn experiment_about(does: &str) -> String {
    let unmarked = does.replace('`', "");
    let mut out = String::with_capacity(unmarked.len());
    let mut spaces = 0;
    for c in unmarked.chars() {
        if c == ' ' || c == '\t' {
            spaces += 1;
            continue;
        }
        if spaces > 0 {
            out.push(' ');
            spaces = 0;
        }
        out.push(c);
    }
    out.trim().to_owned()
}

/// Standing instructions (docs/protocol.md, "Standing instructions"): what
/// every thread's agent is given. `outside` is set when the file isn't what
/// Settings last saved, so no agent is given it until Mike decides.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StandingInstructions {
    pub text: String,
    pub outside: bool,
}

impl StandingInstructions {
    pub fn decode(v: &Value) -> StandingInstructions {
        StandingInstructions { text: v["text"].as_str().unwrap_or("").to_owned(), outside: v["outside"].as_bool().unwrap_or(false) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_read_leniently() {
        let s = RunnerSettings::decode(&json!({
            "defaultCwd": "/Users/alex/code/misc", "labReview": false, "keepAwake": true, "fullSync": false, "spareWeek": false, "bringIn": "important",
            "models": { "pool": "claude", "privateFolders": ["~/private"] },
            "experiments": [{ "id": "gpuiApp", "name": "GPUI app", "does": "The `GPUI`  app.", "on": true }, { "id": "bare" }],
        }));
        assert!(!s.lab_review && s.lab_review_supported);
        assert_eq!(s.keep_awake, Some(true));
        assert_eq!(s.full_sync, Some(false));
        assert_eq!(s.spare_week, Some(false));
        assert_eq!(s.bring_in, BringIn::Important);
        assert_eq!(s.pool.as_deref(), Some("claude"));
        assert_eq!(s.private_folders, vec!["~/private"]);
        assert_eq!(s.experiments[1].name, "bare", "an experiment with no name goes by its id");
        assert_eq!(experiment_about(&s.experiments[0].does), "The GPUI app.");
        let old = RunnerSettings::decode(&json!({ "defaultCwd": "/x", "models": {} }));
        assert!(old.lab_review && !old.lab_review_supported, "an older runner shows no Code review switch");
        assert!(!old.pool_supported && old.keep_awake.is_none() && !old.bring_in_supported);
        assert!(old.full_sync.is_none(), "an older runner shows no Full sync switch");
        assert!(old.spare_week.is_none(), "an older runner shows no spare week switch");
        let none = RunnerSettings::decode(&json!({ "models": { "pool": null } }));
        assert!(none.pool_supported && none.pool.is_none(), "null is None, and the runner has the setting");
    }

    #[test]
    fn bring_in_keeps_a_custom_number_of_days() {
        let titles: Vec<String> = BringIn::choices(BringIn::Every(10)).into_iter().map(BringIn::title).collect();
        assert_eq!(titles, vec!["Every day", "Every 3 days", "Every 5 days", "Every week", "Every 10 days", "Every 2 weeks", "Only important ones", "Never"]);
    }

    #[test]
    fn reviewers_read_save_and_reorder() {
        let s = RunnerSettings::decode(&json!({ "labReviewers": [{ "provider": "grok", "model": "grok-4.7", "effort": "high" }, { "provider": "" }, { "provider": "codex" }] }));
        let list = s.lab_reviewers.expect("sent, so shown");
        assert_eq!(list, vec![LabReviewer { provider: "grok".into(), model: Some("grok-4.7".into()), effort: Some("high".into()) }, LabReviewer::new("codex")], "one with no provider is left out");
        assert_eq!(reviewers_change(&list), json!({ "labReviewers": [{ "provider": "grok", "model": "grok-4.7", "effort": "high" }, { "provider": "codex" }] }), "a reviewer with no model or effort sends neither");
        let old = RunnerSettings::decode(&json!({}));
        assert!(old.lab_reviewers.is_none() && old.lab_panel.is_none(), "an older runner: no lists");
        assert_eq!(old.lab_panel_lines, PANEL_LINES, "no labPanelLines: 150");

        let three = vec![LabReviewer::new("codex"), LabReviewer::new("claude"), LabReviewer::new("grok")];
        let order = |l: Vec<LabReviewer>| l.into_iter().map(|r| r.provider).collect::<Vec<_>>();
        assert_eq!(order(reviewer_dropped(&three, 2, 0).unwrap()), vec!["grok", "codex", "claude"], "dropped on the first: goes first");
        assert_eq!(order(reviewer_dropped(&three, 0, 2).unwrap()), vec!["claude", "grok", "codex"], "dropped on the last: goes last");
        assert!(reviewer_dropped(&three, 0, 0).is_none());
        assert!(reviewer_dropped(&three, 3, 0).is_none(), "a row that's gone moves nothing");
    }

    #[test]
    fn the_panel_is_a_list_of_its_own() {
        // Mike's own: Codex on both lists, each with its own effort.
        let s = RunnerSettings::decode(&json!({
            "labReviewers": [{ "provider": "codex", "effort": "high" }, { "provider": "grok", "model": "grok-4.7", "effort": "high" }, { "provider": "claude", "effort": "high" }],
            "labPanel": [{ "provider": "codex", "effort": "xhigh" }, { "provider": "opencode", "model": "google/gemini-4-neon", "effort": "high" }, { "provider": "" }],
            "labPanelLines": 200,
        }));
        let (every, panel) = (s.lab_reviewers.expect("sent"), s.lab_panel.expect("sent"));
        assert_eq!(every.len(), 3);
        assert_eq!(panel.iter().map(|r| (r.provider.as_str(), r.effort.as_deref())).collect::<Vec<_>>(), vec![("codex", Some("xhigh")), ("opencode", Some("high"))], "its own entries, one with no provider left out");
        assert_eq!(s.lab_panel_lines, 200);
        assert_eq!(
            panel_change(&panel),
            json!({ "labPanel": [{ "provider": "codex", "effort": "xhigh" }, { "provider": "opencode", "model": "google/gemini-4-neon", "effort": "high" }] }),
            "no panel key on an entry"
        );
        assert_eq!(panel[1].lab(), Some("Gemini"), "OpenCode on a Gemini model is Gemini");
        assert_eq!(panel[0].lab(), None, "only OpenCode names another lab");
        assert_eq!(LabReviewer { model: Some("zai/glm-5".into()), ..LabReviewer::new("opencode") }.lab(), None);
        assert_eq!(RunnerSettings::decode(&json!({ "labReviewers": [], "labPanel": [] })).lab_panel, Some(vec![]), "an empty panel is kept");
    }

    #[test]
    fn an_older_runners_ticks_become_the_panel() {
        let sent = json!({ "labReviewers": [
            { "provider": "opencode", "model": "google/gemini-4-carbon", "panel": true },
            { "provider": "codex", "panel": false },
            { "provider": "opencode", "model": "zai/glm-5", "panel": true },
        ] });
        let s = RunnerSettings::decode(&sent);
        let (list, panel) = (s.lab_reviewers.expect("sent, so shown"), s.lab_panel.expect("derived from the ticks"));
        assert_eq!(list.len(), 3, "the ticked ones stay on Every change, as they reviewed every change then");
        assert_eq!(panel.iter().map(|r| r.model.as_deref()).collect::<Vec<_>>(), vec![Some("google/gemini-4-carbon"), Some("zai/glm-5")], "only true is on the panel");
        assert_eq!(
            reviewers_change(&list),
            json!({ "labReviewers": [
                { "provider": "opencode", "model": "google/gemini-4-carbon" },
                { "provider": "codex" },
                { "provider": "opencode", "model": "zai/glm-5" },
            ] }),
            "the ticks aren't sent back"
        );
        assert_eq!(RunnerSettings::decode(&json!({ "labReviewers": [{ "provider": "codex" }] })).lab_panel, Some(vec![]), "none ticked: an empty panel");
        // Dragging the second OpenCode moves that one, not the first.
        let moved = reviewer_dropped(&list, 2, 0).unwrap();
        assert_eq!(moved.iter().map(|r| r.model.as_deref()).collect::<Vec<_>>(), vec![Some("zai/glm-5"), Some("google/gemini-4-carbon"), None]);
    }

    #[test]
    fn labs_by_model_as_the_runner_names_them() {
        assert_eq!(lab_of_model("google/gemini-4-neon"), Some("Gemini"));
        assert_eq!(lab_of_model("anthropic/claude-opus-5"), Some("Claude"));
        assert_eq!(lab_of_model("openai/gpt-6.1"), Some("GPT"));
        assert_eq!(lab_of_model("xai/grok-4.7"), Some("Grok"));
        assert_eq!(lab_of_model("zai/glm-5"), None);
    }
}
