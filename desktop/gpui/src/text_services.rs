// The Mac's text services for the app's own text: the spell checker that
// marks and corrects words in the message box (NSSpellChecker), Edit >
// Speech (NSSpeechSynthesizer), and which words are selected right now, for
// those and for Services and Look Up (thread 0ff64630 uses
// `front_selection` and `replace_if_unchanged` for those).
//
// The Swift app got all of this from NSTextView. GPUI's text boxes aren't
// one, so the spell checker is asked directly and its answers drawn by the
// kit's textarea (`set_text_marks`, our patch in desktop/vendor). What's done
// with the answers is threadbear_core::spelling. Off a Mac there's no spell
// checker or speech here: every call finds nothing and does nothing, and the
// Edit menu leaves those items out.
use gpui_kit::component::input::TextareaState;
use gpui_kit::*;
use serde::{Deserialize, Serialize};
use std::ops::Range;
use threadbear_core::spelling::Found;

/// The Edit menu's switches for the message box, kept between runs (prefs).
/// Spelling while typing is on, grammar off, and quotes and dashes off as the
/// Swift composer had them (`isAutomaticQuoteSubstitutionEnabled = false`);
/// correction and text replacement follow the Mac's own Keyboard settings
/// until they're switched here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Checks {
    pub spelling: bool,
    pub grammar: bool,
    pub correct: Option<bool>,
    pub quotes: bool,
    pub dashes: bool,
    pub replace: Option<bool>,
}

impl Default for Checks {
    fn default() -> Self {
        Checks { spelling: true, grammar: false, correct: None, quotes: false, dashes: false, replace: None }
    }
}

impl Checks {
    pub fn correct(&self) -> bool {
        self.correct.unwrap_or_else(system_correction)
    }
    pub fn replace(&self) -> bool {
        self.replace.unwrap_or_else(system_replacement)
    }
    /// Whether anything is checked as words are typed.
    pub fn any_substitution(&self) -> bool {
        self.correct() || self.replace() || self.quotes || self.dashes
    }
}

/// Whether the spell checker and speech are here at all.
pub(crate) const AVAILABLE: bool = cfg!(target_os = "macos");

/// Longer than this, the box isn't checked as it's typed (a pasted log):
/// each check reads the whole text.
pub(crate) const MAX_CHECKED: usize = 20_000;

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::rc::Retained;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString, NSTextCheckingType};
    use threadbear_core::spelling::{byte_of_utf16, utf16_of_byte, Kind};

    thread_local! {
        /// One spell document for the app's text boxes, so Ignore Spelling
        /// lasts while the app runs, as an NSTextView's does for its window.
        static TAG: isize = NSSpellChecker::uniqueSpellDocumentTag();
        #[allow(deprecated)]
        static VOICE: Retained<objc2_app_kit::NSSpeechSynthesizer> = objc2_app_kit::NSSpeechSynthesizer::new();
    }

    fn checker() -> Retained<NSSpellChecker> {
        NSSpellChecker::sharedSpellChecker()
    }

    fn ns_range(text: &str, range: Range<usize>) -> NSRange {
        let start = utf16_of_byte(text, range.start);
        NSRange { location: start, length: utf16_of_byte(text, range.end) - start }
    }

    pub fn check(text: &str, within: Range<usize>, checks: &Checks, typing: bool) -> Vec<Found> {
        let mut types = NSTextCheckingType::empty();
        if checks.spelling || !typing {
            types |= NSTextCheckingType::Spelling;
        }
        if checks.grammar {
            types |= NSTextCheckingType::Grammar;
        }
        if typing {
            if checks.correct() {
                types |= NSTextCheckingType::Correction;
            }
            if checks.replace() {
                types |= NSTextCheckingType::Replacement;
            }
            if checks.quotes {
                types |= NSTextCheckingType::Quote;
            }
            if checks.dashes {
                types |= NSTextCheckingType::Dash;
            }
        }
        if types.is_empty() || text.is_empty() {
            return Vec::new();
        }
        let string = NSString::from_str(text);
        let tag = TAG.with(|t| *t);
        // SAFETY: no options, no orthography wanted, and a null word count,
        // which the method takes as "don't count".
        let results = unsafe { checker().checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(&string, ns_range(text, within), types.0, None, tag, None, std::ptr::null_mut()) };
        let mut found = Vec::new();
        for result in results.iter() {
            let kind = match result.resultType() {
                t if t == NSTextCheckingType::Spelling => Kind::Spelling,
                t if t == NSTextCheckingType::Grammar => Kind::Grammar,
                t if t == NSTextCheckingType::Correction => Kind::Correction,
                t if t == NSTextCheckingType::Replacement => Kind::Replacement,
                t if t == NSTextCheckingType::Quote => Kind::Quote,
                t if t == NSTextCheckingType::Dash => Kind::Dash,
                _ => continue,
            };
            let r = result.range();
            let range = byte_of_utf16(text, r.location)..byte_of_utf16(text, r.location + r.length);
            let replacement = result.replacementString().map(|s| s.to_string());
            found.push(Found { range, kind, replacement });
        }
        // A plain check doesn't always offer corrections; AppKit's own
        // autocorrect asks for the one of the word just ended, so this does
        // too: the last misspelled word in what was checked.
        if typing && checks.correct() && !found.iter().any(|f| f.kind == Kind::Correction) {
            if let Some(word) = found.iter().filter(|f| f.kind == Kind::Spelling).max_by_key(|f| f.range.end).cloned() {
                let checker = checker();
                let language = checker.language();
                if let Some(with) = checker.correctionForWordRange_inString_language_inSpellDocumentWithTag(ns_range(text, word.range.clone()), &string, &language, tag) {
                    found.push(Found { range: word.range, kind: Kind::Correction, replacement: Some(with.to_string()) });
                }
            }
        }
        found
    }

    pub fn guesses(text: &str, range: Range<usize>) -> Vec<String> {
        let string = NSString::from_str(text);
        let tag = TAG.with(|t| *t);
        checker()
            .guessesForWordRange_inString_language_inSpellDocumentWithTag(ns_range(text, range), &string, None, tag)
            .map(|list| list.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    pub fn learn(word: &str) {
        checker().learnWord(&NSString::from_str(word));
    }

    pub fn ignore(word: &str) {
        let tag = TAG.with(|t| *t);
        checker().ignoreWord_inSpellDocumentWithTag(&NSString::from_str(word), tag);
    }

    #[allow(deprecated)]
    pub fn speak(text: &str) {
        VOICE.with(|v| {
            v.stopSpeaking();
            v.startSpeakingString(&NSString::from_str(text));
        });
    }

    #[allow(deprecated)]
    pub fn stop_speaking() {
        VOICE.with(|v| v.stopSpeaking());
    }

    #[allow(deprecated)]
    pub fn speaking() -> bool {
        VOICE.with(|v| v.isSpeaking())
    }

    pub fn system_correction() -> bool {
        NSSpellChecker::isAutomaticSpellingCorrectionEnabled()
    }

    pub fn system_replacement() -> bool {
        NSSpellChecker::isAutomaticTextReplacementEnabled()
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::*;
    pub fn check(_: &str, _: Range<usize>, _: &Checks, _: bool) -> Vec<Found> {
        Vec::new()
    }
    pub fn guesses(_: &str, _: Range<usize>) -> Vec<String> {
        Vec::new()
    }
    pub fn learn(_: &str) {}
    pub fn ignore(_: &str) {}
    pub fn speak(_: &str) {}
    pub fn stop_speaking() {}
    pub fn speaking() -> bool {
        false
    }
    pub fn system_correction() -> bool {
        false
    }
    pub fn system_replacement() -> bool {
        false
    }
}

/// What the spell checker finds in `within` (byte offsets) of `text`.
/// `typing`: as words are typed, with the corrections and substitutions
/// switched on; otherwise (Check Document Now) spelling, and grammar if on.
pub(crate) fn check(text: &str, within: Range<usize>, checks: &Checks, typing: bool) -> Vec<Found> {
    mac::check(text, within, checks, typing)
}

/// The spell checker's suggestions for the word at `range`, best first.
pub(crate) fn guesses(text: &str, range: Range<usize>) -> Vec<String> {
    mac::guesses(text, range)
}

/// Learn Spelling: never marked again, in any app.
pub(crate) fn learn(word: &str) {
    mac::learn(word)
}

/// Ignore Spelling: not marked again while the app runs.
pub(crate) fn ignore(word: &str) {
    mac::ignore(word)
}

/// Edit > Speech > Start Speaking, in the Mac's spoken-content voice.
pub(crate) fn speak(text: &str) {
    mac::speak(text)
}

pub(crate) fn stop_speaking() {
    mac::stop_speaking()
}

pub(crate) fn speaking() -> bool {
    mac::speaking()
}

/// Keyboard settings' "Correct spelling automatically".
pub(crate) fn system_correction() -> bool {
    mac::system_correction()
}

/// Whether the Mac's text replacements are on (Keyboard > Text Input).
pub(crate) fn system_replacement() -> bool {
    mac::system_replacement()
}

/// Where the selected words are.
#[derive(Clone)]
// For Services and Look Up (thread 0ff64630), which come after.
#[allow(dead_code)]
pub(crate) enum SelectionSource {
    /// A text box (the message box): `range` is what was selected, in bytes.
    TextBox { input: WeakEntity<TextareaState>, range: Range<usize> },
    /// The open thread's replies. Read only.
    Reply,
}

thread_local! {
    /// The app's text boxes that take part (each composer registers its own).
    static BOXES: std::cell::RefCell<Vec<WeakEntity<TextareaState>>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Count a text box in for `front_selection`.
pub(crate) fn register_text_box(input: &Entity<TextareaState>) {
    BOXES.with_borrow_mut(|boxes| {
        boxes.retain(|b| b.upgrade().is_some());
        boxes.push(input.downgrade());
    });
}

/// The text box with the keyboard in `window`, if it's one of the app's.
// For Services and Look Up (thread 0ff64630), which come after.
#[allow(dead_code)]
pub(crate) fn focused_text_box(window: &Window, cx: &App) -> Option<Entity<TextareaState>> {
    BOXES.with_borrow(|boxes| boxes.iter().filter_map(|b| b.upgrade()).find(|b| b.read(cx).focus_handle(cx).is_focused(window)))
}

/// The words selected now, and where: the text box with the keyboard if it
/// has a selection, otherwise the words selected in a reply. `None` with
/// nothing selected.
// For Services and Look Up (thread 0ff64630), which come after.
#[allow(dead_code)]
pub(crate) fn front_selection(window: &mut Window, cx: &mut App) -> Option<(String, SelectionSource)> {
    if let Some(input) = focused_text_box(window, cx) {
        let state = input.read(cx);
        let range = state.selected_range();
        if !range.is_empty() {
            let text = state.value().get(range.clone()).unwrap_or_default().to_owned();
            return Some((text, SelectionSource::TextBox { input: input.downgrade(), range }));
        }
        return None;
    }
    let words = gpui_kit::base::TextSelection::selected_text(window, cx);
    (!words.is_empty()).then(|| (words.to_string(), SelectionSource::Reply))
}

/// Put `with` in place of the selection `source` names, only if it's still
/// that same text box, with that same range selected, holding `expected`:
/// a Service's answer never lands somewhere the keyboard moved to since.
/// It's one edit Undo takes back. `false` when nothing was changed.
// For Services and Look Up (thread 0ff64630), which come after.
#[allow(dead_code)]
pub(crate) fn replace_if_unchanged(source: &SelectionSource, expected: &str, with: &str, window: &mut Window, cx: &mut App) -> bool {
    let SelectionSource::TextBox { input, range } = source else { return false };
    let Some(input) = input.upgrade() else { return false };
    input.update(cx, |state, cx| {
        if state.selected_range() != *range || state.value().get(range.clone()) != Some(expected) {
            return false;
        }
        state.replace(with.to_owned(), window, cx);
        true
    })
}
