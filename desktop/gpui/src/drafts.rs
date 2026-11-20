// What's in each composer, kept in `<runner home>/desktop-drafts.json` so it
// outlives the app (Swift's DraftStore, `app-drafts.json`): a quit, an update
// or a crash used to throw away half-written messages. This app's own file,
// so the Swift app and this one running side by side don't write over each
// other's. Written a moment after typing stops and as the app quits; a
// thread's box gets its draft back when it's next made. Private words: the
// file is only readable by Mike's account.
//
// A card's Something else boxes and a question's are kept here too, under
// `card:<thread>:<card seq>:<ask>` and `question:<thread>:<approval id>`,
// so they no longer hold an update's restart: Mike, 19 Nov, "just reboot
// and then just put the text back in the box". Older apps keep keys they
// don't know, as a box not made yet this run.
use crate::app::Threadbear;
use crate::composer::{image_ref_json, RestoreDraft};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use threadbear_core::reducer::ImageRef;

/// The new-thread page's box.
pub(crate) const NEW_THREAD: &str = "new";

/// A card's Something else box: `card:<thread>:<seq>:<ask>`.
pub(crate) fn card_key(thread: &str, seq: i64, ask: i64) -> String {
    format!("card:{thread}:{seq}:{ask}")
}

/// A question's Something else box: `question:<thread>:<approval id>`.
pub(crate) fn question_key(thread: &str, approval_id: &str) -> String {
    format!("question:{thread}:{approval_id}")
}

/// The answers picked on a card, kept with its words (as JSON, in a
/// draft's text) so a restart doesn't leave a mixed answer half done:
/// `card-picks:<thread>:<seq>`.
pub(crate) fn card_picks_key(thread: &str, seq: i64) -> String {
    format!("card-picks:{thread}:{seq}")
}

/// A question's picks, the same way: `question-picks:<thread>:<approval id>`.
pub(crate) fn question_picks_key(thread: &str, approval_id: &str) -> String {
    format!("question-picks:{thread}:{approval_id}")
}

/// Picks for the file, or none when there are none.
pub(crate) fn picks_draft<T: serde::Serialize>(picks: &T, empty: bool) -> Option<Draft> {
    (!empty).then(|| Draft { text: serde_json::to_string(picks).unwrap_or_default(), images: Vec::new(), ..Default::default() })
}

/// Saved picks, read back.
pub(crate) fn saved_picks<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    saved(key).and_then(|d| serde_json::from_str(&d.text).ok())
}

thread_local! {
    /// What the file has, for the boxes that read it as they're made (a
    /// card's, a question's) without reaching the app, which may be busy
    /// drawing them.
    static SAVED: RefCell<HashMap<String, Draft>> = RefCell::new(HashMap::new());
}

/// A box's saved words and pictures, as it's made. None while a handover's
/// incoming app waits: they're the outgoing app's until it takes over.
pub(crate) fn saved(key: &str) -> Option<Draft> {
    if crate::handover::waiting() {
        return None;
    }
    SAVED.with(|s| s.borrow().get(key).cloned())
}

/// The saved card boxes for `card:<thread>:<seq>:`, by ask.
pub(crate) fn saved_card(thread: &str, seq: i64) -> Vec<(i64, Draft)> {
    if crate::handover::waiting() {
        return Vec::new();
    }
    let prefix = format!("card:{thread}:{seq}:");
    SAVED.with(|s| s.borrow().iter().filter_map(|(k, d)| Some((k.strip_prefix(&prefix)?.parse().ok()?, d.clone()))).collect())
}

fn set_saved(all: &HashMap<String, Draft>) {
    SAVED.with(|s| *s.borrow_mut() = all.clone());
}

/// The boxes of one thread's that aren't its message box, as they stand
/// now: each kind replaces what the file had for that thread, or leaves it
/// when it can't tell yet (its transcript not in).
#[derive(Default)]
pub(crate) struct ThreadBoxes {
    /// The open card's boxes, or none open (answered): `card:<thread>:`.
    pub(crate) card: Option<Vec<(String, Draft)>>,
    /// Questions' boxes: each one's key to its words, or None to drop it
    /// (the question's answered). Ones not listed are left as they are.
    pub(crate) questions: Vec<(String, Option<Draft>)>,
    /// The questions still waiting, once its whole transcript's in (none
    /// older left to load, so none waiting unseen): any other question's
    /// saved words go, as it was answered somewhere this app didn't see
    /// (another Mac, the phone, while this thread wasn't kept).
    pub(crate) open_questions: Option<std::collections::HashSet<String>>,
}

/// `all` with a thread's boxes put in.
pub(crate) fn merge_thread(all: &mut HashMap<String, Draft>, thread: &str, boxes: ThreadBoxes) {
    if let Some(card) = boxes.card {
        let (boxes, picks) = (format!("card:{thread}:"), format!("card-picks:{thread}:"));
        all.retain(|k, _| !k.starts_with(&boxes) && !k.starts_with(&picks));
        all.extend(card.into_iter().filter(|(_, d)| !d.is_empty()));
    }
    if let Some(open) = boxes.open_questions {
        let (words, picks) = (format!("question:{thread}:"), format!("question-picks:{thread}:"));
        all.retain(|k, _| k.strip_prefix(&words).or_else(|| k.strip_prefix(&picks)).is_none_or(|id| open.contains(id)));
    }
    for (key, draft) in boxes.questions {
        match draft.filter(|d| !d.is_empty()) {
            Some(d) => all.insert(key, d),
            None => all.remove(&key),
        };
    }
}

/// How long after the last keystroke it writes.
const PAUSE: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Draft {
    pub(crate) text: String,
    pub(crate) images: Vec<ImageRef>,
    pub(crate) backlog_revision: Option<i64>,
    pub(crate) attachments: Vec<threadbear_core::backlog::Attachment>,
}

impl Draft {
    pub(crate) fn is_empty(&self) -> bool {
        self.images.is_empty() && self.attachments.is_empty() && self.text.is_empty()
    }
}

#[derive(Default)]
pub(crate) struct Drafts {
    path: Option<PathBuf>,
    /// What the file had, for boxes not made yet this run.
    saved: HashMap<String, Draft>,
    pending: Option<Task<()>>,
    /// The last write failed: what's typed holds a restart, as it wouldn't
    /// come back (app_update.rs).
    pub(crate) failed: bool,
}

impl Drafts {
    pub(crate) fn load(home: &std::path::Path) -> Drafts {
        let path = home.join("desktop-drafts.json");
        let saved = read(&path);
        set_saved(&saved);
        Drafts { saved, path: Some(path), pending: None, failed: false }
    }
}

fn read(path: &std::path::Path) -> HashMap<String, Draft> {
    let Some(value) = std::fs::read(path).ok().and_then(|data| serde_json::from_slice::<Value>(&data).ok()) else { return HashMap::new() };
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, v)| {
            let draft = Draft { text: v["text"].as_str().unwrap_or("").to_owned(), images: v["images"].as_array().into_iter().flatten().filter_map(ImageRef::decode).collect(), backlog_revision: v["backlogRevision"].as_i64(), attachments: v["attachments"].as_array().into_iter().flatten().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect() };
            (!draft.is_empty()).then(|| (key.clone(), draft))
        })
        .collect()
}

/// Written whole and renamed into place, so a crash mid-write can't leave
/// half a file, and only ever readable by this user, the temp file too
/// (`private_file`); none at all when every box is empty.
fn write(path: &std::path::Path, all: &HashMap<String, Draft>) -> std::io::Result<()> {
    if all.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let value: serde_json::Map<String, Value> = all.iter().map(|(k, d)| (k.clone(), json!({ "text": d.text, "images": d.images.iter().map(image_ref_json).collect::<Vec<_>>(), "backlogRevision":d.backlog_revision,"attachments":d.attachments.iter().map(threadbear_core::backlog::Attachment::json).collect::<Vec<_>>() }))).collect();
    let data = serde_json::to_vec(&Value::Object(value)).map_err(std::io::Error::other)?;
    threadbear_core::private_file::write(path, &data)
}

impl Threadbear {
    pub(crate) fn composer_has_unsaved(&self, composer: &Entity<crate::composer::Composer>, cx: &App) -> bool {
        let c = composer.read(cx);
        match c.thread_id.as_ref().and_then(|id| self.threads.get(id)).and_then(|t| t.backlog.as_ref()) {
            Some(saved) => c.backlog_has_changes(saved, cx),
            None => c.holds_anything(cx),
        }
    }
    pub(crate) fn restore_backlog_draft(&mut self, id: &str, mut saved: threadbear_core::backlog::Draft, composer: &Entity<crate::composer::Composer>, cx: &mut Context<Self>) {
        if let Some(local) = self.drafts.saved.get(id).cloned() {
            let already_saved = threadbear_core::composer::message_text(&local.text, 1) == saved.text && local.images == saved.images && local.attachments == saved.attachments;
            if already_saved {
                self.drafts.saved.remove(id);
            } else if local.backlog_revision == Some(saved.revision) {
                saved.text = threadbear_core::composer::message_text(&local.text, 1);
                saved.images = local.images;
                saved.attachments = local.attachments;
            } else {
                // Keep a conflicting local edit available through the drafts
                // file instead of overwriting either version automatically.
                self.drafts.saved.insert(format!("conflict:{id}"), local);
                self.show_error("This task also has an older local edit, kept in desktop-drafts.json. Its saved prompt has been opened.".into(), cx);
            }
        }
        composer.update(cx, |c, cx| {
            c.backlog_attachments = saved.attachments;
            let (text, order) = threadbear_core::composer::edit_draft(&saved.text, saved.images.len());
            let images = order.into_iter().filter_map(|i| saved.images.get(i).cloned()).collect();
            c.restore_draft(RestoreDraft::plain(text, images), cx);
        });
    }
    /// A box's draft from before, put back as the box is made (`restore`).
    pub(crate) fn restore_saved_draft(&self, key: &str, composer: &Entity<crate::composer::Composer>, cx: &mut App) {
        // A handover's incoming app: the drafts are the outgoing app's until
        // it takes over (`reload_drafts`), as he may still be typing there.
        if crate::handover::waiting() {
            return;
        }
        if let Some(draft) = self.drafts.saved.get(key).cloned() {
            composer.update(cx, |c, cx| c.restore_draft(RestoreDraft::plain(draft.text, draft.images), cx));
        }
    }

    /// A handover's incoming app taking over: the drafts the outgoing app
    /// wrote as it handed over, into every box (none had its draft put back
    /// while it waited: `restore_saved_draft`).
    pub(crate) fn reload_drafts(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.drafts.path.clone() else { return };
        self.drafts.saved = read(&path);
        set_saved(&self.drafts.saved);
        let mut boxes: Vec<(String, Entity<crate::composer::Composer>)> = self.composers.iter().map(|(k, c)| (k.clone(), c.clone())).collect();
        if let Some(new) = &self.new_thread.composer {
            boxes.push((NEW_THREAD.to_owned(), new.clone()));
        }
        for (key, composer) in boxes {
            if !composer.read(cx).holds_anything(cx) {
                self.restore_saved_draft(&key, &composer, cx);
            }
            // The card's and questions' boxes, empty while it waited.
            composer.update(cx, |c, cx| c.restore_box_drafts(cx));
        }
    }

    /// A box changed: written a moment later, once typing pauses.
    pub(crate) fn drafts_changed(&mut self, cx: &mut Context<Self>) {
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PAUSE).await;
            this.update(cx, |this, cx| this.save_drafts(cx)).ok();
        });
        self.drafts.pending = Some(task);
    }

    /// Writes now: what every box has, and what the file had for boxes not
    /// made yet this run.
    pub(crate) fn save_drafts(&mut self, cx: &App) {
        self.drafts.pending = None;
        if crate::handover::waiting() {
            return;
        }
        let Some(path) = self.drafts.path.clone() else { return };
        let mut all = self.drafts.saved.clone();
        let mut boxes: Vec<(String, Entity<crate::composer::Composer>)> = self.composers.iter().map(|(k, c)| (k.clone(), c.clone())).collect();
        if let Some(new) = &self.new_thread.composer {
            boxes.push((NEW_THREAD.to_owned(), new.clone()));
        }
        for (key, composer) in boxes {
            let c = composer.read(cx);
            if self.threads.get(&key).is_some_and(|t| t.backlog.is_some()) && !self.composer_has_unsaved(&composer, cx) {
                all.remove(&key);
                continue;
            }
            let (text, images) = c.draft_for_saving(cx);
            if key != NEW_THREAD { merge_thread(&mut all, &key, c.box_drafts(cx)); }
            let draft = Draft { text, images, backlog_revision: self.threads.get(&key).and_then(|t| t.backlog.as_ref()).map(|d| d.revision), attachments: c.backlog_attachments.clone() };
            if draft.is_empty() {
                all.remove(&key);
            } else {
                all.insert(key, draft);
            }
        }
        self.drafts.failed = write(&path, &all).inspect_err(|e| eprintln!("threadbear: couldn't save the drafts: {e}")).is_err();
        set_saved(&all);
        self.drafts.saved = all;
    }
}

#[cfg(test)]
mod tests {
    use super::{card_key, merge_thread, question_key, read, write, Draft, ThreadBoxes};
    use std::collections::HashMap;
    use threadbear_core::reducer::ImageRef;

    #[test]
    fn drafts_go_round_and_an_empty_set_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-drafts.json");
        let mut all = HashMap::new();
        all.insert("t1".to_owned(), Draft { text: "half a thought \u{FFFC}".into(), images: vec![ImageRef::new("/tmp/a.png", "image/png")], ..Default::default() });
        write(&path, &all).unwrap();
        assert_eq!(read(&path), all);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        write(&path, &HashMap::new()).unwrap();
        assert!(!path.exists());
    }

    fn words(text: &str) -> Draft {
        Draft { text: text.into(), images: Vec::new(), ..Default::default() }
    }

    // A card's and a question's boxes go in under their own keys, each
    // thread's card replaced whole (the old card's gone once a new one's
    // open), a question dropped once answered, and what a thread can't say
    // yet left alone.
    #[test]
    fn a_threads_card_and_question_boxes_merge_in() {
        let mut all = HashMap::new();
        all.insert("t1".to_owned(), words("message box"));
        all.insert(card_key("t1", 4, 0), words("old card"));
        all.insert(card_key("t2", 9, 1), words("other thread"));
        all.insert(question_key("t1", "q-done"), words("answered"));
        all.insert(question_key("t1", "q-later"), words("not drawn yet"));
        all.insert(super::question_picks_key("t1", "q-gone"), words("{}"));
        all.insert(super::card_picks_key("t1", 4), words("{}"));
        let boxes = ThreadBoxes {
            card: Some(vec![(card_key("t1", 7, 0), words("not before Friday")), (card_key("t1", 7, 1), words("  "))]),
            questions: vec![(question_key("t1", "q-done"), None), (question_key("t1", "q-open"), Some(words("the blue one")))],
            // q-gone was answered elsewhere: it isn't waiting any more.
            open_questions: Some(["q-open", "q-later"].into_iter().map(str::to_owned).collect()),
        };
        merge_thread(&mut all, "t1", boxes);
        let mut keys: Vec<&str> = all.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["card:t1:7:0", "card:t2:9:1", "question:t1:q-later", "question:t1:q-open", "t1"]);
        assert_eq!(all["card:t1:7:0"].text, "not before Friday");
        // Can't tell yet: nothing of the thread's changes.
        let before = all.clone();
        merge_thread(&mut all, "t1", ThreadBoxes::default());
        assert_eq!(all, before);
        // The card answered: its boxes go.
        merge_thread(&mut all, "t1", ThreadBoxes { card: Some(Vec::new()), ..Default::default() });
        assert!(!all.contains_key("card:t1:7:0"));
    }
}
