// What the Updates panel and its activity bar icon say, a port of
// UpdatesText.swift and `CliText` (AccountUsageText.swift): the runner's own
// update (docs/protocol/updates.md, "Runner updates"), Mike's releases on a fork
// ("Mike's releases"), and the agent CLIs' versions (`clis.list`,
// `CliStatus`). Plain sentences, one per thing going on; the view adds the
// buttons.
//
// The app's own update is AppUpdater in the Swift app and app_update.rs in
// this one, each building main and swapping it in (`AppSide`).
use crate::inbox::parse_ms;
use crate::slash::cli_name;
use chrono::{DateTime, Duration, TimeZone};
use serde_json::Value;

fn text(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_owned)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect()
}

/// `RunnerUpdates`: the runner following main, old releases still finishing
/// turns, a LaunchAgent only install-runner.sh brings up to date, and Mike's
/// releases. From hello's `updates`, then `runner.updates`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunnerUpdates {
    /// off, idle, checking, building, waiting or failed.
    pub state: String,
    pub commit: Option<String>,
    pub subject: Option<String>,
    pub reason: Option<String>,
    pub old_runners: Vec<OldRunner>,
    pub launcher_changed: bool,
    /// Which way the LaunchAgent is behind main, in a sentence (runners from
    /// before 29 Oct 2026 don't send it).
    pub launcher_reason: Option<String>,
    /// What the runner is doing about it (runner.reinstall); None while
    /// it's waiting for Reinstall now, and from runners before 14 Nov 2026.
    pub reinstall: Option<Reinstall>,
    /// The runner's update of it stages for the next login, stopping
    /// nothing (protocol `launcherStages`, from 15 Nov 2026). The runner of
    /// 14 Nov reinstalled once idle instead, so its panel offers no button.
    pub launcher_stages: bool,
    /// Left out by runners before 30 Oct 2026, and while it's off.
    pub upstream: Option<Upstream>,
    /// This machine can't follow GitHub's main properly. None while it's fine.
    pub follow_problem: Option<String>,
    pub web_runtime_problem: Option<String>,
    /// Behind, but waiting on cef-rs, so nothing to do: a line in the panel
    /// only, never the icon or its tooltip (protocol `webRuntimeNote`).
    pub web_runtime_note: Option<String>,
    /// The other runners saying that of themselves (the main Mac's runner).
    pub behind_runners: Vec<BehindRunner>,
    /// A fork's own changes to the old Swift app not yet rebuilt in this one
    /// (protocol "Your changes to the old app"). Empty while there are none.
    pub swift_changes: Vec<SwiftChange>,
}

/// The runner reinstalling its LaunchAgent (protocol "Runner updates",
/// `reinstall`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reinstall {
    /// waiting (about to start), running, staged (in place, starting
    /// when the Mac restarts) or failed.
    pub state: String,
    pub reason: Option<String>,
    pub log_file: Option<String>,
    /// It does it by itself, not because Update it was pressed.
    pub auto: bool,
}

impl Reinstall {
    pub fn decode(v: &Value) -> Option<Reinstall> {
        let state = v["state"].as_str()?.to_owned();
        Some(Reinstall {
            state,
            reason: text(v, "reason"),
            log_file: text(v, "logFile"),
            auto: v["auto"].as_bool().unwrap_or(false),
        })
    }
}

/// One of someone's own commits to the old Swift app.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SwiftChange {
    pub commit: String,
    pub short: String,
    pub subject: String,
    /// The committer's date, ISO.
    pub date: String,
    pub files: Vec<String>,
    pub more_files: i64,
    /// An open thread rebuilding it.
    pub thread_id: Option<String>,
}

impl SwiftChange {
    fn decode(v: &Value) -> Option<SwiftChange> {
        let commit = v["commit"].as_str().filter(|c| !c.is_empty())?.to_owned();
        Some(SwiftChange {
            short: v["short"]
                .as_str()
                .map_or_else(|| commit.chars().take(7).collect(), str::to_owned),
            commit,
            subject: v["subject"].as_str().unwrap_or("").to_owned(),
            date: v["date"].as_str().unwrap_or("").to_owned(),
            files: strings(&v["files"]),
            more_files: v["moreFiles"].as_i64().unwrap_or(0),
            thread_id: text(v, "threadId").filter(|t| !t.is_empty()),
        })
    }
}

/// The "Not in the new app yet" section's line above its list.
pub fn swift_changes_line(n: usize) -> String {
    if n == 1 {
        "You changed the old app in 1 place that isn't in this one yet. Port it to rebuild it here, or dismiss it.".to_owned()
    } else {
        format!("You changed the old app in {n} places that aren't in this one yet. Port each to rebuild it here, or dismiss it.")
    }
}

/// Under a change's subject: its day, short commit and files.
pub fn swift_change_detail(c: &SwiftChange) -> String {
    // The day where they made it, from the date's own offset.
    let day = DateTime::parse_from_rfc3339(&c.date)
        .ok()
        .map(|d| d.format("%-d %b").to_string());
    let mut files = c
        .files
        .iter()
        .map(|f| f.rsplit('/').next().unwrap_or(f).to_owned())
        .collect::<Vec<_>>();
    if files.len() > 3 {
        let more = files.len() as i64 - 3 + c.more_files;
        files.truncate(3);
        files.push(format!("{more} more"));
    } else if c.more_files > 0 {
        files.push(format!("{} more", c.more_files));
    }
    let mut parts = day.into_iter().collect::<Vec<_>>();
    parts.push(c.short.clone());
    if !files.is_empty() {
        parts.push(files.join(", "));
    }
    parts.join(" · ")
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OldRunner {
    pub version: String,
    pub threads: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BehindRunner {
    pub name: String,
    pub problem: String,
}

/// Mike's releases, for a fork (protocol "Mike's releases").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Upstream {
    /// off, idle, checking, available or failed.
    pub state: String,
    pub reason: Option<String>,
    /// The repo it looks at, where a bring-in thread starts.
    pub checkout: Option<String>,
    pub release: Option<Release>,
    /// Mike's own runner: the last release tag it made.
    pub published_tag: Option<String>,
    /// Mike's own runner: why today's release is waiting on GitHub's checks.
    pub held_why: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Release {
    /// "release/2026-10-30".
    pub tag: String,
    /// When it was tagged (ISO), for its day where the reader is
    /// (`release_day`). Absent from older runners.
    pub date: Option<String>,
    /// The commit the verified tag names: what Bring Them In merges, rather
    /// than a ref name a later fetch could move.
    pub commit: Option<String>,
    pub changes: i64,
    pub subjects: Vec<String>,
    /// Each verified release main doesn't have yet, newest first.
    pub notes: Vec<Notes>,
    /// Why each commit Mike marked `Important:` matters, once each.
    pub important: Vec<String>,
    /// The What's new page's cards for those releases (protocol "Mike's
    /// releases", `changelog`), when the runner could read them.
    pub changelog: Option<Changelog>,
}

/// The What's new page's cards for the releases main doesn't have.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changelog {
    /// The whole page, for See all.
    pub page: String,
    pub releases: Vec<ChangelogRelease>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChangelogRelease {
    pub tag: String,
    /// That release on the page, for its cards.
    pub link: String,
    pub cards: Vec<Card>,
    pub added: i64,
    pub changed: i64,
    pub fixed: i64,
}

/// One of a release's main changes, as the page shows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Card {
    /// added, changed or fixed.
    pub kind: String,
    pub title: String,
    pub text: String,
    /// The picture, or a clip's still, on the site.
    pub picture: String,
    pub clip: bool,
}

/// One verified release's notes, or its commit subjects as a fallback.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Notes {
    pub tag: String,
    /// When that release was tagged (ISO), as on `Release`.
    pub date: Option<String>,
    pub lines: Vec<String>,
}

impl RunnerUpdates {
    /// Read leniently, as the Swift decoder does; None when there's nothing
    /// there (an older runner).
    pub fn decode(v: &Value) -> Option<RunnerUpdates> {
        if !v.is_object() {
            return None;
        }
        Some(RunnerUpdates {
            state: v["state"].as_str().unwrap_or("idle").to_owned(),
            commit: text(v, "commit"),
            subject: text(v, "subject"),
            reason: text(v, "reason"),
            old_runners: v["oldRunners"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|o| o.is_object())
                .map(|o| OldRunner {
                    version: o["version"].as_str().unwrap_or("?").to_owned(),
                    threads: strings(&o["threads"]),
                })
                .collect(),
            launcher_changed: v["launcherChanged"].as_bool().unwrap_or(false),
            launcher_reason: text(v, "launcherReason"),
            reinstall: Reinstall::decode(&v["reinstall"]),
            launcher_stages: v["launcherStages"].as_bool().unwrap_or(false),
            upstream: Upstream::decode(&v["upstream"]),
            follow_problem: text(v, "followProblem"),
            web_runtime_problem: text(v, "webRuntimeProblem"),
            web_runtime_note: text(v, "webRuntimeNote"),
            behind_runners: v["behindRunners"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| {
                    Some(BehindRunner {
                        name: b["name"].as_str()?.to_owned(),
                        problem: b["problem"].as_str()?.to_owned(),
                    })
                })
                .collect(),
            swift_changes: v["swiftChanges"]["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(SwiftChange::decode)
                .collect(),
        })
    }

    /// Something's on its way: a release being built or about to start, an
    /// old runner still finishing turns, or a LaunchAgent to reinstall.
    pub fn is_pending(&self) -> bool {
        // A staged launcher (protocol "Runner updates") has nothing left
        // to do until the Mac restarts, so it isn't on its way.
        let staged = self.reinstall.as_ref().is_some_and(|r| r.state == "staged");
        self.state == "building"
            || self.state == "waiting"
            || !self.old_runners.is_empty()
            || (self.launcher_changed && !staged)
    }

    pub fn failed(&self) -> bool {
        self.state == "failed"
    }
}

impl Upstream {
    fn decode(v: &Value) -> Option<Upstream> {
        if !v.is_object() {
            return None;
        }
        Some(Upstream {
            state: v["state"].as_str().unwrap_or("off").to_owned(),
            reason: text(v, "reason"),
            checkout: text(v, "checkout"),
            release: Release::decode(&v["release"]),
            published_tag: v["published"]["tag"].as_str().map(str::to_owned),
            held_why: v["held"]["why"].as_str().map(str::to_owned),
        })
    }

    /// A newer release than main has, to bring in.
    pub fn available(&self) -> bool {
        self.state == "available" && self.release.as_ref().is_some_and(|r| r.changes > 0)
    }
}

impl Release {
    fn decode(v: &Value) -> Option<Release> {
        if !v.is_object() {
            return None;
        }
        Some(Release {
            tag: v["tag"].as_str().unwrap_or("?").to_owned(),
            date: text(v, "date"),
            commit: text(v, "commit"),
            changes: v["changes"]
                .as_i64()
                .or_else(|| {
                    v["changes"]
                        .as_f64()
                        .filter(|n| n.fract() == 0.)
                        .map(|n| n as i64)
                })
                .unwrap_or(0),
            subjects: strings(&v["subjects"]),
            notes: v["notes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| {
                    Some(Notes {
                        tag: n["tag"].as_str()?.to_owned(),
                        date: text(n, "date"),
                        lines: n["lines"].as_array().map(|_| strings(&n["lines"]))?,
                    })
                })
                .filter(|n| !n.lines.is_empty())
                .collect(),
            important: {
                let mut whys: Vec<String> = Vec::new();
                for why in v["important"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|i| i["why"].as_str())
                {
                    if !whys.iter().any(|w| w == why) {
                        whys.push(why.to_owned());
                    }
                }
                whys
            },
            changelog: Changelog::decode(&v["changelog"]),
        })
    }
}

impl Changelog {
    fn decode(v: &Value) -> Option<Changelog> {
        let page = v["page"]
            .as_str()
            .filter(|p| p.starts_with("https://"))?
            .to_owned();
        let count = |r: &Value, k: &str| r[k].as_i64().unwrap_or(0).max(0);
        let releases: Vec<ChangelogRelease> = v["releases"]
            .as_array()?
            .iter()
            .filter_map(|r| {
                Some(ChangelogRelease {
                    tag: r["tag"].as_str()?.to_owned(),
                    link: r["link"]
                        .as_str()
                        .filter(|l| l.starts_with("https://"))
                        .unwrap_or(&page)
                        .to_owned(),
                    cards: r["highlights"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|h| {
                            Some(Card {
                                kind: h["kind"].as_str()?.to_owned(),
                                title: h["title"].as_str()?.to_owned(),
                                text: h["text"].as_str().unwrap_or_default().to_owned(),
                                picture: h["picture"]
                                    .as_str()
                                    .filter(|p| p.starts_with("https://"))?
                                    .to_owned(),
                                clip: h["clip"].as_bool().unwrap_or(false),
                            })
                        })
                        .collect(),
                    added: count(r, "added"),
                    changed: count(r, "changed"),
                    fixed: count(r, "fixed"),
                })
            })
            .collect();
        (!releases.is_empty()).then_some(Changelog { page, releases })
    }
}

/// The app's side, as the Swift app's AppUpdater knows it: a build of main
/// staged, building, or failed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppSide {
    /// Short commit of the running build.
    pub running: Option<String>,
    /// Short commit waiting to be swapped in.
    pub staged: Option<String>,
    pub building: bool,
    /// Main changed recently; let nearby desktop changes settle first.
    pub settling: bool,
    /// How long that wait is (runner.json's `updateQuietMinutes`).
    pub quiet_minutes: u32,
    pub failed: bool,
    /// The GPUI app's build found no Mac to build on, and tries again at its
    /// next look (the Swift app builds where it is, so never).
    pub waiting: bool,
    /// Why the installed GPUI app can't follow main (one installed before it
    /// could, say). The Swift app has no such case.
    pub not_following: Option<String>,
    /// What the staged build's restart waits on (`restart_wait`), when the
    /// app knows: a countdown, or what's typed or open.
    pub wait: Option<crate::app_update::RestartWait>,
    /// Where the build is on its host, from stage-update.sh's phase file,
    /// while it's building or waiting for one: busy, queued or compiling.
    pub phase: Option<BuildPhase>,
}

/// Where the app's update build is on its build host, as stage-update.sh
/// writes it in its phase file (`<state> <host> <since> [<ahead>]`). On 20
/// Nov the ring turned for over an hour while the build sat behind other
/// threads' runs on Tinker Desk, and the panel only said it was building.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildPhase {
    pub state: BuildState,
    pub host: String,
    /// Whole minutes in this state.
    pub minutes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildState {
    /// Every trusted host was busy, so it tries again later.
    Busy,
    /// Waiting its turn on the host, with this many runs ahead of it.
    Queued { ahead: u32 },
    /// Compiling there.
    Building,
}

impl BuildPhase {
    /// The phase file's line, read at `now` (Unix seconds).
    pub fn parse(text: &str, now: u64) -> Option<Self> {
        let mut words = text.split_whitespace();
        let state = words.next()?;
        let host = words.next()?.to_owned();
        let since: u64 = words.next()?.parse().ok()?;
        let state = match state {
            "busy" => BuildState::Busy,
            "building" => BuildState::Building,
            "queued" => BuildState::Queued {
                ahead: words.next().and_then(|w| w.parse().ok()).unwrap_or(0),
            },
            _ => return None,
        };
        Some(Self {
            state,
            host,
            minutes: now.saturating_sub(since) / 60,
        })
    }
}

fn minutes(n: u64) -> String {
    if n == 1 {
        "1 minute".to_owned()
    } else {
        format!("{n} minutes")
    }
}

impl AppSide {
    pub fn is_pending(&self) -> bool {
        self.staged.is_some() || self.building || self.waiting || self.settling
    }
}

fn runner_pending(runner: Option<&RunnerUpdates>) -> bool {
    runner.is_some_and(RunnerUpdates::is_pending)
}

fn runner_failed(runner: Option<&RunnerUpdates>) -> bool {
    runner.is_some_and(RunnerUpdates::failed)
}

/// Something on its way, or something that went wrong, for the app or the
/// runner: the icon's grey dot. The icon itself is always there since the
/// CLIs' versions moved into its panel (28 Oct).
pub fn shown(app: &AppSide, runner: Option<&RunnerUpdates>) -> bool {
    app.is_pending()
        || app.failed
        || app.not_following.is_some()
        || runner_pending(runner)
        || runner_failed(runner)
        || from_mike(runner)
        || not_following(runner)
        || runner.is_some_and(|r| r.web_runtime_problem.is_some())
}

/// A release of Mike's this copy's main doesn't have yet.
pub fn from_mike(runner: Option<&RunnerUpdates>) -> bool {
    runner
        .and_then(|r| r.upstream.as_ref())
        .is_some_and(Upstream::available)
}

/// A CLI with a new version, held back, updating, or whose update failed:
/// also a grey dot, and a line in the tooltip.
pub fn cli_pending(cli: &CliStatus) -> bool {
    matches!(cli.status.as_str(), "behind" | "held" | "missing")
        || cli
            .update
            .as_ref()
            .is_some_and(|u| matches!(u.state.as_str(), "waiting" | "running" | "failed"))
}

/// The tooltip's line for a Threadbear Runner.app (or launch.mjs) that only
/// a reinstall brings up to date, by what's being done about it.
pub fn reinstall_tooltip(u: &RunnerUpdates) -> &'static str {
    match u.reinstall.as_ref().map(|r| r.state.as_str()) {
        None => "The runner needs updating",
        Some("failed") => "The runner's update didn't work",
        Some("staged") => "The runner updates when your Mac restarts",
        _ => "The runner is updating",
    }
}

/// A LaunchAgent behind main that waits on Mike: nobody has pressed
/// Reinstall now (and the runner won't by itself), or the reinstall failed.
pub fn launcher_needs_you(u: &RunnerUpdates) -> bool {
    u.launcher_changed && u.reinstall.as_ref().is_none_or(|r| r.state == "failed")
}

/// The icon's tooltip: "Updates", then a line for each thing going on, or
/// that everything is up to date. The panel has the rest.
pub fn icon_tooltip(app: &AppSide, runner: Option<&RunnerUpdates>, clis: &[CliStatus]) -> String {
    let mut lines = vec!["Updates".to_owned()];
    lines.extend(runner.and_then(|r| r.web_runtime_problem.clone()));
    // A runner app to reinstall gets its own line, as it can be Mike's to
    // do (the accent dot); left in, it read as "A runner update", which
    // looks like one on its way by itself (12 Nov, Mike: "I thought blue
    // dots reserved for something that needs me to action on it").
    let moving = runner.map(|r| RunnerUpdates {
        launcher_changed: false,
        ..r.clone()
    });
    let moving = moving.as_ref();
    if app.is_pending() || app.failed || runner_pending(moving) || runner_failed(moving) {
        lines.push(tooltip(app, moving));
    }
    if let Some(r) = runner.filter(|r| r.launcher_changed) {
        lines.push(reinstall_tooltip(r).to_owned());
    }
    if let Some(line) = upstream_tooltip(runner.and_then(|r| r.upstream.as_ref())) {
        lines.push(line);
    }
    if app.not_following.is_some() {
        lines.push("The app isn't following main".to_owned());
    }
    if not_following(runner) {
        lines.push("A runner isn't following GitHub's main".to_owned());
    }
    for cli in clis.iter().filter(|c| cli_pending(c)) {
        lines.push(banner_text(cli).unwrap_or_else(|| status_line(cli)));
    }
    if lines.len() == 1 {
        lines.push("Everything is up to date".to_owned());
    }
    lines.join("\n")
}

/// Whether it wants Mike (the accent dot): a launch.mjs to reinstall that
/// waits on his Reinstall now, or whose reinstall failed,
/// a release of his to bring in (they only come in when he says), a
/// machine that isn't following GitHub's main, or an installed GPUI app that
/// can't follow main until it's installed again. Anything else sorts itself
/// out, a failed build included, so it gets the grey dot (27 Oct, Mike: "the
/// blue dot usually indicates there's something for me to action").
pub fn needs_you(app: &AppSide, runner: Option<&RunnerUpdates>) -> bool {
    app.not_following.is_some()
        || runner.is_some_and(launcher_needs_you)
        || from_mike(runner)
        || not_following(runner)
}

/// Where a thread's fix is, for the Updates panel's list of the threads
/// waiting on the app to restart onto what they landed. Mike checked the
/// panel before hibernating such threads, and a plain icon couldn't say
/// whether their fix was in yet; he picked this list over a line on the
/// thread's row or steps in the thread (review 0a7d18e2, 21 Nov).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixPlace {
    /// The running app has it: the thread hears once the runner does.
    InApp,
    /// The staged build has it.
    Ready,
    /// The build under way has it.
    Building,
    /// None of them has it yet: it comes in a later build.
    Next,
    /// No commit to look for, or git couldn't tell.
    Unknown,
}

/// The app's builds, by commit, that a waiting thread's commit is looked
/// for in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct BuildCommits {
    pub running: Option<String>,
    pub staged: Option<String>,
    pub building: Option<String>,
}

/// Where `want` is, with `has(commit, build)` saying whether a build's
/// commit contains it (None when git can't tell). The newest build that
/// has it wins, as that's the soonest it's in front of Mike.
pub fn fix_place(
    want: Option<&str>,
    builds: &BuildCommits,
    has: impl Fn(&str, &str) -> Option<bool>,
) -> FixPlace {
    let Some(want) = want else {
        return FixPlace::Unknown;
    };
    let mut unsure = false;
    for (build, place) in [
        (&builds.running, FixPlace::InApp),
        (&builds.staged, FixPlace::Ready),
        (&builds.building, FixPlace::Building),
    ] {
        match build.as_deref().map(|b| has(want, b)) {
            Some(Some(true)) => return place,
            Some(None) => unsure = true,
            _ => {}
        }
    }
    if unsure {
        FixPlace::Unknown
    } else {
        FixPlace::Next
    }
}

/// A waiting thread's place, as its line in the panel says it.
pub fn fix_label(place: FixPlace, app: &AppSide) -> &'static str {
    match place {
        FixPlace::InApp => "In your app",
        FixPlace::Ready => "Ready",
        FixPlace::Building => "In this build",
        FixPlace::Next if app.staged.is_some() || app.building => {
            "Landed after it, in the next one"
        }
        FixPlace::Next => "In the next build",
        FixPlace::Unknown => "Waiting for the app",
    }
}

/// What the icon itself shows of the next version, so a glance says it
/// without opening the panel. Mike opened and shut Updates every 40 minutes
/// or so on 18 Nov to see whether a build had finished; he picked a ring
/// round the icon while one builds and the icon filled green once it's
/// ready (review d3ac73e3, 19 Nov).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NextVersion {
    /// Nothing on its way: the plain icon.
    None,
    /// The app's next version is building, or about to (waiting for main to
    /// settle or for a Mac to build on), or the runner is building a
    /// release: the ring turns.
    Coming,
    /// The app's next version is built and switches in when he's idle (or
    /// now, from the panel): the icon fills green.
    Ready,
}

pub fn next_version(app: &AppSide, runner: Option<&RunnerUpdates>) -> NextVersion {
    if app.staged.is_some() {
        NextVersion::Ready
    } else if app.building
        || app.settling
        || app.waiting
        || runner.is_some_and(|r| r.state == "building")
    {
        NextVersion::Coming
    } else {
        NextVersion::None
    }
}

/// The grey dot: what `shown` and the CLIs count, less what the icon
/// already shows as its ring or its green (`next_version`).
pub fn quiet_dot(app: &AppSide, runner: Option<&RunnerUpdates>, clis: &[CliStatus]) -> bool {
    let app = AppSide {
        staged: None,
        building: false,
        settling: false,
        waiting: false,
        ..app.clone()
    };
    let runner = runner.map(|r| RunnerUpdates {
        state: if r.state == "building" {
            "idle".to_owned()
        } else {
            r.state.clone()
        },
        ..r.clone()
    });
    shown(&app, runner.as_ref()) || clis.iter().any(cli_pending)
}

/// A machine that isn't following GitHub's main: nothing fixes that by
/// itself, and bruce sat three days behind unnoticed (9 Nov).
fn not_following(runner: Option<&RunnerUpdates>) -> bool {
    runner.is_some_and(|u| u.follow_problem.is_some() || !u.behind_runners.is_empty())
}

/// One line for each machine that isn't following GitHub's main.
pub fn follow_lines(u: &RunnerUpdates) -> Vec<String> {
    let mut lines: Vec<String> = u
        .follow_problem
        .iter()
        .map(|p| format!("This runner isn't following GitHub's main properly: {p}"))
        .collect();
    lines.extend(u.behind_runners.iter().map(|b| {
        format!(
            "{} isn't following GitHub's main properly: {}",
            b.name, b.problem
        )
    }));
    lines
}

fn changes_words(n: i64, suffix: &str) -> String {
    if n == 1 {
        format!("1 new change{suffix}")
    } else {
        format!("{n} new changes{suffix}")
    }
}

/// "12 new changes from Mike", for the icon's tooltip.
pub fn upstream_tooltip(u: Option<&Upstream>) -> Option<String> {
    let u = u.filter(|u| u.available())?;
    Some(changes_words(u.release.as_ref()?.changes, " from Mike"))
}

/// The panel's From Mike section: what's new, that it's up to date, or why
/// it can't tell. None when there's nothing to say.
pub fn upstream_line(u: Option<&Upstream>) -> Option<String> {
    let u = u?;
    // Held comes first: it's the one that wants something doing (a red
    // build on main), and the last tag is still in tb status.
    if let (Some(why), "off") = (&u.held_why, u.state.as_str()) {
        return Some(format!(
            "Your next release for everyone else is waiting: {why}."
        ));
    }
    if let (Some(tag), "off") = (&u.published_tag, u.state.as_str()) {
        return Some(format!("Your last release for everyone else is {tag}."));
    }
    match u.state.as_str() {
        "available" => {
            let r = u.release.as_ref()?;
            Some(format!(
                "Mike's release of {} has {}.",
                release_day(&r.tag, r.date.as_deref()),
                changes_words(r.changes, "")
            ))
        }
        "idle" => Some(u.release.as_ref().map_or_else(
            || "Mike hasn't made a release yet.".to_owned(),
            |r| {
                format!(
                    "You're up to date with Mike's release of {}.",
                    release_day(&r.tag, r.date.as_deref())
                )
            },
        )),
        "checking" => Some("Checking for Mike's releases.".to_owned()),
        "failed" => Some(format!(
            "Couldn't check for Mike's releases{}",
            u.reason
                .as_ref()
                .map_or_else(|| ".".to_owned(), |r| format!(": {r}"))
        )),
        _ => None,
    }
}

/// What the From Mike section lists under a release: the plain-words notes
/// Mike's runner wrote, a heading per release when there's more than one, or
/// (from older tags) the first commit subjects.
/// How many of the page's cards the From Mike section shows; See all has the rest.
pub const DIGEST_CARDS: usize = 4;

/// What the From Mike section shows when the What's new page has the
/// releases main doesn't (Mike picked it on 17 Nov 2026 over the notes as
/// text): their cards, newest first, with each one's link; how many
/// changes there are of each kind, the cards' and the plain lines'; the
/// Important whys; and the notes of any release the page has no entry for
/// yet, dated, as `release_lines` gives them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Digest {
    pub cards: Vec<(Card, String)>,
    pub more: usize,
    pub added: i64,
    pub changed: i64,
    pub fixed: i64,
    pub important: Vec<String>,
    pub page: String,
    pub notes: Vec<(Option<String>, Vec<String>)>,
}

/// None when there's no page to show from: the section lists the notes.
pub fn release_digest(r: &Release) -> Option<Digest> {
    let c = r.changelog.as_ref()?;
    let mut d = Digest {
        important: r.important.clone(),
        page: c.page.clone(),
        ..Default::default()
    };
    let mut cards = Vec::new();
    for rel in &c.releases {
        for card in &rel.cards {
            match card.kind.as_str() {
                "added" => d.added += 1,
                "changed" => d.changed += 1,
                _ => d.fixed += 1,
            }
            cards.push((card.clone(), rel.link.clone()));
        }
        d.added += rel.added;
        d.changed += rel.changed;
        d.fixed += rel.fixed;
    }
    d.more = cards.len().saturating_sub(DIGEST_CARDS);
    cards.truncate(DIGEST_CARDS);
    d.cards = cards;
    d.notes = r
        .notes
        .iter()
        .filter(|n| !c.releases.iter().any(|rel| rel.tag == n.tag))
        .map(|n| {
            (
                Some(release_day(&n.tag, n.date.as_deref())),
                n.lines.clone(),
            )
        })
        .collect();
    Some(d)
}

/// "5 added, 23 changed, 14 fixed", leaving out a kind there's none of.
pub fn digest_counts(d: &Digest) -> String {
    [
        (d.added, "added"),
        (d.changed, "changed"),
        (d.fixed, "fixed"),
    ]
    .iter()
    .filter(|(n, _)| *n > 0)
    .map(|(n, k)| format!("{n} {k}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// The Important line's tip: each why on its own line, starting with a
/// capital (the tag says "Important: the phone pairing...").
pub fn important_tip(whys: &[String]) -> String {
    whys.iter()
        .map(|w| {
            let mut c = w.chars();
            let first = c
                .next()
                .map(|f| f.to_uppercase().collect::<String>())
                .unwrap_or_default();
            format!("• {first}{}", c.as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// "3 important fixes", for a line whose tip lists them.
pub fn important_line(n: usize) -> Option<String> {
    (n > 0).then(|| {
        if n == 1 {
            "1 important fix".to_owned()
        } else {
            format!("{n} important fixes")
        }
    })
}

pub fn release_lines(r: &Release) -> Vec<(Option<String>, Vec<String>)> {
    let first_subjects = || r.subjects.iter().take(5).cloned().collect::<Vec<_>>();
    if r.notes.is_empty() {
        return vec![(None, first_subjects())];
    }
    if r.notes.len() == 1 && r.notes[0].tag == r.tag {
        return vec![(None, r.notes[0].lines.clone())];
    }
    let mut groups: Vec<(Option<String>, Vec<String>)> = r
        .notes
        .iter()
        .map(|note| {
            (
                Some(release_day(&note.tag, note.date.as_deref())),
                note.lines.clone(),
            )
        })
        .collect();
    // An older runner may supply notes only for older tags. Keep those
    // dated, and show the subjects so the newest changes remain visible.
    if !r.notes.iter().any(|n| n.tag == r.tag) && !r.subjects.is_empty() {
        groups.push((Some("Every change".to_owned()), first_subjects()));
    }
    groups
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A release's day where the reader is, "30 Oct": from when it was tagged.
/// The tag's name is the day on Mike's runner, in Perth, so a release he
/// made on his morning was "tomorrow" all afternoon in California (Wayne,
/// 14 Nov 2026). The name is only the fallback, for an older runner that
/// sends no date.
pub fn release_day(tag: &str, date: Option<&str>) -> String {
    release_day_in(tag, date, &chrono::Local)
}

fn release_day_in<Tz: TimeZone>(tag: &str, date: Option<&str>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if let Some(at) = date.and_then(|d| DateTime::parse_from_rfc3339(d).ok()) {
        return at.with_timezone(tz).format("%-d %b").to_string();
    }
    let name = tag.strip_prefix("release/").unwrap_or(tag);
    let parts: Vec<i64> = name
        .split('-')
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    match parts.as_slice() {
        [_, month @ 1..=12, day] => format!("{day} {}", MONTHS[(*month - 1) as usize]),
        _ => tag.to_owned(),
    }
}

/// The commit the runner checked the release's signature for, so the thread
/// merges that and not a ref a later fetch could have moved.
fn commit_line(r: &Release, merge: bool) -> String {
    let Some(c) = r.commit.as_deref().filter(|c| {
        (c.len() == 40 || c.len() == 64)
            && c.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) else {
        return String::new();
    };
    if merge {
        format!(" Merge its commit {c}, the one its signature was checked for.")
    } else {
        format!(" Its commit is {c}, the one its signature was checked for.")
    }
}

fn plural(n: i64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// The first message of the thread Bring Them In starts.
pub fn bring_in_prompt(r: &Release) -> String {
    format!(
        "Bring in Mike's release {} ({} new change{}) to this copy of Threadbear.{} Follow docs/bringing-in-updates.md, and ask me before it lands.",
        r.tag,
        r.changes,
        plural(r.changes),
        commit_line(r, true)
    )
}

/// Let's Discuss: the same release, talked through before anything changes
/// (Mike, 4 Nov 2026), for someone who wants to know what it does to their
/// own changes first.
pub fn discuss_prompt(r: &Release) -> String {
    format!(
        "Mike's release {} has {} new change{} for this copy of Threadbear. Before bringing any of it in, talk me through it: what's in it that I'd notice, anything that touches or clashes with the changes I've made in this copy, and anything risky. Section 1 of docs/bringing-in-updates.md says how to see both sides.{} Don't change anything yet; once we've talked it over, I'll say whether to bring it in, and then follow that doc.",
        r.tag,
        r.changes,
        plural(r.changes),
        commit_line(r, false)
    )
}

/// The thread's title: "Bring in Mike's release of 6 Nov", or "Discuss ...".
pub fn bring_in_title(r: &Release, discuss: bool) -> String {
    format!(
        "{} Mike's release of {}",
        if discuss { "Discuss" } else { "Bring in" },
        release_day(&r.tag, r.date.as_deref())
    )
}

/// The icon's tooltip line about the app and the runner. A failure is said,
/// as it shares the grey dot with an update on its way.
pub fn tooltip(app: &AppSide, runner: Option<&RunnerUpdates>) -> String {
    let app_part = app.is_pending() || app.failed;
    let runner_part = runner_pending(runner) || runner_failed(runner);
    let app_failed = app.failed && !app.is_pending();
    let runner_failed_only = runner_failed(runner) && !runner_pending(runner);
    if app_failed && runner_failed_only {
        return "The app's and the runner's updates failed".to_owned();
    }
    if app_failed && !runner_part {
        return "The app's update failed".to_owned();
    }
    if runner_failed_only && !app_part {
        return "The runner's update failed".to_owned();
    }
    match (app_part, runner_part) {
        (true, true) => "Updates for the app and the runner",
        (true, false) => "An app update",
        (false, true) => "A runner update",
        _ => "Updates",
    }
    .to_owned()
}

/// "two quiet minutes", "a quiet minute", "15 quiet minutes".
fn quiet_wait(minutes: u32) -> String {
    const WORDS: [&str; 11] = [
        "no", "a", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    ];
    match minutes {
        0 => "main to settle".to_owned(),
        1 => "a quiet minute".to_owned(),
        n if n <= 10 => format!("{} quiet minutes", WORDS[n as usize]),
        n => format!("{n} quiet minutes"),
    }
}

pub fn app_line(a: &AppSide) -> String {
    if let Some(staged) = &a.staged {
        use crate::app_update::RestartWait;
        return match &a.wait {
            Some(RestartWait::Countdown(n)) => format!("The app's next version ({staged}) is ready. It switches in {n}s if you leave the app alone, or now."),
            Some(RestartWait::Held(why)) => format!("The app's next version ({staged}) is ready. It switches in once {why}, or now."),
            None => format!("The app's next version ({staged}) is ready. It switches in when you're not using the app, or now."),
        };
    }
    if a.building || a.waiting {
        if let Some(p) = &a.phase {
            let (host, so_far) = (&p.host, minutes(p.minutes));
            match p.state {
                BuildState::Building if a.building => {
                    return format!("Building the app from main on {host}, {so_far} in.");
                }
                BuildState::Queued { ahead } if a.building => {
                    return match ahead {
                        0 => format!("The app's next version is queued on {host}, waiting for what it's running to finish ({so_far} so far)."),
                        1 => format!("The app's next version is queued on {host} behind 1 other run ({so_far} so far)."),
                        n => format!("The app's next version is queued on {host} behind {n} other runs ({so_far} so far)."),
                    };
                }
                BuildState::Busy if a.waiting => {
                    return format!("The app has a new version on main, waiting for {host}, which has been busy with other work for {so_far}.");
                }
                _ => {}
            }
        }
    }
    if a.building {
        return "Building the app from main.".to_owned();
    }
    if a.waiting {
        return "The app has a new version on main, waiting for a Mac to build it on.".to_owned();
    }
    if a.settling {
        return format!(
            "The app has a new version on main, waiting for {} before building.",
            quiet_wait(a.quiet_minutes)
        );
    }
    if a.failed {
        return "The app's last build from main failed. The log says why.".to_owned();
    }
    if let Some(why) = &a.not_following {
        return format!("The app isn't following main: {why}.");
    }
    a.running.as_ref().map_or_else(
        || "The app is up to date.".to_owned(),
        |r| format!("The app is up to date ({r})."),
    )
}

/// The Updates icon's right-click popover, in a line (`popoverLine`).
pub fn popover_line(a: &AppSide) -> String {
    if a.staged.is_some() {
        return "A new version of the app is ready.".to_owned();
    }
    if a.building
        && a.phase
            .as_ref()
            .is_some_and(|p| matches!(p.state, BuildState::Queued { .. }))
    {
        return "The app's next version is queued behind other work.".to_owned();
    }
    if a.building {
        return "Building the app's next version.".to_owned();
    }
    if a.failed {
        return "The app's last build failed.".to_owned();
    }
    app_line(a)
}

/// The runner's own build: building, built and starting, or failed.
pub fn build_line(u: &RunnerUpdates) -> Option<String> {
    let at = u
        .commit
        .as_ref()
        .map_or_else(String::new, |c| format!(" at {c}"));
    let what = u
        .subject
        .as_ref()
        .map_or_else(String::new, |s| format!(": {s}"));
    match u.state.as_str() {
        "building" => Some(format!("Building the runner from main{at}{what}.")),
        "waiting" => Some(format!("The runner from main{at} is built and starting.")),
        "failed" => Some(format!(
            "The runner couldn't update to main{at}{}",
            u.reason
                .as_ref()
                .map_or_else(|| ".".to_owned(), |r| format!(": {r}"))
        )),
        _ => None,
    }
}

/// Threads still finishing on an old runner; the view links each one under it.
pub fn old_runners_line(u: &RunnerUpdates) -> Option<String> {
    let threads: usize = u.old_runners.iter().map(|o| o.threads.len()).sum();
    match threads {
        0 => None,
        1 => Some("1 thread is finishing its turn on the previous version. It moves to the new one when the turn ends.".to_owned()),
        n => Some(format!("{n} threads are finishing their turns on the previous version. Each moves to the new one when its turn ends.")),
    }
}

/// A LaunchAgent only an update outside releases brings up to date (launch.mjs, the plist,
/// Threadbear Runner.app), and what's being done about it; the view puts
/// `launcher_button` under it. An older runner sends no reason, and then
/// it was launch.mjs.
pub fn launcher_line(u: &RunnerUpdates) -> Option<String> {
    if !u.launcher_changed {
        return None;
    }
    let why = u
        .launcher_reason
        .as_deref()
        .unwrap_or("launch.mjs has changed on main.");
    if !u.launcher_stages {
        return Some(match u.reinstall.as_ref() {
            Some(r) if r.state == "failed" => format!(
                "The runner's update didn't work: {}",
                r.reason.as_deref().unwrap_or("it didn't say why.")
            ),
            _ => format!("{why} It's updated once the runner itself is, a few minutes after main."),
        });
    }
    // It's staged, not reinstalled (runner/src/reinstall.ts): nothing
    // stops, and the new one takes over when launchd next starts the job.
    Some(match u.reinstall.as_ref().map(|r| (r.state.as_str(), r)) {
        None => format!("{why} Updating it stops nothing; the new one starts next time your Mac restarts."),
        Some(("failed", r)) => format!("The runner's update didn't work: {}", r.reason.as_deref().unwrap_or("it didn't say why.")),
        Some(("staged", _)) => format!("{why} The update is in place, and starts next time your Mac restarts."),
        Some(_) => "Updating Threadbear Runner. Nothing stops; the new one starts next time your Mac restarts.".to_owned(),
    })
}

/// The button under `launcher_line`: its label and tip, and whether it
/// spins (taking no clicks) because the reinstall is already on its way.
/// None while the runner will do it by itself anyway.
pub fn launcher_button(u: &RunnerUpdates) -> Option<(&'static str, &'static str, bool)> {
    // An older runner's runner.reinstall stops everything once idle, which
    // the button's words don't promise.
    if !u.launcher_changed || !u.launcher_stages {
        return None;
    }
    match u.reinstall.as_ref().map(|r| r.state.as_str()) {
        None => Some(("Update it", "Put the new Threadbear Runner in place. Nothing stops; it starts next time your Mac restarts.", false)),
        Some("failed") => Some(("Try again", "Run the update again", false)),
        Some("staged") => None,
        Some(_) => Some(("Updating", "Threadbear Runner is updating", true)),
    }
}

/// Every runner line in order, or the one that says there's nothing.
pub fn runner_lines(u: Option<&RunnerUpdates>) -> Vec<String> {
    let Some(u) = u else {
        return vec!["This runner doesn't say how its updates are going.".to_owned()];
    };
    let mut out: Vec<String> = [build_line(u), old_runners_line(u), launcher_line(u)]
        .into_iter()
        .flatten()
        .collect();
    out.extend(follow_lines(u));
    out.extend(u.web_runtime_problem.clone());
    out.extend(u.web_runtime_note.clone());
    if out.is_empty() {
        out.push("The runner is up to date.".to_owned());
    }
    out
}

// ---- The CLIs (`clis.list`, `CliText`)

/// One agent CLI (`CliStatus`): its version, whether there's a newer one, and
/// the update it's doing or did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CliStatus {
    pub provider: String,
    /// Display name from hello.providers, filled by the client.
    pub name: Option<String>,
    pub path: String,
    /// "threadbear" (Codex's own copies), "cli" (Claude's installer) or
    /// "none" (a path set by hand, never updated).
    pub managed_by: String,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    /// current, behind, held, unknown or missing.
    pub status: String,
    /// auto, notify or off.
    pub policy: String,
    /// Codex: the kept version Go back returns to.
    pub previous_version: Option<String>,
    /// An agent with no version feed: Update is offered at any time.
    pub can_update_now: bool,
    pub checked_ms: Option<i64>,
    pub hold: Option<Hold>,
    pub update: Option<CliUpdate>,
}

/// Why an update wasn't installed by itself.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Hold {
    pub version: String,
    pub reason: String,
    pub missing: Vec<String>,
    /// The thread the runner started to look into a protocol hold.
    pub thread_id: Option<String>,
    /// That thread is still open: the row says it's being looked into.
    pub investigating: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CliUpdate {
    /// waiting, running, succeeded, unchanged or failed.
    pub state: String,
    pub target_version: Option<String>,
    pub waiting_for: Vec<String>,
    pub finished_ms: Option<i64>,
    pub message: Option<String>,
}

impl CliStatus {
    pub fn decode(v: &Value) -> Option<CliStatus> {
        let provider = v["provider"].as_str()?.to_owned();
        Some(CliStatus {
            provider,
            name: None,
            path: v["path"].as_str().unwrap_or("").to_owned(),
            managed_by: v["managedBy"].as_str().unwrap_or("cli").to_owned(),
            installed_version: text(v, "installedVersion"),
            latest_version: text(v, "latestVersion"),
            status: v["status"].as_str().unwrap_or("unknown").to_owned(),
            policy: v["policy"].as_str().unwrap_or("auto").to_owned(),
            previous_version: text(v, "previousVersion"),
            can_update_now: v["canUpdateNow"].as_bool().unwrap_or(false),
            checked_ms: v["checkedAt"].as_str().and_then(parse_ms),
            hold: v["hold"].is_object().then(|| Hold {
                version: v["hold"]["version"].as_str().unwrap_or("").to_owned(),
                reason: v["hold"]["reason"].as_str().unwrap_or("").to_owned(),
                missing: strings(&v["hold"]["missing"]),
                thread_id: v["hold"]["threadId"].as_str().map(str::to_owned),
                investigating: v["hold"]["investigating"].as_bool().unwrap_or(false),
            }),
            update: v["update"].is_object().then(|| {
                let u = &v["update"];
                CliUpdate {
                    state: u["state"].as_str().unwrap_or("unknown").to_owned(),
                    target_version: text(u, "targetVersion"),
                    waiting_for: strings(&u["waitingFor"]),
                    finished_ms: u["finishedAt"].as_str().and_then(parse_ms),
                    message: text(u, "message"),
                }
            }),
        })
    }
}

/// `{ clis: CliStatus[] }`, as `clis.list`, `clis.updated` and the buttons'
/// answers have it, or hello's `clis`.
pub fn decode_clis(list: &Value) -> Vec<CliStatus> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(CliStatus::decode)
        .collect()
}

pub fn decode_clis_with(list: &Value, logins: &crate::logins::RunnerLogins) -> Vec<CliStatus> {
    let mut clis = decode_clis(list);
    for cli in &mut clis {
        cli.name = Some(logins.cli_name(&cli.provider));
    }
    clis
}

/// "Claude Code 2.1.311, up to date", "Claude Code 2.1.311, 2.1.312
/// available", "Codex 0.165.0 is held back because the app-server protocol
/// changed".
pub fn status_line(cli: &CliStatus) -> String {
    let name = cli.name.clone().unwrap_or_else(|| cli_name(&cli.provider));
    let installed = cli
        .installed_version
        .as_ref()
        .map_or_else(|| name.clone(), |v| format!("{name} {v}"));
    match cli.status.as_str() {
        "current" => format!("{installed}, up to date"),
        "behind" => format!(
            "{installed}{}",
            cli.latest_version.as_ref().map_or_else(
                || ", an update is available".to_owned(),
                |v| format!(", {v} available")
            )
        ),
        "held" => {
            let version = cli
                .hold
                .as_ref()
                .map(|h| h.version.clone())
                .or_else(|| cli.latest_version.clone())
                .unwrap_or_else(|| "The new version".to_owned());
            if is_investigated(cli) {
                return format!("{name} {version} is held back, investigating why");
            }
            let reason = cli.hold.as_ref().map_or("", |h| h.reason.as_str());
            format!(
                "{name} {version} is held back{}",
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(" because {reason}")
                }
            )
        }
        "missing" => format!("{name} isn't installed"),
        _ => installed,
    }
}

/// A held version a thread is looking into right now (the runner started it,
/// so Mike isn't left to guess whether "Update anyway" is safe).
pub fn is_investigated(cli: &CliStatus) -> bool {
    cli.status == "held"
        && cli
            .hold
            .as_ref()
            .is_some_and(|h| h.investigating && h.thread_id.is_some())
}

/// The thread on a held version, open or done, for a link to it.
pub fn hold_thread(cli: &CliStatus) -> Option<&str> {
    if cli.status != "held" {
        return None;
    }
    cli.hold.as_ref().and_then(|h| h.thread_id.as_deref())
}

/// Who keeps it up to date, when that isn't the usual: a path set by hand is
/// never updated, and an agent with no updater of its own (Antigravity)
/// can't be updated from here at all.
pub fn managed_line(cli: &CliStatus) -> Option<&'static str> {
    if cli.managed_by == "none" {
        return Some("Set by hand in runner.json, so Threadbear leaves it alone");
    }
    (!has_policy(cli) && !cli.can_update_now)
        .then_some("Has no updater, so install new versions yourself")
}

/// Whether its row offers "Updates: Automatic / Notify / Off". Only Claude
/// and Codex: the runner keeps that setting for nothing else, so on an ACP
/// agent the menu took a choice and changed nothing (Antigravity, 23 Nov
/// 2026).
pub fn has_policy(cli: &CliStatus) -> bool {
    matches!(cli.provider.as_str(), "claude" | "codex")
}

/// The update button's title, or None when there's nothing to install.
pub fn update_title(cli: &CliStatus) -> Option<&'static str> {
    if is_updating(cli) {
        return None;
    }
    // An agent with no version feed offers Update any time, except while
    // the runner says its last Update found nothing newer (`current`).
    if cli.can_update_now && cli.status != "current" {
        return Some("Update");
    }
    match cli.status.as_str() {
        "behind" => Some("Update"),
        "held" => Some("Update anyway"),
        _ => None,
    }
}

/// "Go back to 0.163.0", for Codex with a kept version. Not when the kept
/// version is the one held (Mike went back from it): the hold's "Update
/// anyway" already reinstalls it.
pub fn go_back_title(cli: &CliStatus) -> Option<String> {
    let previous = cli.previous_version.as_deref().filter(|p| !p.is_empty())?;
    if Some(previous) == cli.installed_version.as_deref()
        || is_updating(cli)
        || cli.hold.as_ref().is_some_and(|h| h.version == previous)
    {
        return None;
    }
    Some(format!("Go back to {previous}"))
}

pub fn is_updating(cli: &CliStatus) -> bool {
    cli.update
        .as_ref()
        .is_some_and(|u| u.state == "running" || u.state == "waiting")
}

/// While an update runs or after one failed: "Updating Claude Code to
/// 2.1.312", "Installing Codex 0.165.0".
pub fn banner_text(cli: &CliStatus) -> Option<String> {
    let update = cli.update.as_ref()?;
    let name = cli.name.clone().unwrap_or_else(|| cli_name(&cli.provider));
    let target = update
        .target_version
        .clone()
        .or_else(|| cli.latest_version.clone());
    let to = target
        .as_ref()
        .map_or_else(String::new, |t| format!(" to {t}"));
    match update.state.as_str() {
        "running" if cli.provider == "codex" => Some(format!(
            "Installing {name}{}",
            target
                .as_ref()
                .map_or_else(String::new, |t| format!(" {t}"))
        )),
        "running" => Some(format!("Updating {name}{to}")),
        "waiting" => Some(format!("Waiting to update {name}{to}")),
        "failed" => {
            let mut text = format!("Couldn't update {name}{to}");
            if let Some(message) = update.message.as_deref().filter(|m| !m.is_empty()) {
                text.push_str(": ");
                text.push_str(message);
            }
            Some(text)
        }
        _ => None,
    }
}

pub fn policy_title(policy: &str) -> String {
    match policy {
        "auto" => "Automatic".to_owned(),
        "notify" => "Ask me".to_owned(),
        "off" => "Off".to_owned(),
        other => other.to_owned(),
    }
}

pub const POLICIES: [&str; 3] = ["auto", "notify", "off"];

pub fn policy_symbol(policy: &str) -> &'static str {
    match policy {
        "auto" => "arrow.triangle.2.circlepath",
        "notify" => "bell",
        _ => "nosign",
    }
}

/// "Checked at 9:40 am", "Checked Mon 9:40 am".
pub fn checked_line<Tz: TimeZone>(clis: &[CliStatus], now: &DateTime<Tz>) -> Option<String> {
    let at_ms = clis.iter().filter_map(|c| c.checked_ms).max()?;
    let checked = now.timezone().timestamp_millis_opt(at_ms).single()?;
    let clock = crate::new_thread::clock(&checked);
    if checked.date_naive() == now.date_naive() {
        return Some(format!("Checked at {clock}"));
    }
    let day = if checked.date_naive() == (now.clone() + Duration::days(1)).date_naive() {
        "tomorrow".to_owned()
    } else if checked.date_naive() == (now.clone() - Duration::days(1)).date_naive() {
        "yesterday".to_owned()
    } else {
        use chrono::Datelike as _;
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            [checked.weekday().num_days_from_sunday() as usize]
            .to_owned()
    };
    Some(format!("Checked {day} {clock}"))
}

/// The CLI's line as both apps' dumps give it (AppDump.usageLines): its
/// status, the policy, the buttons it has, and what an update is doing.
pub fn dump_line(cli: &CliStatus) -> String {
    let mut line = format!(
        "{} ({})",
        status_line(cli),
        policy_title(&cli.policy).to_lowercase()
    );
    if let Some(button) = update_title(cli) {
        line.push_str(&format!(" [{button}]"));
    }
    if let Some(back) = go_back_title(cli) {
        line.push_str(&format!(" [{back}]"));
    }
    if let (true, Some(text)) = (is_updating(cli), banner_text(cli)) {
        line.push_str(": ");
        line.push_str(&text);
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Local};
    use serde_json::json;

    #[test]
    fn swift_changes_from_a_fork() {
        let u = RunnerUpdates::decode(&json!({ "state": "idle", "swiftChanges": { "state": "ready", "checkout": "/Users/me/threadbear", "changes": [
            { "commit": "abc1234def", "short": "abc1234", "subject": "Orange dock badge", "date": "2026-11-02T03:00:00+08:00", "files": ["dock/Sources/Badge.swift"], "threadId": "t1" },
            { "commit": "0123456789", "subject": "Bigger sidebar font", "date": "2026-10-20T10:00:00Z", "files": ["app/A.swift", "app/B.swift", "app/C.swift", "app/D.swift"], "moreFiles": 2 },
            { "subject": "no commit" },
            "junk"
        ], "somethingNew": 1 } })).unwrap();
        assert_eq!(u.swift_changes.len(), 2);
        assert_eq!(u.swift_changes[0].thread_id.as_deref(), Some("t1"));
        assert_eq!(u.swift_changes[1].short, "0123456");
        assert_eq!(
            swift_change_detail(&u.swift_changes[0]),
            "2 Nov · abc1234 · Badge.swift"
        );
        assert_eq!(
            swift_change_detail(&u.swift_changes[1]),
            "20 Oct · 0123456 · A.swift, B.swift, C.swift, 3 more"
        );
        assert_eq!(swift_changes_line(1), "You changed the old app in 1 place that isn't in this one yet. Port it to rebuild it here, or dismiss it.");
        assert!(
            swift_changes_line(2).starts_with("You changed the old app in 2 places that aren't")
        );
        // Mike's own runner, or an older one, says nothing.
        assert!(RunnerUpdates::decode(&json!({ "state": "idle" }))
            .unwrap()
            .swift_changes
            .is_empty());
    }

    /// The mock runner's two CLIs (mock-runner/server.mjs).
    fn mock_clis() -> Vec<CliStatus> {
        decode_clis(&json!([
            { "provider": "claude", "path": "/x/claude", "managedBy": "cli", "installedVersion": "2.1.311", "latestVersion": "2.1.312", "status": "behind", "policy": "auto", "inUse": [], "checkedAt": "2026-11-11T01:00:00.000Z" },
            { "provider": "codex", "path": "/x/codex", "managedBy": "threadbear", "installedVersion": "0.164.0", "latestVersion": "0.165.0", "status": "held", "policy": "auto", "inUse": [], "previousVersion": "0.163.0",
              "checkedAt": "2026-11-11T01:00:00.000Z", "hold": { "version": "0.165.0", "reason": "the app-server protocol changed", "missing": ["thread/backgroundTerminals/list"] } },
            { "path": "no provider" },
        ]))
    }

    #[test]
    fn stale_web_runtime_is_visible_in_the_panel_and_updates_icon() {
        let u = RunnerUpdates::decode(
            &json!({ "state": "idle", "webRuntimeProblem": "CEF needs updating" }),
        )
        .unwrap();
        let app = AppSide::default();
        assert_eq!(runner_lines(Some(&u)), vec!["CEF needs updating"]);
        assert!(shown(&app, Some(&u)));
        assert!(icon_tooltip(&app, Some(&u), &[]).contains("CEF needs updating"));
        assert!(!needs_you(&app, Some(&u)));
    }

    #[test]
    fn a_web_runtime_waiting_on_cef_rs_is_only_a_panel_line() {
        let u = RunnerUpdates::decode(
            &json!({ "state": "idle", "webRuntimeNote": "Waiting on cef-rs" }),
        )
        .unwrap();
        let app = AppSide::default();
        assert_eq!(runner_lines(Some(&u)), vec!["Waiting on cef-rs"]);
        assert!(!shown(&app, Some(&u)));
        assert!(!icon_tooltip(&app, Some(&u), &[]).contains("Waiting on cef-rs"));
    }

    #[test]
    fn the_clis_say_what_they_have_and_what_they_offer() {
        let clis = mock_clis();
        assert_eq!(clis.len(), 2);
        assert_eq!(
            status_line(&clis[0]),
            "Claude Code 2.1.311, 2.1.312 available"
        );
        assert_eq!(update_title(&clis[0]), Some("Update"));
        assert_eq!(go_back_title(&clis[0]), None);
        assert_eq!(
            status_line(&clis[1]),
            "Codex 0.165.0 is held back because the app-server protocol changed"
        );
        assert_eq!(update_title(&clis[1]), Some("Update anyway"));
        assert_eq!(
            go_back_title(&clis[1]).as_deref(),
            Some("Go back to 0.163.0")
        );
        assert_eq!(
            clis[1].hold.as_ref().unwrap().missing,
            ["thread/backgroundTerminals/list"]
        );
        assert_eq!(
            dump_line(&clis[0]),
            "Claude Code 2.1.311, 2.1.312 available (automatic) [Update]"
        );
        assert_eq!(dump_line(&clis[1]), "Codex 0.165.0 is held back because the app-server protocol changed (automatic) [Update anyway] [Go back to 0.163.0]");
        assert!(clis.iter().all(cli_pending));
        let mut running = clis[0].clone();
        running.update = Some(CliUpdate {
            state: "running".into(),
            target_version: Some("2.1.312".into()),
            ..Default::default()
        });
        assert_eq!(
            update_title(&running),
            None,
            "nothing to press while it updates"
        );
        assert_eq!(
            dump_line(&running),
            "Claude Code 2.1.311, 2.1.312 available (automatic): Updating Claude Code to 2.1.312"
        );
        let mut codex = clis[1].clone();
        codex.update = Some(CliUpdate {
            state: "running".into(),
            target_version: Some("0.165.0".into()),
            ..Default::default()
        });
        assert_eq!(
            banner_text(&codex).as_deref(),
            Some("Installing Codex 0.165.0")
        );
        codex.update = Some(CliUpdate {
            state: "failed".into(),
            target_version: Some("0.165.0".into()),
            message: Some("0.165.0 is held back".into()),
            ..Default::default()
        });
        assert_eq!(
            banner_text(&codex).as_deref(),
            Some("Couldn't update Codex to 0.165.0: 0.165.0 is held back")
        );
        // A hold the runner started a thread on says so while it's open.
        let looked = decode_clis(
            &json!([{ "provider": "codex", "path": "/x/codex", "managedBy": "threadbear", "installedVersion": "0.170.0", "latestVersion": "0.171.0", "status": "held", "policy": "auto", "inUse": [],
            "hold": { "version": "0.171.0", "reason": "the app-server protocol changed", "missing": ["server request currentTime/read"], "threadId": "t1", "investigating": true } }]),
        );
        assert_eq!(
            status_line(&looked[0]),
            "Codex 0.171.0 is held back, investigating why"
        );
        assert_eq!(hold_thread(&looked[0]), Some("t1"));
        let mut done = looked[0].clone();
        done.hold.as_mut().unwrap().investigating = false;
        assert_eq!(
            status_line(&done),
            "Codex 0.171.0 is held back because the app-server protocol changed"
        );
        assert_eq!(hold_thread(&done), Some("t1"), "still links what it found");
        assert_eq!(hold_thread(&clis[1]), None);
        let current = CliStatus {
            status: "current".into(),
            ..clis[0].clone()
        };
        assert_eq!(status_line(&current), "Claude Code 2.1.311, up to date");
        assert!(!cli_pending(&current));
        assert_eq!(
            managed_line(&CliStatus {
                managed_by: "none".into(),
                ..current
            }),
            Some("Set by hand in runner.json, so Threadbear leaves it alone")
        );
    }

    #[test]
    fn an_agent_with_no_feed_hides_update_while_its_last_one_found_nothing() {
        let agent = CliStatus {
            provider: "opencode".into(),
            name: Some("OpenCode".into()),
            installed_version: Some("1.19.5".into()),
            status: "unknown".into(),
            policy: "off".into(),
            can_update_now: true,
            ..Default::default()
        };
        assert_eq!(status_line(&agent), "OpenCode 1.19.5");
        assert_eq!(update_title(&agent), Some("Update"));
        let checked = CliStatus {
            status: "current".into(),
            latest_version: Some("1.19.5".into()),
            update: Some(CliUpdate {
                state: "unchanged".into(),
                target_version: Some("1.19.5".into()),
                ..Default::default()
            }),
            ..agent
        };
        assert_eq!(status_line(&checked), "OpenCode 1.19.5, up to date");
        assert_eq!(update_title(&checked), None);
    }

    #[test]
    fn only_claude_and_codex_offer_an_update_setting() {
        let claude = CliStatus {
            provider: "claude".into(),
            policy: "auto".into(),
            ..Default::default()
        };
        assert!(has_policy(&claude));
        assert_eq!(managed_line(&claude), None);
        // OpenCode updates when asked, so its Update button is the control.
        let opencode = CliStatus {
            provider: "opencode".into(),
            policy: "off".into(),
            can_update_now: true,
            ..Default::default()
        };
        assert!(!has_policy(&opencode));
        assert_eq!(managed_line(&opencode), None);
        // Antigravity has no updater: no menu, and a line saying why.
        let antigravity = CliStatus {
            provider: "antigravity".into(),
            policy: "off".into(),
            ..Default::default()
        };
        assert!(!has_policy(&antigravity));
        assert_eq!(
            managed_line(&antigravity),
            Some("Has no updater, so install new versions yourself")
        );
    }

    #[test]
    fn the_popover_says_the_app_update_in_a_line() {
        let side = |staged: Option<&str>, building: bool, failed: bool| AppSide {
            running: Some("abc1234".into()),
            staged: staged.map(str::to_owned),
            building,
            failed,
            ..Default::default()
        };
        assert_eq!(
            popover_line(&side(Some("def5678"), true, false)),
            "A new version of the app is ready."
        );
        assert_eq!(
            popover_line(&side(None, true, false)),
            "Building the app's next version."
        );
        assert_eq!(
            popover_line(&side(None, false, true)),
            "The app's last build failed."
        );
        assert_eq!(
            popover_line(&side(None, false, false)),
            "The app is up to date (abc1234)."
        );
    }

    #[test]
    fn checked_says_the_time_or_the_day() {
        let zone = FixedOffset::east_opt(8 * 3600).unwrap();
        let clis = mock_clis();
        let now = zone
            .timestamp_millis_opt(parse_ms("2026-11-11T01:20:00.000Z").unwrap())
            .unwrap();
        assert_eq!(
            checked_line(&clis, &now).as_deref(),
            Some("Checked at 9 am")
        );
        let later = zone
            .timestamp_millis_opt(parse_ms("2026-11-12T01:20:00.000Z").unwrap())
            .unwrap();
        assert_eq!(
            checked_line(&clis, &later).as_deref(),
            Some("Checked yesterday 9 am")
        );
        let week = zone
            .timestamp_millis_opt(parse_ms("2026-11-14T01:20:00.000Z").unwrap())
            .unwrap();
        assert_eq!(
            checked_line(&clis, &week).as_deref(),
            Some("Checked Wed 9 am")
        );
        assert_eq!(checked_line(&[], &Local::now()), None);
    }

    #[test]
    fn the_icon_shows_the_next_version_without_a_click() {
        let app = |f: fn(&mut AppSide)| {
            let mut a = AppSide {
                running: Some("abc1234".into()),
                ..Default::default()
            };
            f(&mut a);
            a
        };
        let nothing = app(|_| {});
        assert_eq!(next_version(&nothing, None), NextVersion::None);
        assert!(!quiet_dot(&nothing, None, &[]));
        for coming in [
            app(|a| a.building = true),
            app(|a| a.settling = true),
            app(|a| a.waiting = true),
        ] {
            assert_eq!(next_version(&coming, None), NextVersion::Coming);
            assert!(
                !quiet_dot(&coming, None, &[]),
                "the ring says it, so no grey dot too"
            );
        }
        let runner = RunnerUpdates {
            state: "building".into(),
            ..Default::default()
        };
        assert_eq!(next_version(&nothing, Some(&runner)), NextVersion::Coming);
        assert!(!quiet_dot(&nothing, Some(&runner), &[]));
        let ready = app(|a| {
            a.staged = Some("def5678".into());
            a.building = true;
        });
        assert_eq!(
            next_version(&ready, None),
            NextVersion::Ready,
            "ready wins over a newer one building"
        );
        assert!(!quiet_dot(&ready, None, &[]));
        // What the ring and the green don't cover keeps its grey dot.
        assert!(quiet_dot(&app(|a| a.failed = true), None, &[]));
        assert!(quiet_dot(&ready, None, &mock_clis()));
        let old = RunnerUpdates {
            state: "idle".into(),
            old_runners: vec![OldRunner::default()],
            ..Default::default()
        };
        assert!(quiet_dot(&nothing, Some(&old), &[]));
    }

    #[test]
    fn the_icon_says_whats_going_on() {
        let app = AppSide::default();
        let clis = mock_clis();
        let idle = RunnerUpdates::decode(&json!({ "state": "idle", "oldRunners": [] })).unwrap();
        assert!(!shown(&app, Some(&idle)));
        assert!(!needs_you(&app, Some(&idle)));
        assert_eq!(
            icon_tooltip(&app, Some(&idle), &[]),
            "Updates\nEverything is up to date"
        );
        assert_eq!(icon_tooltip(&app, Some(&idle), &clis), "Updates\nClaude Code 2.1.311, 2.1.312 available\nCodex 0.165.0 is held back because the app-server protocol changed");
        let building = RunnerUpdates::decode(&json!({ "state": "building", "commit": "abc1234", "subject": "Fix the thing", "oldRunners": [] })).unwrap();
        assert!(shown(&app, Some(&building)));
        assert!(!needs_you(&app, Some(&building)), "it sorts itself out");
        assert_eq!(
            icon_tooltip(&app, Some(&building), &[]),
            "Updates\nA runner update"
        );
        assert_eq!(
            runner_lines(Some(&building)),
            ["Building the runner from main at abc1234: Fix the thing."]
        );
        let failed = RunnerUpdates::decode(
            &json!({ "state": "failed", "commit": "abc1234", "reason": "npm ci failed" }),
        )
        .unwrap();
        assert_eq!(tooltip(&app, Some(&failed)), "The runner's update failed");
        assert_eq!(
            runner_lines(Some(&failed)),
            ["The runner couldn't update to main at abc1234: npm ci failed"]
        );
        let launcher = RunnerUpdates::decode(
            &json!({ "state": "idle", "launcherChanged": true, "launcherStages": true }),
        )
        .unwrap();
        assert!(needs_you(&app, Some(&launcher)));
        assert_eq!(
            icon_tooltip(&app, Some(&launcher), &[]),
            "Updates\nThe runner needs updating"
        );
        let both = RunnerUpdates::decode(
            &json!({ "state": "building", "commit": "abc1234", "launcherChanged": true }),
        )
        .unwrap();
        assert_eq!(
            icon_tooltip(&app, Some(&both), &[]),
            "Updates\nA runner update\nThe runner needs updating"
        );
        assert_eq!(runner_lines(Some(&launcher)), ["launch.mjs has changed on main. Updating it stops nothing; the new one starts next time your Mac restarts."]);
        assert_eq!(
            launcher_button(&launcher).map(|b| (b.0, b.2)),
            Some(("Update it", false))
        );
        // What the runner is doing about it (runner.reinstall): only a failure is Mike's.
        let reinstall = |r: Value| {
            RunnerUpdates::decode(&json!({ "state": "idle", "launcherChanged": true, "launcherStages": true, "launcherReason": "Threadbear Runner.app was built from older launcher sources than main's.", "reinstall": r })).unwrap()
        };
        // A runner from 14 Nov reinstalls once idle: no button, no promise that nothing stops.
        let older = RunnerUpdates::decode(&json!({ "state": "idle", "launcherChanged": true, "launcherReason": "Threadbear Runner.app was built from older launcher sources than main's.", "reinstall": { "state": "waiting" } })).unwrap();
        assert_eq!(launcher_button(&older), None);
        assert_eq!(runner_lines(Some(&older)), ["Threadbear Runner.app was built from older launcher sources than main's. It's updated once the runner itself is, a few minutes after main."]);
        let auto = reinstall(json!({ "state": "waiting", "auto": true }));
        assert!(!needs_you(&app, Some(&auto)), "it sorts itself out");
        assert!(shown(&app, Some(&auto)));
        assert_eq!(
            icon_tooltip(&app, Some(&auto), &[]),
            "Updates\nThe runner is updating"
        );
        let running = reinstall(json!({ "state": "running", "logFile": "/x/reinstall.log" }));
        assert!(!needs_you(&app, Some(&running)));
        assert_eq!(runner_lines(Some(&running)), ["Updating Threadbear Runner. Nothing stops; the new one starts next time your Mac restarts."]);
        assert_eq!(
            launcher_button(&running).map(|b| (b.0, b.2)),
            Some(("Updating", true))
        );
        // Staged: nothing more to do until the Mac restarts, so no dot at all.
        let staged = reinstall(json!({ "state": "staged", "logFile": "/x/reinstall.log" }));
        assert!(!needs_you(&app, Some(&staged)));
        assert!(!staged.is_pending());
        assert_eq!(runner_lines(Some(&staged)), ["Threadbear Runner.app was built from older launcher sources than main's. The update is in place, and starts next time your Mac restarts."]);
        assert_eq!(launcher_button(&staged), None);
        let failed = reinstall(
            json!({ "state": "failed", "reason": "launch.mjs doesn't load.", "logFile": "/x/reinstall.log" }),
        );
        assert!(needs_you(&app, Some(&failed)));
        assert_eq!(
            icon_tooltip(&app, Some(&failed), &[]),
            "Updates\nThe runner's update didn't work"
        );
        assert_eq!(
            runner_lines(Some(&failed)),
            ["The runner's update didn't work: launch.mjs doesn't load."]
        );
        assert_eq!(
            failed
                .reinstall
                .as_ref()
                .and_then(|r| r.log_file.as_deref()),
            Some("/x/reinstall.log")
        );
        assert_eq!(
            launcher_button(&failed).map(|b| (b.0, b.2)),
            Some(("Try again", false))
        );
        let behind = RunnerUpdates::decode(&json!({ "state": "idle", "behindRunners": [{ "name": "mac-mini", "problem": "3 days behind" }] })).unwrap();
        assert!(needs_you(&app, Some(&behind)));
        assert_eq!(
            icon_tooltip(&app, Some(&behind), &[]),
            "Updates\nA runner isn't following GitHub's main"
        );
        assert_eq!(
            runner_lines(Some(&behind)),
            ["mac-mini isn't following GitHub's main properly: 3 days behind"]
        );
        let draining = RunnerUpdates::decode(&json!({ "state": "idle", "oldRunners": [{ "version": "0.1.0", "threads": ["t1", "t2"] }] })).unwrap();
        assert_eq!(runner_lines(Some(&draining)), ["2 threads are finishing their turns on the previous version. Each moves to the new one when its turn ends."]);
        assert_eq!(runner_lines(Some(&idle)), ["The runner is up to date."]);
        assert_eq!(
            runner_lines(None),
            ["This runner doesn't say how its updates are going."]
        );
        assert_eq!(RunnerUpdates::decode(&Value::Null), None);
        assert_eq!(app_line(&app), "The app is up to date.");
    }

    // The installed GPUI app can't follow main until it's installed again:
    // only Mike can do that, so the accent dot.
    #[test]
    fn an_app_that_cant_follow_main_says_why_and_needs_you() {
        let app = AppSide {
            running: Some("abc1234".into()),
            not_following: Some("it was installed before it could".into()),
            ..Default::default()
        };
        assert_eq!(
            app_line(&app),
            "The app isn't following main: it was installed before it could."
        );
        assert!(shown(&app, None) && needs_you(&app, None));
        assert_eq!(
            icon_tooltip(&app, None, &[]),
            "Updates\nThe app isn't following main"
        );
        // Waiting for a Mac is on its way, so grey.
        let waiting = AppSide {
            running: Some("abc1234".into()),
            waiting: true,
            ..Default::default()
        };
        assert!(shown(&waiting, None) && !needs_you(&waiting, None));
        assert_eq!(
            app_line(&waiting),
            "The app has a new version on main, waiting for a Mac to build it on."
        );
    }

    #[test]
    fn a_waiting_thread_says_which_build_has_its_fix() {
        let builds = BuildCommits {
            running: Some("r".into()),
            staged: None,
            building: Some("b".into()),
        };
        // "x" is in the building commit only; "y" in none; "?" git can't place.
        let has = |want: &str, build: &str| match (want, build) {
            ("x", "b") => Some(true),
            ("?", _) => None,
            _ => Some(false),
        };
        assert_eq!(fix_place(Some("x"), &builds, has), FixPlace::Building);
        assert_eq!(fix_place(Some("y"), &builds, has), FixPlace::Next);
        assert_eq!(fix_place(Some("?"), &builds, has), FixPlace::Unknown);
        assert_eq!(fix_place(None, &builds, has), FixPlace::Unknown);
        // The running app having it wins over a later build having it too.
        assert_eq!(
            fix_place(Some("r"), &builds, |_, _| Some(true)),
            FixPlace::InApp
        );
        let staged = BuildCommits {
            staged: Some("s".into()),
            ..builds
        };
        assert_eq!(
            fix_place(Some("s"), &staged, |w, b| Some(w == b)),
            FixPlace::Ready
        );
        let building = AppSide {
            building: true,
            ..Default::default()
        };
        assert_eq!(
            fix_label(FixPlace::Next, &building),
            "Landed after it, in the next one"
        );
        assert_eq!(
            fix_label(FixPlace::Next, &AppSide::default()),
            "In the next build"
        );
        assert_eq!(fix_label(FixPlace::Building, &building), "In this build");
    }

    #[test]
    fn the_panel_says_where_the_build_is_on_its_host() {
        let at = |line: &str, building: bool| AppSide {
            running: Some("abc1234".into()),
            building,
            waiting: !building,
            phase: BuildPhase::parse(line, 10_000),
            ..Default::default()
        };
        assert_eq!(
            app_line(&at("queued tinker-desk 8020 3", true)),
            "The app's next version is queued on tinker-desk behind 3 other runs (33 minutes so far)."
        );
        assert_eq!(
            app_line(&at("queued tinker-desk 9990", true)),
            "The app's next version is queued on tinker-desk, waiting for what it's running to finish (0 minutes so far)."
        );
        assert_eq!(
            popover_line(&at("queued tinker-desk 9990 1", true)),
            "The app's next version is queued behind other work."
        );
        assert_eq!(
            app_line(&at("building tinker-desk 9940", true)),
            "Building the app from main on tinker-desk, 1 minute in."
        );
        assert_eq!(
            app_line(&at("busy tinker-desk 8800", false)),
            "The app has a new version on main, waiting for tinker-desk, which has been busy with other work for 20 minutes."
        );
        // A phase left from another state, or unreadable, says what it did before.
        assert_eq!(
            app_line(&at("busy tinker-desk 8800", true)),
            "Building the app from main."
        );
        assert_eq!(
            app_line(&at("compiling tinker-desk 1", true)),
            "Building the app from main."
        );
        assert_eq!(BuildPhase::parse("queued tinker-desk", 5), None);
        // Still the ring, whatever the phase.
        assert_eq!(
            next_version(&at("queued tinker-desk 1 2", true), None),
            NextVersion::Coming
        );
    }

    #[test]
    fn an_app_waiting_for_main_to_settle_is_pending() {
        let app = AppSide {
            settling: true,
            quiet_minutes: 10,
            ..Default::default()
        };
        assert!(app.is_pending() && shown(&app, None) && !needs_you(&app, None));
        assert_eq!(
            app_line(&app),
            "The app has a new version on main, waiting for ten quiet minutes before building."
        );
        let two = AppSide {
            quiet_minutes: 2,
            ..app.clone()
        };
        assert_eq!(
            app_line(&two),
            "The app has a new version on main, waiting for two quiet minutes before building."
        );
        assert!(app_line(&AppSide {
            quiet_minutes: 1,
            ..app.clone()
        })
        .contains("for a quiet minute before"));
        assert!(app_line(&AppSide {
            quiet_minutes: 30,
            ..app.clone()
        })
        .contains("for 30 quiet minutes before"));
        assert!(app_line(&AppSide {
            quiet_minutes: 0,
            ..app
        })
        .contains("waiting for main to settle before"));
    }

    // Mike, 13 Nov: a countdown that starts again when he does something,
    // and otherwise what it's waiting for.
    #[test]
    fn a_staged_app_says_what_its_restart_waits_on() {
        use crate::app_update::RestartWait;
        let staged = |wait| AppSide {
            running: Some("abc1234".into()),
            staged: Some("def5678".into()),
            wait,
            ..Default::default()
        };
        assert_eq!(app_line(&staged(None)), "The app's next version (def5678) is ready. It switches in when you're not using the app, or now.");
        assert_eq!(app_line(&staged(Some(RestartWait::Countdown(3)))), "The app's next version (def5678) is ready. It switches in 3s if you leave the app alone, or now.");
        assert_eq!(
            app_line(&staged(Some(RestartWait::Held("the message box in “Fix it” is sent or cleared".into())))),
            "The app's next version (def5678) is ready. It switches in once the message box in “Fix it” is sent or cleared, or now."
        );
    }

    #[test]
    fn mikes_releases_say_whats_new_and_start_a_thread() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        let u = RunnerUpdates::decode(&json!({ "state": "idle", "upstream": { "state": "available", "checkout": "/Users/me/threadbear",
            "release": { "tag": "release/2026-11-10", "commit": commit, "changes": 3, "subjects": ["a", "b", "c"], "notes": [{ "tag": "release/2026-11-10", "lines": ["Runners in the app"] }, { "tag": "bad" }] } } })).unwrap();
        assert!(from_mike(Some(&u)));
        assert!(needs_you(&AppSide::default(), Some(&u)));
        let upstream = u.upstream.as_ref().unwrap();
        assert_eq!(
            upstream_line(Some(upstream)).as_deref(),
            Some("Mike's release of 10 Nov has 3 new changes.")
        );
        assert_eq!(
            upstream_tooltip(Some(upstream)).as_deref(),
            Some("3 new changes from Mike")
        );
        let release = upstream.release.as_ref().unwrap();
        assert_eq!(
            release_lines(release),
            [(None, vec!["Runners in the app".to_string()])]
        );
        assert_eq!(
            bring_in_title(release, false),
            "Bring in Mike's release of 10 Nov"
        );
        assert_eq!(
            bring_in_title(release, true),
            "Discuss Mike's release of 10 Nov"
        );
        assert!(bring_in_prompt(release).contains(&format!("(3 new changes) to this copy of Threadbear. Merge its commit {commit}, the one its signature was checked for. Follow")));
        assert!(discuss_prompt(release).contains(&format!("Its commit is {commit}, the one")));
        let unsigned = Release {
            commit: Some("main".into()),
            ..release.clone()
        };
        assert!(
            bring_in_prompt(&unsigned).contains("Threadbear. Follow"),
            "a commit that isn't one is left out"
        );
        // Notes for older tags only: dated, and the subjects after.
        let older = Release {
            notes: vec![Notes {
                tag: "release/2026-11-08".into(),
                date: None,
                lines: vec!["x".into()],
            }],
            ..release.clone()
        };
        assert_eq!(
            release_lines(&older),
            [
                (Some("8 Nov".to_string()), vec!["x".to_string()]),
                (
                    Some("Every change".to_string()),
                    vec!["a".to_string(), "b".to_string(), "c".to_string()]
                )
            ]
        );
        let idle = Upstream {
            state: "idle".into(),
            release: Some(release.clone()),
            ..Default::default()
        };
        assert_eq!(
            upstream_line(Some(&idle)).as_deref(),
            Some("You're up to date with Mike's release of 10 Nov.")
        );
        let mine = Upstream {
            state: "off".into(),
            published_tag: Some("release/2026-11-11".into()),
            ..Default::default()
        };
        assert_eq!(
            upstream_line(Some(&mine)).as_deref(),
            Some("Your last release for everyone else is release/2026-11-11.")
        );
        let failed = Upstream {
            state: "failed".into(),
            reason: Some("no network".into()),
            ..Default::default()
        };
        assert_eq!(
            upstream_line(Some(&failed)).as_deref(),
            Some("Couldn't check for Mike's releases: no network")
        );
        assert_eq!(
            release_day("release/2026-13-01", None),
            "release/2026-13-01"
        );
    }

    #[test]
    fn a_release_is_dated_where_the_reader_is() {
        // release/2026-11-15 was tagged at 8:26 am on 14 Nov in California
        // (00:26 on the 15th in Perth): Wayne saw "15 Nov" on the 14th.
        let tag = "release/2026-11-15";
        let at = Some("2026-11-14T16:26:37.000Z");
        let california = chrono::FixedOffset::west_opt(8 * 3600).unwrap();
        let perth = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        assert_eq!(release_day_in(tag, at, &california), "14 Nov");
        assert_eq!(release_day_in(tag, at, &perth), "15 Nov");
        assert_eq!(
            release_day_in(tag, None, &california),
            "15 Nov",
            "an older runner sends no date: the tag's own"
        );
        assert_eq!(
            release_day_in(tag, Some("soon"), &california),
            "15 Nov",
            "a date that doesn't parse is the same"
        );
        let r = RunnerUpdates::decode(&json!({ "state": "idle", "upstream": { "state": "available",
            "release": { "tag": tag, "date": at, "changes": 1, "subjects": ["a"], "notes": [{ "tag": tag, "date": at, "lines": ["x"] }] } } })).unwrap();
        let release = r.upstream.unwrap().release.unwrap();
        assert_eq!(release.date.as_deref(), at);
        assert_eq!(release.notes[0].date.as_deref(), at);
    }

    #[test]
    fn the_from_mike_section_shows_the_pages_cards_counts_and_notes_it_has_no_entry_for() {
        let up = |changelog: Value| {
            RunnerUpdates::decode(&json!({ "state": "idle", "upstream": { "state": "available", "release": {
                "tag": "release/2026-11-16", "changes": 41, "subjects": ["a"],
                "important": [{ "commit": "1", "why": "Pairing tokens" }, { "commit": "2", "why": "Pairing tokens" }, { "commit": "3", "why": "Open gate" }],
                "notes": [
                    { "tag": "release/2026-11-16", "lines": ["Reviewers"] },
                    { "tag": "release/2026-11-15", "lines": ["Fifteen"] },
                    { "tag": "release/2026-11-14", "lines": ["Open Anything"] }
                ],
                "changelog": changelog
            } } }))
            .unwrap()
            .upstream
            .unwrap()
            .release
            .unwrap()
        };
        let card = |kind: &str, title: &str| json!({ "kind": kind, "title": title, "text": "x", "picture": format!("https://threadbear.mikecann.app/media/changelog/x/{title}.webp") });
        let r = up(
            json!({ "page": "https://threadbear.mikecann.app/changelog", "releases": [
            { "tag": "release/2026-11-16", "link": "https://threadbear.mikecann.app/changelog#2026-11-16", "highlights": [card("changed", "reviewers")], "added": 1, "changed": 3, "fixed": 6 },
            { "tag": "release/2026-11-14", "link": "https://threadbear.mikecann.app/changelog#2026-11-14", "highlights": [
                card("added", "app"), { "kind": "added", "title": "anything", "text": "x", "picture": "https://threadbear.mikecann.app/a.webp", "clip": true }, card("added", "reinstall"), card("changed", "spelling"),
                // Not a web picture: left out.
                { "kind": "added", "title": "local", "text": "x", "picture": "file:///etc/passwd" }
            ], "added": 4, "changed": 16, "fixed": 7 }
        ] }),
        );
        assert_eq!(r.important, ["Pairing tokens", "Open gate"]);
        let d = release_digest(&r).unwrap();
        let titles: Vec<_> = d
            .cards
            .iter()
            .map(|(c, link)| (c.title.as_str(), link.rsplit('#').next().unwrap()))
            .collect();
        assert_eq!(
            titles,
            [
                ("reviewers", "2026-11-16"),
                ("app", "2026-11-14"),
                ("anything", "2026-11-14"),
                ("reinstall", "2026-11-14")
            ]
        );
        assert!(d.cards[2].0.clip);
        assert_eq!(d.more, 1);
        assert_eq!(digest_counts(&d), "8 added, 21 changed, 13 fixed");
        assert_eq!(
            important_line(d.important.len()).as_deref(),
            Some("2 important fixes")
        );
        assert_eq!(important_line(1).as_deref(), Some("1 important fix"));
        assert_eq!(important_line(0), None);
        assert_eq!(
            important_tip(&["the pairing token".to_owned(), "Open gate".to_owned()]),
            "• The pairing token\n• Open gate"
        );
        assert_eq!(d.page, "https://threadbear.mikecann.app/changelog");
        // 15 Nov isn't on the page yet, so its notes stand in, dated.
        assert_eq!(
            d.notes,
            [(Some("15 Nov".to_owned()), vec!["Fifteen".to_owned()])]
        );
        // No page, or one with none of these releases: the notes as before.
        assert_eq!(release_digest(&up(Value::Null)), None);
        assert_eq!(
            release_digest(&up(
                json!({ "page": "https://threadbear.mikecann.app/changelog", "releases": [] })
            )),
            None
        );
        assert_eq!(
            release_digest(&up(
                json!({ "page": "http://evil.example/changelog", "releases": [{ "tag": "release/2026-11-16" }] })
            )),
            None
        );
        // A release on the page with no cards still counts its lines.
        let plain = release_digest(&up(json!({ "page": "https://threadbear.mikecann.app/changelog", "releases": [{ "tag": "release/2026-11-15", "added": 0, "changed": 4, "fixed": 1 }] }))).unwrap();
        assert!(plain.cards.is_empty());
        assert_eq!(digest_counts(&plain), "4 changed, 1 fixed");
    }
}
