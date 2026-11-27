// The runner's settings as the Settings window shows them (docs/protocol/settings.md,
// "Settings and models"), all kept in the runner's runner.json, and the words
// around them: a port of the Swift app's RunnerSettings and SettingsText.
// Decoded as forgivingly as the other models, so a missing field takes its
// default and an older runner's fields are ignored.
use serde_json::Value;
use std::collections::VecDeque;

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
        days.into_iter()
            .map(BringIn::Every)
            .chain([BringIn::Important, BringIn::Off])
            .collect()
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
        LabReviewer {
            provider: provider.to_owned(),
            model: None,
            effort: None,
        }
    }

    fn decode(v: &Value) -> Option<LabReviewer> {
        let provider = v["provider"].as_str().filter(|p| !p.is_empty())?.to_owned();
        let text = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        Some(LabReviewer {
            provider,
            model: text("model"),
            effort: text("effort"),
        })
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

/// The change `settings.update` takes for `models.providers`: `Some(list)`
/// saves a custom provider order inside the chosen pool; `None` resets to
/// automatic order (Claude, then Codex, then the pool's remaining small-job
/// providers).
pub fn small_job_providers_change(list: Option<&[String]>) -> Value {
    match list {
        Some(items) => serde_json::json!({ "models": { "providers": items } }),
        None => serde_json::json!({ "models": { "providers": Value::Null } }),
    }
}

/// The list with the provider at `from` dropped on the row at `to`. None when
/// nothing moves.
pub fn provider_dropped(list: &[String], from: usize, to: usize) -> Option<Vec<String>> {
    if from == to || from >= list.len() || to >= list.len() {
        return None;
    }
    let mut out = list.to_vec();
    let moved = out.remove(from);
    out.insert(to, moved);
    Some(out)
}

/// The default small-job provider order inside a pool (`models.providers`
/// unset/null): Claude first, then Codex, then any other small-job providers
/// in pool order (matching `runner/src/models/index.ts`, `providersToAsk`).
pub fn default_small_job_providers(pool_providers: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(pool_providers.len());
    for preferred in ["claude", "codex"] {
        if pool_providers.iter().any(|p| p == preferred) && !out.iter().any(|p| p == preferred) {
            out.push(preferred.to_owned());
        }
    }
    for p in pool_providers {
        if !out.iter().any(|x| x == p) {
            out.push(p.clone());
        }
    }
    out
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
    /// The pool whose logins answer small jobs (titles, the librarian);
    /// None means none, so those are off.
    pub pool: Option<String>,
    /// Whether the runner sends `models.pool` at all.
    pub pool_supported: bool,
    /// Custom provider order for small jobs inside `pool`; None means default
    /// order (Claude, then Codex, then the pool's remaining small-job providers).
    pub providers: Option<Vec<String>>,
    /// Whether the runner sends `models.providers` at all.
    pub providers_supported: bool,
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
            lab_reviewers: v["labReviewers"]
                .as_array()
                .map(|list| list.iter().filter_map(LabReviewer::decode).collect()),
            lab_panel: match (v["labPanel"].as_array(), v["labReviewers"].as_array()) {
                (Some(panel), _) => Some(panel.iter().filter_map(LabReviewer::decode).collect()),
                (None, Some(old)) => Some(
                    old.iter()
                        .filter(|r| r["panel"] == Value::Bool(true))
                        .filter_map(LabReviewer::decode)
                        .collect(),
                ),
                (None, None) => None,
            },
            lab_panel_lines: v["labPanelLines"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
                .unwrap_or(PANEL_LINES),
            keep_awake: v["keepAwake"].as_bool(),
            full_sync: v["fullSync"].as_bool(),
            spare_week: v["spareWeek"].as_bool(),
            bring_in_supported: bring_in.is_some(),
            bring_in: bring_in.unwrap_or(BringIn::STANDARD),
            pool: models["pool"]
                .as_str()
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
            pool_supported: models.get("pool").is_some(),
            providers: models["providers"].as_array().map(|list| {
                list.iter()
                    .filter_map(|p| p.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
                    .collect()
            }),
            providers_supported: models.get("providers").is_some(),
            private_folders: models["privateFolders"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect(),
            experiments: v["experiments"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| {
                    let id = e["id"].as_str()?.to_owned();
                    Some(Experiment {
                        name: e["name"].as_str().map_or_else(|| id.clone(), str::to_owned),
                        does: e["does"].as_str().unwrap_or("").to_owned(),
                        on: e["on"].as_bool().unwrap_or(false),
                        id,
                    })
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

/// Standing instructions (docs/protocol/settings.md, "Standing instructions"): what
/// every thread's agent is given. `outside` is set when the file isn't what
/// Settings last saved, so no agent is given it until Mike decides.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StandingInstructions {
    pub text: String,
    pub outside: bool,
}

impl StandingInstructions {
    pub fn decode(v: &Value) -> StandingInstructions {
        StandingInstructions {
            text: v["text"].as_str().unwrap_or("").to_owned(),
            outside: v["outside"].as_bool().unwrap_or(false),
        }
    }
}

/// Why a `settings.update` RPC failed, so the queue knows whether the runner
/// finished rejecting it or whether the write's fate is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateErrorKind {
    /// The runner rejected the update (e.g. validation error) and finished
    /// handling it, so queued edits can safely continue.
    Rejected,
    /// The RPC timed out client-side while the runner may still be processing
    /// it; stop the queue to avoid concurrent out-of-order writes and reload.
    TimedOut,
    /// The runner connection closed or is gone; stop the queue without sending
    /// onto a dead socket.
    Disconnected,
}

/// What `RunnerSettingsState::on_update_ok` / `on_update_err` asks the app to do next.
#[derive(Clone, Debug, PartialEq)]
pub enum UpdateOutcome {
    /// Reply belonged to a superseded or disconnected RPC; do nothing.
    Ignored,
    /// State was updated. Send `next` if another edit was queued behind this
    /// one, or ask `settings.get` when `should_reload` is true.
    Applied {
        next: Option<(u64, Value)>,
        should_reload: bool,
    },
}

const MAX_IN_FLIGHT_PUSHES: usize = 16;

#[derive(Clone, Debug)]
struct PendingSettingsUpdate {
    edit_id: u64,
    rpc_seq: u64,
    change: Value,
    /// `settings.updated` snapshots received while this edit was in flight,
    /// so `on_update_ok` can tell whether a newer external push arrived after
    /// this edit's own broadcast.
    pushes_seen: Vec<Value>,
    pushes_overflowed: bool,
}

/// Tracks the runner's settings (`settings.get`, `settings.update`, and
/// `settings.updated`) so optimistic local edits are serialized one RPC at a
/// time and never clobbered by stale replies or intermediate notifications.
#[derive(Clone, Debug, Default)]
pub struct RunnerSettingsState {
    /// Latest authoritative settings received from the runner.
    confirmed: Option<Value>,
    /// True once `confirmed` came from the current runner connection rather
    /// than being cached across a reconnect.
    confirmed_this_connection: bool,
    /// Displayed settings: `confirmed` with `in_flight` and `queued` overlaid.
    displayed: Option<Value>,
    /// The single `settings.update` RPC currently on the wire, if any.
    in_flight: Option<PendingSettingsUpdate>,
    /// Local edits waiting behind `in_flight`, in FIFO order.
    queued: VecDeque<PendingSettingsUpdate>,
    /// Monotonic id assigned to each local edit as the user submits it.
    next_edit_id: u64,
    /// Monotonic token for `settings.get`; bumped on each new get and whenever
    /// newer authoritative settings arrive from the runner.
    get_epoch: u64,
    /// Monotonic id for `settings.update` RPCs so replies from before a
    /// connection reset can be ignored.
    rpc_seq: u64,
    /// `next_edit_id` when the last error happened, so a pre-existing queued
    /// edit succeeding immediately after does not erase the error before the
    /// user makes a fresh edit.
    error_at_edit: u64,
    error: Option<String>,
    unsupported: bool,
}

impl RunnerSettingsState {
    pub fn displayed(&self) -> Option<&Value> {
        self.displayed.as_ref()
    }

    pub fn confirmed(&self) -> Option<&Value> {
        self.confirmed.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn unsupported(&self) -> bool {
        self.unsupported
    }

    pub fn has_pending(&self) -> bool {
        self.in_flight.is_some() || !self.queued.is_empty()
    }

    pub fn has_pending_experiment(&self, id: &str) -> bool {
        self.in_flight.iter().chain(self.queued.iter()).any(|p| {
            p.change
                .get("experiments")
                .and_then(|e| e.get(id))
                .is_some()
        })
    }

    pub fn experiment_on(&self, id: &str) -> Option<bool> {
        experiment_in(self.displayed.as_ref()?, id)
    }

    /// Experiment state confirmed on the current runner connection (`None`
    /// while only a cached pre-reconnect snapshot is held, so callers fall
    /// back to the fresh `hello` until `settings.get` answers).
    pub fn confirmed_experiment_on(&self, id: &str) -> Option<bool> {
        if !self.confirmed_this_connection {
            return None;
        }
        experiment_in(self.confirmed.as_ref()?, id)
    }

    /// Aborts any in-flight or queued edits when the runner connection drops
    /// so queued edits are not sent onto a dead socket, and reports the loss
    /// in `error`. Returns `true` if pending edits were aborted.
    pub fn on_disconnected(&mut self, message: impl Into<String>) -> bool {
        self.confirmed_this_connection = false;
        if !self.has_pending() {
            return false;
        }
        self.in_flight = None;
        self.queued.clear();
        self.rpc_seq += 1;
        self.error = Some(message.into());
        self.error_at_edit = self.next_edit_id;
        self.recompute_displayed();
        true
    }

    /// Prepares state for a new runner connection: marks cached settings as
    /// unconfirmed for this session, aborts any leftover pending edits from
    /// the previous connection (recording an error rather than silently
    /// dropping them), and keeps cached confirmed settings visible until
    /// `settings.get` answers.
    pub fn on_connected(&mut self, disconnect_message: impl Into<String>) {
        if self.has_pending() {
            self.in_flight = None;
            self.queued.clear();
            self.error = Some(disconnect_message.into());
            self.error_at_edit = self.next_edit_id;
        }
        self.confirmed_this_connection = false;
        self.rpc_seq += 1;
        self.get_epoch += 1;
        self.recompute_displayed();
    }

    pub fn begin_get(&mut self) -> u64 {
        self.get_epoch += 1;
        self.get_epoch
    }

    pub fn on_get_ok(&mut self, token: u64, settings: Value) -> bool {
        if token != self.get_epoch {
            return false;
        }
        self.confirmed = Some(settings);
        self.confirmed_this_connection = true;
        self.unsupported = false;
        self.recompute_displayed();
        true
    }

    pub fn on_get_unsupported(&mut self, token: u64) -> bool {
        if token != self.get_epoch {
            return false;
        }
        self.unsupported = true;
        self.confirmed = None;
        self.confirmed_this_connection = false;
        self.in_flight = None;
        self.queued.clear();
        self.displayed = None;
        true
    }

    pub fn on_updated(&mut self, settings: Value) {
        if let Some(in_flight) = self.in_flight.as_mut() {
            if in_flight.pushes_seen.len() < MAX_IN_FLIGHT_PUSHES {
                in_flight.pushes_seen.push(settings.clone());
            } else {
                in_flight.pushes_overflowed = true;
            }
        }
        self.get_epoch += 1;
        self.confirmed = Some(settings);
        self.confirmed_this_connection = true;
        self.unsupported = false;
        self.recompute_displayed();
    }

    /// Applies `change` optimistically and returns `Some((seq, change))` if
    /// the caller should send `settings.update` immediately, or `None` if it
    /// was queued behind an already in-flight update.
    pub fn queue_update(&mut self, change: Value) -> Option<(u64, Value)> {
        self.next_edit_id += 1;
        let edit_id = self.next_edit_id;
        let to_send = if self.in_flight.is_none() {
            self.rpc_seq += 1;
            let seq = self.rpc_seq;
            self.in_flight = Some(PendingSettingsUpdate {
                edit_id,
                rpc_seq: seq,
                change: change.clone(),
                pushes_seen: Vec::new(),
                pushes_overflowed: false,
            });
            Some((seq, change))
        } else {
            self.queued.push_back(PendingSettingsUpdate {
                edit_id,
                rpc_seq: 0,
                change,
                pushes_seen: Vec::new(),
                pushes_overflowed: false,
            });
            None
        };
        self.recompute_displayed();
        to_send
    }

    pub fn on_update_ok(&mut self, seq: u64, settings: Value) -> UpdateOutcome {
        if self.in_flight.as_ref().is_none_or(|p| p.rpc_seq != seq) {
            return UpdateOutcome::Ignored;
        }
        let Some(finished) = self.in_flight.take() else {
            return UpdateOutcome::Ignored;
        };
        self.get_epoch += 1;
        // If `settings.updated` broadcasts arrived while this RPC was in
        // flight and another push came AFTER this reply's own snapshot, keep
        // the newer pushed state instead of overwriting it with an older reply.
        let newer_push_exists = finished
            .pushes_seen
            .iter()
            .rposition(|p| p == &settings)
            .is_some_and(|idx| idx + 1 < finished.pushes_seen.len());
        let mut should_reload = false;
        if finished.pushes_overflowed {
            should_reload = true;
        } else if !newer_push_exists {
            self.confirmed = Some(settings);
        }
        self.confirmed_this_connection = true;
        self.unsupported = false;
        if finished.edit_id > self.error_at_edit {
            self.error = None;
        }
        let next = self.promote_next();
        if next.is_some() {
            should_reload = false;
        }
        self.recompute_displayed();
        UpdateOutcome::Applied {
            next,
            should_reload,
        }
    }

    pub fn on_update_err(
        &mut self,
        seq: u64,
        message: String,
        kind: UpdateErrorKind,
    ) -> UpdateOutcome {
        if self.in_flight.as_ref().is_none_or(|p| p.rpc_seq != seq) {
            return UpdateOutcome::Ignored;
        }
        self.in_flight = None;
        self.error = Some(message);
        self.error_at_edit = self.next_edit_id;
        match kind {
            UpdateErrorKind::Disconnected => {
                self.queued.clear();
                self.rpc_seq += 1;
                self.recompute_displayed();
                UpdateOutcome::Applied {
                    next: None,
                    should_reload: false,
                }
            }
            UpdateErrorKind::TimedOut => {
                self.queued.clear();
                self.rpc_seq += 1;
                self.recompute_displayed();
                UpdateOutcome::Applied {
                    next: None,
                    should_reload: true,
                }
            }
            UpdateErrorKind::Rejected => {
                let next = self.promote_next();
                self.recompute_displayed();
                UpdateOutcome::Applied {
                    should_reload: next.is_none(),
                    next,
                }
            }
        }
    }

    fn promote_next(&mut self) -> Option<(u64, Value)> {
        let mut next = self.queued.pop_front()?;
        self.rpc_seq += 1;
        next.rpc_seq = self.rpc_seq;
        next.pushes_seen.clear();
        next.pushes_overflowed = false;
        let out = (next.rpc_seq, next.change.clone());
        self.in_flight = Some(next);
        Some(out)
    }

    fn recompute_displayed(&mut self) {
        let Some(mut value) = self.confirmed.clone() else {
            self.displayed = None;
            return;
        };
        if let Some(in_flight) = &self.in_flight {
            merge_json(&mut value, &in_flight.change);
        }
        for queued in &self.queued {
            merge_json(&mut value, &queued.change);
        }
        self.displayed = Some(value);
    }
}

fn experiment_in(settings: &Value, id: &str) -> Option<bool> {
    settings["experiments"]
        .as_array()?
        .iter()
        .find(|e| e["id"] == id)
        .map(|e| e["on"].as_bool() == Some(true))
}

/// `change`'s fields written over `into`'s, objects within objects too, as a
/// `settings.update` changes only what it names.
pub fn merge_json(into: &mut Value, change: &Value) {
    match (into, change) {
        // `experiments` is a list of { id, on } but a change names them by
        // id ({ "experiments": { id: on } }). Replacing the list with that
        // emptied Experiments until the runner answered, so the page got
        // shorter and the pane lost its place (21 Nov).
        (Value::Array(list), Value::Object(change))
            if list
                .iter()
                .all(|item| item.get("id").is_some_and(Value::is_string)) =>
        {
            for item in list.iter_mut() {
                if let Some(on) = item["id"].as_str().and_then(|id| change.get(id)) {
                    item["on"] = on.clone();
                }
            }
        }
        (Value::Object(into), Value::Object(change)) => {
            for (key, value) in change {
                match into.get_mut(key) {
                    Some(existing)
                        if (existing.is_object() || existing.is_array()) && value.is_object() =>
                    {
                        merge_json(existing, value)
                    }
                    _ => {
                        into.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (into, change) => *into = change.clone(),
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
        assert_eq!(
            s.experiments[1].name, "bare",
            "an experiment with no name goes by its id"
        );
        assert_eq!(experiment_about(&s.experiments[0].does), "The GPUI app.");
        let old = RunnerSettings::decode(&json!({ "defaultCwd": "/x", "models": {} }));
        assert!(
            old.lab_review && !old.lab_review_supported,
            "an older runner shows no Code review switch"
        );
        assert!(!old.pool_supported && old.keep_awake.is_none() && !old.bring_in_supported);
        assert!(
            old.full_sync.is_none(),
            "an older runner shows no Full sync switch"
        );
        assert!(
            old.spare_week.is_none(),
            "an older runner shows no spare week switch"
        );
        let none = RunnerSettings::decode(&json!({ "models": { "pool": null } }));
        assert!(
            none.pool_supported && none.pool.is_none(),
            "null is None, and the runner has the setting"
        );
    }

    #[test]
    fn bring_in_keeps_a_custom_number_of_days() {
        let titles: Vec<String> = BringIn::choices(BringIn::Every(10))
            .into_iter()
            .map(BringIn::title)
            .collect();
        assert_eq!(
            titles,
            vec![
                "Every day",
                "Every 3 days",
                "Every 5 days",
                "Every week",
                "Every 10 days",
                "Every 2 weeks",
                "Only important ones",
                "Never"
            ]
        );
    }

    #[test]
    fn reviewers_read_save_and_reorder() {
        let s = RunnerSettings::decode(
            &json!({ "labReviewers": [{ "provider": "grok", "model": "grok-4.7", "effort": "high" }, { "provider": "" }, { "provider": "codex" }] }),
        );
        let list = s.lab_reviewers.expect("sent, so shown");
        assert_eq!(
            list,
            vec![
                LabReviewer {
                    provider: "grok".into(),
                    model: Some("grok-4.7".into()),
                    effort: Some("high".into())
                },
                LabReviewer::new("codex")
            ],
            "one with no provider is left out"
        );
        assert_eq!(
            reviewers_change(&list),
            json!({ "labReviewers": [{ "provider": "grok", "model": "grok-4.7", "effort": "high" }, { "provider": "codex" }] }),
            "a reviewer with no model or effort sends neither"
        );
        let old = RunnerSettings::decode(&json!({}));
        assert!(
            old.lab_reviewers.is_none() && old.lab_panel.is_none(),
            "an older runner: no lists"
        );
        assert_eq!(old.lab_panel_lines, PANEL_LINES, "no labPanelLines: 150");

        let three = vec![
            LabReviewer::new("codex"),
            LabReviewer::new("claude"),
            LabReviewer::new("grok"),
        ];
        let order = |l: Vec<LabReviewer>| l.into_iter().map(|r| r.provider).collect::<Vec<_>>();
        assert_eq!(
            order(reviewer_dropped(&three, 2, 0).unwrap()),
            vec!["grok", "codex", "claude"],
            "dropped on the first: goes first"
        );
        assert_eq!(
            order(reviewer_dropped(&three, 0, 2).unwrap()),
            vec!["claude", "grok", "codex"],
            "dropped on the last: goes last"
        );
        assert!(reviewer_dropped(&three, 0, 0).is_none());
        assert!(
            reviewer_dropped(&three, 3, 0).is_none(),
            "a row that's gone moves nothing"
        );
    }

    #[test]
    fn small_job_providers_read_reorder_and_reset() {
        let old = RunnerSettings::decode(&json!({ "models": { "pool": "claude" } }));
        assert!(!old.providers_supported && old.providers.is_none());

        let auto =
            RunnerSettings::decode(&json!({ "models": { "pool": "main", "providers": null } }));
        assert!(auto.providers_supported && auto.providers.is_none());

        let custom = RunnerSettings::decode(
            &json!({ "models": { "pool": "main", "providers": ["codex", "", "claude"] } }),
        );
        assert!(custom.providers_supported);
        assert_eq!(
            custom.providers,
            Some(vec!["codex".into(), "claude".into()])
        );

        let three: Vec<String> = vec!["claude".into(), "codex".into(), "grok".into()];
        assert_eq!(
            provider_dropped(&three, 2, 0).unwrap(),
            vec!["grok", "claude", "codex"]
        );
        assert_eq!(
            provider_dropped(&three, 0, 2).unwrap(),
            vec!["codex", "grok", "claude"]
        );
        assert!(provider_dropped(&three, 1, 1).is_none());

        assert_eq!(
            default_small_job_providers(&[
                "grok".into(),
                "codex".into(),
                "claude".into(),
                "opencode".into()
            ]),
            vec!["claude", "codex", "grok", "opencode"]
        );
        assert_eq!(
            small_job_providers_change(Some(&three)),
            json!({ "models": { "providers": ["claude", "codex", "grok"] } })
        );
        assert_eq!(
            small_job_providers_change(None),
            json!({ "models": { "providers": null } })
        );

        // Optimistic overlay via merge_json handles both setting and resetting.
        let mut snap =
            json!({ "models": { "pool": "main", "privateFolders": [], "providers": null } });
        merge_json(&mut snap, &small_job_providers_change(Some(&three)));
        assert_eq!(
            snap["models"]["providers"],
            json!(["claude", "codex", "grok"])
        );
        merge_json(&mut snap, &small_job_providers_change(None));
        assert_eq!(snap["models"]["providers"], Value::Null);
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
        assert_eq!(
            panel
                .iter()
                .map(|r| (r.provider.as_str(), r.effort.as_deref()))
                .collect::<Vec<_>>(),
            vec![("codex", Some("xhigh")), ("opencode", Some("high"))],
            "its own entries, one with no provider left out"
        );
        assert_eq!(s.lab_panel_lines, 200);
        assert_eq!(
            panel_change(&panel),
            json!({ "labPanel": [{ "provider": "codex", "effort": "xhigh" }, { "provider": "opencode", "model": "google/gemini-4-neon", "effort": "high" }] }),
            "no panel key on an entry"
        );
        assert_eq!(
            panel[1].lab(),
            Some("Gemini"),
            "OpenCode on a Gemini model is Gemini"
        );
        assert_eq!(panel[0].lab(), None, "only OpenCode names another lab");
        assert_eq!(
            LabReviewer {
                model: Some("zai/glm-5".into()),
                ..LabReviewer::new("opencode")
            }
            .lab(),
            None
        );
        assert_eq!(
            RunnerSettings::decode(&json!({ "labReviewers": [], "labPanel": [] })).lab_panel,
            Some(vec![]),
            "an empty panel is kept"
        );
    }

    #[test]
    fn an_older_runners_ticks_become_the_panel() {
        let sent = json!({ "labReviewers": [
            { "provider": "opencode", "model": "google/gemini-4-carbon", "panel": true },
            { "provider": "codex", "panel": false },
            { "provider": "opencode", "model": "zai/glm-5", "panel": true },
        ] });
        let s = RunnerSettings::decode(&sent);
        let (list, panel) = (
            s.lab_reviewers.expect("sent, so shown"),
            s.lab_panel.expect("derived from the ticks"),
        );
        assert_eq!(
            list.len(),
            3,
            "the ticked ones stay on Every change, as they reviewed every change then"
        );
        assert_eq!(
            panel.iter().map(|r| r.model.as_deref()).collect::<Vec<_>>(),
            vec![Some("google/gemini-4-carbon"), Some("zai/glm-5")],
            "only true is on the panel"
        );
        assert_eq!(
            reviewers_change(&list),
            json!({ "labReviewers": [
                { "provider": "opencode", "model": "google/gemini-4-carbon" },
                { "provider": "codex" },
                { "provider": "opencode", "model": "zai/glm-5" },
            ] }),
            "the ticks aren't sent back"
        );
        assert_eq!(
            RunnerSettings::decode(&json!({ "labReviewers": [{ "provider": "codex" }] })).lab_panel,
            Some(vec![]),
            "none ticked: an empty panel"
        );
        // Dragging the second OpenCode moves that one, not the first.
        let moved = reviewer_dropped(&list, 2, 0).unwrap();
        assert_eq!(
            moved.iter().map(|r| r.model.as_deref()).collect::<Vec<_>>(),
            vec![Some("zai/glm-5"), Some("google/gemini-4-carbon"), None]
        );
    }

    #[test]
    fn labs_by_model_as_the_runner_names_them() {
        assert_eq!(lab_of_model("google/gemini-4-neon"), Some("Gemini"));
        assert_eq!(lab_of_model("anthropic/claude-opus-5"), Some("Claude"));
        assert_eq!(lab_of_model("openai/gpt-6.1"), Some("GPT"));
        assert_eq!(lab_of_model("xai/grok-4.7"), Some("Grok"));
        assert_eq!(lab_of_model("zai/glm-5"), None);
    }

    fn sample_settings(coordinators: bool, keep_awake: bool, lab_review: bool) -> Value {
        json!({
            "defaultCwd": "/Users/alex/code",
            "keepAwake": keep_awake,
            "labReview": lab_review,
            "models": { "pool": "claude", "privateFolders": [] },
            "experiments": [
                { "id": "coordinators", "name": "Project coordinators", "does": "Work.", "on": coordinators },
                { "id": "inboxGuess", "name": "Inbox guess", "does": "Guess.", "on": false }
            ]
        })
    }

    #[test]
    fn rapid_coordinator_toggle_off_then_on_is_serialized_and_never_clobbered() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        assert!(state.on_get_ok(tok, sample_settings(true, true, true)));
        assert_eq!(state.experiment_on("coordinators"), Some(true));

        // 1. User turns coordinators OFF: sends RPC 1 immediately.
        let (seq1, c1) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("first update sends immediately");
        assert_eq!(c1, json!({ "experiments": { "coordinators": false } }));
        assert_eq!(state.experiment_on("coordinators"), Some(false));
        assert!(state.has_pending_experiment("coordinators"));

        // 2. While RPC 1 is still in flight, user turns coordinators back ON.
        //    Must NOT send RPC 2 yet (so it cannot overtake RPC 1 on a slow runner),
        //    and displayed state must immediately be ON.
        assert_eq!(
            state.queue_update(json!({ "experiments": { "coordinators": true } })),
            None,
            "second update queues behind in-flight first update"
        );
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert!(state.has_pending_experiment("coordinators"));

        // 3. RPC 1's settings.updated push arrives (coordinators = false):
        //    must NOT clobber the optimistic ON state!
        state.on_updated(sample_settings(false, true, true));
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert_eq!(state.confirmed_experiment_on("coordinators"), Some(false));
        assert!(state.has_pending_experiment("coordinators"));

        // 4. RPC 1 replies Ok (coordinators = false):
        //    must keep displayed ON and now flush RPC 2 (coordinators = true).
        let outcome1 = state.on_update_ok(seq1, sample_settings(false, true, true));
        let (seq2, c2) = match outcome1 {
            UpdateOutcome::Applied {
                next: Some(next),
                should_reload: false,
            } => next,
            other => panic!("expected queued update to flush, got {other:?}"),
        };
        assert_eq!(c2, json!({ "experiments": { "coordinators": true } }));
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert_eq!(state.confirmed_experiment_on("coordinators"), Some(false));
        assert!(state.has_pending_experiment("coordinators"));

        // 5. RPC 2's settings.updated and Ok arrive (coordinators = true):
        state.on_updated(sample_settings(true, true, true));
        assert_eq!(
            state.on_update_ok(seq2, sample_settings(true, true, true)),
            UpdateOutcome::Applied {
                next: None,
                should_reload: false,
            }
        );
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert_eq!(state.confirmed_experiment_on("coordinators"), Some(true));
        assert!(!state.has_pending());
        assert!(!state.has_pending_experiment("coordinators"));
    }

    #[test]
    fn stale_settings_get_cannot_clobber_newer_updates_or_notifications() {
        let mut state = RunnerSettingsState::default();
        let tok_initial = state.begin_get();
        assert!(state.on_get_ok(tok_initial, sample_settings(true, true, true)));

        // Start a settings.get, then user toggles coordinators off before get finishes.
        let tok_old = state.begin_get();
        let (seq1, _) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("sends");
        assert_eq!(state.experiment_on("coordinators"), Some(false));

        // Even if tok_old arrives before seq1 completes, optimistic edit stays overlaid.
        assert!(state.on_get_ok(tok_old, sample_settings(true, true, true)));
        assert_eq!(state.experiment_on("coordinators"), Some(false));

        // Start another get, let seq1 complete first, then the old get arrives late: ignored!
        let tok_stale = state.begin_get();
        state.on_update_ok(seq1, sample_settings(false, true, true));
        assert!(
            !state.on_get_ok(tok_stale, sample_settings(true, true, true)),
            "settings.get started before update_ok must be ignored"
        );
        assert_eq!(state.experiment_on("coordinators"), Some(false));

        // A settings.get started before settings.updated is also ignored.
        let tok_before_push = state.begin_get();
        state.on_updated(sample_settings(true, false, true));
        assert!(
            !state.on_get_ok(tok_before_push, sample_settings(false, true, true)),
            "settings.get started before settings.updated must be ignored"
        );
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
    }

    #[test]
    fn rapid_updates_to_different_keys_and_external_push_merge_cleanly() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        // Toggle keepAwake=false, then labReview=false while first is in flight.
        let (seq1, _) = state
            .queue_update(json!({ "keepAwake": false }))
            .expect("first sends");
        assert_eq!(state.queue_update(json!({ "labReview": false })), None);
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
        assert_eq!(state.displayed().unwrap()["labReview"], json!(false));

        // Another window changes defaultCwd while our two edits are pending.
        let mut external = sample_settings(true, true, true);
        external["defaultCwd"] = json!("/Users/alex/other");
        state.on_updated(external);
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/Users/alex/other"),
            "external change is kept"
        );
        assert_eq!(
            state.displayed().unwrap()["keepAwake"],
            json!(false),
            "in-flight local change stays overlaid"
        );
        assert_eq!(
            state.displayed().unwrap()["labReview"],
            json!(false),
            "queued local change stays overlaid"
        );

        // RPC 1 finishes: keepAwake=false confirmed, labReview=false still displayed & now sent.
        let mut after1 = sample_settings(true, false, true);
        after1["defaultCwd"] = json!("/Users/alex/other");
        let (seq2, c2) = match state.on_update_ok(seq1, after1) {
            UpdateOutcome::Applied {
                next: Some(next),
                should_reload: false,
            } => next,
            other => panic!("expected seq2, got {other:?}"),
        };
        assert_eq!(c2, json!({ "labReview": false }));
        assert_eq!(state.displayed().unwrap()["labReview"], json!(false));

        // RPC 2 finishes: everything confirmed.
        let mut after2 = sample_settings(true, false, false);
        after2["defaultCwd"] = json!("/Users/alex/other");
        state.on_update_ok(seq2, after2);
        assert!(!state.has_pending());
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
        assert_eq!(state.displayed().unwrap()["labReview"], json!(false));
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/Users/alex/other")
        );
    }

    #[test]
    fn error_rollback_rolls_back_only_failed_edit_and_keeps_error_visible_for_prequeued_edit() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        // Single failing edit: rolls back to confirmed and requests reload.
        let (seq0, _) = state
            .queue_update(json!({ "defaultCwd": "/nope" }))
            .expect("sends");
        assert_eq!(state.displayed().unwrap()["defaultCwd"], json!("/nope"));
        assert_eq!(
            state.on_update_err(
                seq0,
                "Folder not found: /nope".into(),
                UpdateErrorKind::Rejected
            ),
            UpdateOutcome::Applied {
                next: None,
                should_reload: true,
            }
        );
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/Users/alex/code")
        );
        assert_eq!(state.error(), Some("Folder not found: /nope"));

        // Edit 1 (bad cwd) fails while Edit 2 (valid keepAwake=false) is queued behind it.
        let (seq1, _) = state
            .queue_update(json!({ "defaultCwd": "/still-nope" }))
            .expect("sends");
        assert_eq!(state.queue_update(json!({ "keepAwake": false })), None);
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/still-nope")
        );
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));

        let (seq2, c2) = match state.on_update_err(
            seq1,
            "Folder not found: /still-nope".into(),
            UpdateErrorKind::Rejected,
        ) {
            UpdateOutcome::Applied {
                next: Some(next),
                should_reload: false,
            } => next,
            other => panic!("expected queued valid edit to flush, got {other:?}"),
        };
        assert_eq!(c2, json!({ "keepAwake": false }));
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/Users/alex/code"),
            "failed edit rolled back"
        );
        assert_eq!(
            state.displayed().unwrap()["keepAwake"],
            json!(false),
            "valid queued edit preserved"
        );
        assert_eq!(state.error(), Some("Folder not found: /still-nope"));

        // Pre-queued Edit 2 succeeds: keepAwake=false takes effect, and Edit 1's error
        // stays visible until a fresh edit succeeds.
        state.on_update_ok(seq2, sample_settings(true, false, true));
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
        assert_eq!(state.error(), Some("Folder not found: /still-nope"));

        // A fresh edit after the error succeeds and clears the error.
        let (seq3, _) = state
            .queue_update(json!({ "labReview": false }))
            .expect("sends");
        state.on_update_ok(seq3, sample_settings(true, false, false));
        assert_eq!(state.error(), None);
    }

    #[test]
    fn reconnect_discards_stale_pending_updates_and_ignores_late_replies() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        let (seq1, _) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("sends");
        assert_eq!(state.queue_update(json!({ "keepAwake": false })), None);
        assert!(state.has_pending());

        // Connection drops and reconnects before seq1 replies.
        state.on_connected("The runner disconnected before your change was saved.");
        assert!(!state.has_pending());
        assert_eq!(
            state.experiment_on("coordinators"),
            Some(true),
            "cached confirmed state remains visible while fresh settings.get loads"
        );
        assert_eq!(
            state.confirmed_experiment_on("coordinators"),
            None,
            "cached snapshot is not treated as confirmed on the new connection"
        );
        assert_eq!(
            state.error(),
            Some("The runner disconnected before your change was saved."),
            "dropped pending edits are reported instead of silently disappearing"
        );

        // Late closed error or reply from old connection is ignored.
        assert_eq!(
            state.on_update_err(
                seq1,
                "Connection closed".into(),
                UpdateErrorKind::Disconnected
            ),
            UpdateOutcome::Ignored
        );
        assert_eq!(
            state.on_update_ok(seq1, sample_settings(false, true, true)),
            UpdateOutcome::Ignored
        );

        // Fresh settings.get on new connection applies cleanly.
        let tok2 = state.begin_get();
        assert!(state.on_get_ok(tok2, sample_settings(true, false, true)));
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
    }

    #[test]
    fn late_settings_updated_for_first_edit_after_ok1_does_not_clobber_second_edit() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        let (seq1, _) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("first sends");
        assert_eq!(
            state.queue_update(json!({ "experiments": { "coordinators": true } })),
            None
        );

        // RPC 1 Ok arrives on the oneshot channel BEFORE its settings.updated
        // notification is drained from the notification channel.
        let (seq2, _) = match state.on_update_ok(seq1, sample_settings(false, true, true)) {
            UpdateOutcome::Applied {
                next: Some(next),
                should_reload: false,
            } => next,
            other => panic!("expected seq2, got {other:?}"),
        };
        assert_eq!(state.experiment_on("coordinators"), Some(true));

        // Now the delayed settings.updated(false) from RPC 1 arrives while seq2 is in flight.
        state.on_updated(sample_settings(false, true, true));
        assert_eq!(
            state.experiment_on("coordinators"),
            Some(true),
            "in-flight second edit stays overlaid on delayed first push"
        );

        // RPC 2 finishes.
        state.on_updated(sample_settings(true, true, true));
        state.on_update_ok(seq2, sample_settings(true, true, true));
        assert_eq!(state.experiment_on("coordinators"), Some(true));
        assert!(!state.has_pending());
    }

    #[test]
    fn update_before_first_get_is_preserved_when_get_arrives_and_unsupported_ignores_stale() {
        let mut state = RunnerSettingsState::default();
        let tok_old = state.begin_get();
        let (seq1, _) = state
            .queue_update(json!({ "keepAwake": false }))
            .expect("sends even before initial get");
        assert!(state.displayed().is_none());

        // Initial get arrives while seq1 is still in flight: seq1 overlays cleanly.
        assert!(state.on_get_ok(tok_old, sample_settings(true, true, true)));
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));

        // Stale unsupported response after a newer get token is ignored.
        let tok_new = state.begin_get();
        assert!(!state.on_get_unsupported(tok_old));
        assert!(!state.unsupported());

        // Current unsupported token clears everything.
        assert!(state.on_get_unsupported(tok_new));
        assert!(state.unsupported());
        assert!(state.displayed().is_none());
        assert!(!state.has_pending());
        assert_eq!(
            state.on_update_ok(seq1, sample_settings(true, false, true)),
            UpdateOutcome::Ignored
        );
    }

    #[test]
    fn older_update_ok_does_not_overwrite_newer_external_push() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        let (seq1, _) = state
            .queue_update(json!({ "keepAwake": false }))
            .expect("sends");

        // Local RPC 1 succeeds on the runner (push 1), then another window
        // changes defaultCwd (push 2). Both notifications arrive before the
        // local RPC 1 completion task runs.
        let s1 = sample_settings(true, false, true);
        let mut s2 = s1.clone();
        s2["defaultCwd"] = json!("/Users/alex/other");
        state.on_updated(s1.clone());
        state.on_updated(s2.clone());

        assert_eq!(
            state.on_update_ok(seq1, s1),
            UpdateOutcome::Applied {
                next: None,
                should_reload: false,
            }
        );
        assert_eq!(
            state.displayed().unwrap()["defaultCwd"],
            json!("/Users/alex/other"),
            "older RPC reply must not overwrite newer external settings.updated"
        );
        assert_eq!(state.displayed().unwrap()["keepAwake"], json!(false));
    }

    #[test]
    fn disconnect_aborts_queued_edits_without_sending_onto_dead_socket_and_keeps_error_across_reconnect(
    ) {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        let (seq1, _) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("sends");
        assert_eq!(
            state.queue_update(json!({ "experiments": { "coordinators": true } })),
            None
        );

        // Case A: transport error arrives while disconnected before on_connected.
        assert_eq!(
            state.on_update_err(
                seq1,
                "Connection closed".into(),
                UpdateErrorKind::Disconnected
            ),
            UpdateOutcome::Applied {
                next: None,
                should_reload: false,
            },
            "must not promote queued edits onto a disconnected client"
        );
        assert!(!state.has_pending());
        assert_eq!(state.error(), Some("Connection closed"));

        // Reconnect does not silently erase the disconnect error, and marks
        // cached confirmation stale until fresh settings arrive.
        state.on_connected("The runner disconnected before your change was saved.");
        assert_eq!(state.error(), Some("Connection closed"));
        assert_eq!(state.confirmed_experiment_on("coordinators"), None);

        let tok2 = state.begin_get();
        assert!(state.on_get_ok(tok2, sample_settings(false, true, true)));
        assert_eq!(state.confirmed_experiment_on("coordinators"), Some(false));
        assert_eq!(state.experiment_on("coordinators"), Some(false));

        // Case B: on_disconnected fires while pending edits exist.
        let (seq2, _) = state
            .queue_update(json!({ "keepAwake": false }))
            .expect("sends");
        assert_eq!(state.queue_update(json!({ "labReview": false })), None);
        assert!(state.on_disconnected("The runner disconnected before your change was saved."));
        assert!(!state.has_pending());
        assert_eq!(
            state.on_update_err(
                seq2,
                "Connection closed".into(),
                UpdateErrorKind::Disconnected
            ),
            UpdateOutcome::Ignored
        );
        assert_eq!(
            state.error(),
            Some("The runner disconnected before your change was saved.")
        );
    }

    #[test]
    fn timeout_aborts_queued_edits_and_reloads_instead_of_sending_concurrent_write() {
        let mut state = RunnerSettingsState::default();
        let tok = state.begin_get();
        state.on_get_ok(tok, sample_settings(true, true, true));

        let (seq1, _) = state
            .queue_update(json!({ "experiments": { "coordinators": false } }))
            .expect("sends");
        assert_eq!(
            state.queue_update(json!({ "experiments": { "coordinators": true } })),
            None
        );

        assert_eq!(
            state.on_update_err(
                seq1,
                "The runner didn't answer settings.update".into(),
                UpdateErrorKind::TimedOut
            ),
            UpdateOutcome::Applied {
                next: None,
                should_reload: true,
            },
            "timeout must not promote queued edit while runner may still be processing seq1"
        );
        assert!(!state.has_pending());
        assert_eq!(
            state.error(),
            Some("The runner didn't answer settings.update")
        );
        assert_eq!(state.experiment_on("coordinators"), Some(true));
    }
}
