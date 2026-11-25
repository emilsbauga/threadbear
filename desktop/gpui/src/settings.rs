// What the app remembers between launches: where the window was, the zoom,
// which sidebar sections are folded, the Inbox's sort and the panel layout.
// One JSON file in the runner's data folder, beside shortcuts.json, rather
// than the Swift app's UserDefaults: an agent can read it, it needs no
// per-OS code, and there's nothing to migrate between machines.
//
// The field names are the Swift app's UserDefaults keys
// (AppModel.collapsedSectionsKey "collapsedSections",
// AppModel.collapsedScheduleSectionsKey "collapsedScheduleSections", AppModel.inboxOrderKey
// "inboxOrder", TextZoom.defaultsKey "textZoomPercent", WindowDock.layoutKey
// "dockLayout"; MainWindowFrame's "Threadbear window frame main" is
// `windowFrame` here), so a later one-time import from UserDefaults is
// mechanical: read each key across as-is, and for the frame
// parse NSStringFromRect's "{{x, y}, {w, h}}" (bottom-left origin) into a
// top-left one.
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use threadbear_client::config::RunnerConfig;
use threadbear_core::completion_sound::{self, Ding};
use threadbear_core::inbox::InboxOrder;
use threadbear_core::zoom;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    /// Scripted Mac test copies read this at launch. None means hidden.
    pub hide_testing_windows: Option<bool>,
    /// Highest thread-count milestone actually shown, as in the Swift app.
    pub thread_milestone_shown: Option<usize>,
    /// The window's frame, in points from the top left of the screens.
    pub window_frame: Option<WindowFrame>,
    /// `textZoomPercent`. Only saved when it isn't 100, as TextZoom removes it.
    pub text_zoom_percent: Option<u32>,
    /// `collapsedSections`: the sidebar sections folded away, by
    /// `InboxSection`'s raw value. None means nothing saved yet (Hibernating
    /// and Archived start folded, as `storedCollapsedSections` makes them).
    pub collapsed_sections: Option<Vec<String>>,
    /// `collapsedScheduleSections`: the Scheduled list's headings folded
    /// away, by `ScheduleSection`'s raw value. None means nothing saved yet
    /// (Done starts folded, as `storedCollapsedScheduleSections` makes it).
    pub collapsed_schedule_sections: Option<Vec<String>>,
    /// `inboxOrder`: `InboxOrder`'s raw value.
    pub inbox_order: Option<String>,
    /// `appearance`: "system", "light" or "dark" (`AppAppearance`).
    pub appearance: Option<String>,
    /// Appearance's accent, `style::Accent`'s name. None is the system's.
    pub accent: Option<String>,
    /// Appearance's Spacing: Some(true) is Compact. None is Roomy.
    pub compact: Option<bool>,
    /// Appearance's Font, `style::Font`'s name. None is the system's.
    pub font: Option<String>,
    /// `dockLayout`: the Dock's JSON, the same shape Swift's Codable saves.
    pub dock_layout: Option<Value>,
    /// `completionSound`: the ding when a thread finishes (ding.rs). Off
    /// until it's turned on.
    pub completion_sound: Option<bool>,
    /// `completionSoundDing`: which one, `Ding`'s name.
    pub completion_sound_ding: Option<String>,
    /// `completionSoundVolume`: 0.1 to 1.
    pub completion_sound_volume: Option<f64>,
    /// `askBeforeQuitting` (QuitPrompt): None is yes.
    pub ask_before_quitting: Option<bool>,
    /// `activityLog` (ActivityRecorder): Settings > General's Keep an
    /// activity log (activity.rs). Off until it's turned on.
    pub activity_log: Option<bool>,
    /// When the Swift app's settings and drafts were brought across
    /// (swift_import.rs): once, so none is.
    pub swift_import: Option<String>,
    /// The parts of that done so far ("settings", "drafts", "files"), each
    /// once, while another is still to go after a failure.
    pub swift_import_parts: Vec<String>,
    /// `updateRestore`: the sidebar's view and the thread that were open
    /// when the app restarted itself for an update, put back once (app_update.rs).
    pub update_restore: Option<Value>,
    /// `runnersPanelOpen`: the runners whose details are open in the Runners
    /// panel, their ids with commas between.
    pub runners_panel_open: Option<String>,
    /// `usage.chartRange`: the Usage panel's chart, "today" or "week".
    #[serde(rename = "usage.chartRange")]
    pub usage_chart_range: Option<String>,
    /// `usage.showModelWeeks`: the Usage panel's switch for a model's own
    /// week ("Weekly Fable"). None is on.
    #[serde(rename = "usage.showModelWeeks")]
    pub usage_show_model_weeks: Option<bool>,
    /// `threadsCollapsed`: ⌘/ folded the Threads panel away (thread_panels.rs).
    /// None is no.
    pub threads_collapsed: Option<bool>,
    /// ⌘K's Recent (open_anything.rs): what was opened lately, newest first,
    /// as the box's keys ("thread:<id>", "panel:<place>|<id>"). The GPUI
    /// app's own; the Swift app hasn't got the box.
    pub open_anything_recent: Option<Vec<String>>,
    /// `tourSeen`: the first-run tour was done or skipped, so it doesn't come
    /// up by itself again (tour.rs). Brought across from the Swift app's.
    pub tour_seen: Option<bool>,
    /// `setupHidden`: Finish setting up's Hide this list (setup_panel.rs).
    pub setup_hidden: Option<bool>,
    /// The pages' one-card intros seen, by name ("projects"): the Swift app's
    /// `tourIntro.<name>` keys, one list here.
    pub tour_intros_seen: Option<Vec<String>>,
    /// When the Swift app's tour, intros and Finish setting up were brought
    /// across (swift_import.rs, `tour_once`): once, and before the tour may
    /// start by itself, so someone who finished it there never sees it again.
    pub swift_tour_import: Option<String>,
    /// `panelBackgroundDrag`: Settings > General's Move panels by their
    /// background. A press held on a panel's background picks it up, as on
    /// its bar. None is off: most of the time a press there is meant for
    /// the panel, and its title or tab is the place to drag it from (Mike,
    /// 13 Nov). A panel with its title hidden moves from its background
    /// either way. The GPUI app's own.
    pub panel_background_drag: Option<bool>,
    /// The Canvas page's board (thread_canvas.rs, the `threadCanvas`
    /// experiment): each project's area, where each thread sits and the
    /// camera, as `threadbear_core::thread_canvas::Layout` saves it.
    pub thread_canvas: Option<Value>,
    /// Fields this build doesn't know (a newer build's), kept as they are,
    /// so going back a version and forward again loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The fields that record a step done once (swift_import.rs).
const ONCE_ONLY: [&str; 3] = ["swiftImport", "swiftImportParts", "swiftTourImport"];

impl Saved {
    fn after_a_broken_file() -> Self {
        let now = threadbear_core::inbox::iso_time(crate::now_ms());
        Saved {
            swift_import: Some(now.clone()),
            swift_tour_import: Some(now),
            tour_seen: Some(true),
            ..Saved::default()
        }
    }
}

/// A JSON object read field by field: a field `T` can't take is left out
/// (and logged by name, never its value), so the rest still count, and
/// the names of those left out. None when it isn't a JSON object at all.
/// `T` must take any one of its fields alone (`#[serde(default)]`).
pub(crate) fn tolerant<T: DeserializeOwned>(data: &[u8], file: &str) -> Option<(T, Vec<String>)> {
    let Ok(Value::Object(mut fields)) = serde_json::from_slice::<Value>(data) else {
        return None;
    };
    let mut dropped = Vec::new();
    fields.retain(|key, value| {
        let fits = serde_json::from_value::<T>(Value::Object(Map::from_iter([(
            key.clone(),
            value.clone(),
        )])))
        .is_ok();
        if !fits {
            threadbear_client::log::write(
                "settings",
                &format!("{file}: left out {key}, which isn't the type this build reads"),
            );
            dropped.push(key.clone());
        }
        fits
    });
    serde_json::from_value(Value::Object(fields))
        .ok()
        .map(|t| (t, dropped))
}

/// The settings file: where it is and what's in it. Reading is at launch only;
/// the rest of the time the app holds the current values and writes the file
/// when one changes.
pub struct Settings {
    path: PathBuf,
    pub saved: Saved,
}

impl Settings {
    pub fn file_name() -> &'static str {
        "desktop-settings.json"
    }

    pub fn path_in(home: &Path) -> PathBuf {
        home.join(Self::file_name())
    }

    /// The file for the runner this app talks to (THREADBEAR_HOME, or its
    /// default): a mock's or a dev runner's settings stay with that runner's
    /// data, never Mike's real one.
    pub fn load() -> Self {
        let path = Self::path_in(&RunnerConfig::from_env().home);
        Self::load_from(path)
    }

    /// One field of the wrong type (an agent's edit, an older build reading
    /// a newer one's) loses only that field. A file that can't be read at
    /// all is kept beside it as desktop-settings.json.broken, and the steps
    /// that must only ever happen once count as done: the file is only ever
    /// written by this app, so it has run here before, and bringing the
    /// Swift app's drafts across again could put back ones already sent
    /// (swift_import.rs). It used to read as no file at all, and the next
    /// save wrote the defaults over it.
    pub fn load_from(path: PathBuf) -> Self {
        let saved = match std::fs::read(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            read => match read
                .ok()
                .and_then(|data| tolerant::<Saved>(&data, Self::file_name()))
            {
                // A record of a step done once that can't be read counts as
                // done, as a broken file does: else a mangled swiftImport
                // reads as none and the drafts come across again (Codex's
                // review, 16 Nov).
                Some((mut saved, dropped)) => {
                    if dropped.iter().any(|k| ONCE_ONLY.contains(&k.as_str())) {
                        let done = Saved::after_a_broken_file();
                        saved.swift_import = saved.swift_import.or(done.swift_import);
                        saved.swift_tour_import =
                            saved.swift_tour_import.or(done.swift_tour_import);
                    }
                    saved
                }
                None => {
                    let aside = path.with_file_name(format!("{}.broken", Self::file_name()));
                    let kept = std::fs::copy(&path, &aside).is_ok();
                    threadbear_client::log::write("settings", &format!("{} couldn't be read{}; starting from the defaults, with the Swift import and the tour counted as done", Self::file_name(), if kept { ", kept as .broken" } else { "" }));
                    Saved::after_a_broken_file()
                }
            },
        };
        Settings { path, saved }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Written whole and renamed into place, so a crash mid-write can't leave
    /// half a file (the same as shortcuts.json's atomic write in the Swift app),
    /// and only this user's, as everything in the data folder is.
    pub fn save(&self) {
        // A handover's incoming app: the file is the outgoing app's until
        // this one takes over and reads it again (handover.rs).
        if crate::handover::waiting() {
            return;
        }
        let _ = self.save_checked();
    }

    /// `save`, saying whether it went, for a record that mustn't be lost
    /// (swift_import.rs).
    pub fn save_checked(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.saved).map_err(|e| e.to_string())?;
        threadbear_core::private_file::write(&self.path, text.as_bytes())
            .map_err(|e| format!("couldn't save {}: {e}", self.path.display()))
    }

    pub fn zoom_percent(&self) -> u32 {
        zoom::sanitize(self.saved.text_zoom_percent)
    }

    pub fn set_zoom_percent(&mut self, percent: u32) {
        self.saved.text_zoom_percent = (percent != zoom::DEFAULT_PERCENT).then_some(percent);
    }

    pub fn inbox_order(&self) -> InboxOrder {
        self.saved
            .inbox_order
            .as_deref()
            .and_then(InboxOrder::from_name)
            .unwrap_or_default()
    }

    pub fn set_inbox_order(&mut self, order: InboxOrder) {
        self.saved.inbox_order = Some(order.name().to_string());
    }

    pub fn ding_on(&self) -> bool {
        self.saved.completion_sound.unwrap_or(false)
    }

    pub fn ding(&self) -> Ding {
        Ding::from_name(self.saved.completion_sound_ding.as_deref().unwrap_or(""))
    }

    pub fn ding_volume(&self) -> f64 {
        self.saved
            .completion_sound_volume
            .unwrap_or(completion_sound::DEFAULT_VOLUME)
            .clamp(0.1, 1.)
    }

    pub fn panel_background_drag(&self) -> bool {
        self.saved.panel_background_drag.unwrap_or(false)
    }

    pub fn asks_before_quitting(&self) -> bool {
        self.saved.ask_before_quitting.unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tb-settings-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(Settings::file_name())
    }

    #[test]
    fn what_was_saved_comes_back() {
        let path = temp_file("roundtrip");
        let mut s = Settings::load_from(path.clone());
        assert_eq!(s.saved, Saved::default(), "no file yet");
        s.set_zoom_percent(125);
        s.set_inbox_order(InboxOrder::Newest);
        s.saved.collapsed_sections = Some(vec!["inbox".into()]);
        s.saved.window_frame = Some(WindowFrame {
            x: 10.,
            y: 20.,
            width: 1180.,
            height: 800.,
        });
        s.save();
        let read = Settings::load_from(path);
        assert_eq!(read.zoom_percent(), 125);
        assert_eq!(read.inbox_order(), InboxOrder::Newest);
        assert_eq!(
            read.saved.collapsed_sections,
            Some(vec!["inbox".to_string()])
        );
        assert_eq!(
            read.saved.window_frame,
            Some(WindowFrame {
                x: 10.,
                y: 20.,
                width: 1180.,
                height: 800.
            })
        );
    }

    #[test]
    fn a_broken_file_is_kept_and_the_once_only_steps_stay_done() {
        let path = temp_file("broken");
        std::fs::write(&path, "{ half").unwrap();
        let s = Settings::load_from(path.clone());
        assert!(
            s.saved.swift_import.is_some(),
            "no second Swift import, which could bring sent drafts back"
        );
        assert!(s.saved.swift_tour_import.is_some());
        assert_eq!(s.saved.tour_seen, Some(true));
        assert_eq!(s.zoom_percent(), zoom::DEFAULT_PERCENT);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("desktop-settings.json.broken")).unwrap(),
            "{ half"
        );
    }

    #[test]
    fn one_field_of_the_wrong_type_loses_only_that_field() {
        let path = temp_file("wrong-type");
        std::fs::write(&path, r#"{"textZoomPercent": 140, "swiftImport": "2026-11-12T01:00:00Z", "swiftImportParts": null, "inboxOrder": 5, "tourSeen": true}"#).unwrap();
        let s = Settings::load_from(path);
        assert_eq!(s.zoom_percent(), 140);
        assert_eq!(
            s.saved.swift_import.as_deref(),
            Some("2026-11-12T01:00:00Z")
        );
        assert_eq!(s.saved.swift_import_parts, Vec::<String>::new());
        assert_eq!(s.saved.inbox_order, None);
        assert_eq!(s.saved.tour_seen, Some(true));
    }

    #[test]
    fn a_mangled_record_of_the_swift_import_counts_as_done() {
        let path = temp_file("mangled-marker");
        std::fs::write(
            &path,
            r#"{"swiftImport": true, "swiftImportParts": [], "textZoomPercent": 125}"#,
        )
        .unwrap();
        let s = Settings::load_from(path);
        assert!(s.saved.swift_import.is_some(), "not imported again");
        assert!(s.saved.swift_tour_import.is_some());
        assert_eq!(s.zoom_percent(), 125);
        assert_eq!(
            s.saved.tour_seen, None,
            "only the records, not the tour itself"
        );
    }

    #[test]
    fn unknown_fields_are_read_past_and_saved_back() {
        let path = temp_file("unknown");
        std::fs::write(
            &path,
            r#"{"textZoomPercent": 140, "somethingNewer": {"on": true}}"#,
        )
        .unwrap();
        let mut s = Settings::load_from(path.clone());
        assert_eq!(s.zoom_percent(), 140);
        s.set_zoom_percent(110);
        s.save_checked().unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["somethingNewer"], serde_json::json!({ "on": true }));
        assert_eq!(written["textZoomPercent"], 110);
    }
}
