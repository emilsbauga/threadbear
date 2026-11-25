// The header bar on a reply's code blocks: the language, and copy, with play
// before it on a ```bash block or an untagged one-liner (ShellBlockIcons.swift): play puts the command
// in the thread's Terminal, at its prompt and never run, and copy copies it.
// Play only shows where the Terminal would be the thread's own shell, in its
// own folder on this Mac (terminal.rs `can_put`). gpui-kit draws the bar in
// the flow at the top of the block (`code_block_header`).
use crate::style::{self, px};
use crate::terminal::PutOutcome;
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use threadbear_core::terminal::{self as rules, ShellBlock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Icon {
    Put,
    Copy,
}

impl Icon {
    fn symbol(self) -> &'static str {
        match self {
            Icon::Put => "play",
            Icon::Copy => "doc.on.doc",
        }
    }

    fn tip(self) -> &'static str {
        match self {
            Icon::Put => "Put in Terminal",
            Icon::Copy => "Copy",
        }
    }
}

/// How long an icon shows its tick, and the note that the Terminal was busy.
const TICK_FOR: Duration = Duration::from_millis(1500);
const NOTE_FOR: Duration = Duration::from_millis(2500);

/// When each icon of each command was last pressed, so it shows a tick for a
/// moment, and when one couldn't be typed and was copied instead. Read as
/// they're drawn; only touched on the app's own thread.
static PRESSED: Mutex<Vec<(Icon, String, Instant)>> = Mutex::new(Vec::new());
static BUSY: Mutex<Option<(String, Instant, &'static str)>> = Mutex::new(None);

fn mark(icon: Icon, command: &str) {
    let mut pressed = PRESSED.lock().unwrap_or_else(|e| e.into_inner());
    pressed.retain(|(_, _, at)| at.elapsed() < TICK_FOR);
    pressed.push((icon, command.to_owned(), Instant::now()));
}

fn unmark(icon: Icon, command: &str) {
    PRESSED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(i, c, _)| !(*i == icon && c == command));
}

fn ticked(icon: Icon, command: &str) -> bool {
    PRESSED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(i, c, at)| *i == icon && c == command && at.elapsed() < TICK_FOR)
}

/// Why `command` was just copied rather than typed, while that's shown.
fn copied_because(command: &str) -> Option<&'static str> {
    BUSY.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(c, at, _)| c == command && at.elapsed() < NOTE_FOR)
        .map(|(_, _, why)| *why)
}

/// Everything drawn again once a tick or a note is due to go.
fn redraw_after(wait: Duration, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(wait + Duration::from_millis(50))
            .await;
        cx.update(|cx| cx.refresh_windows());
    })
    .detach();
}

/// A reply's text with a header bar across the top of each code block: the
/// language on the left, copy on the right, and play before it on a closed
/// shell block (Mike picked the bar from three mockups, 24 Nov). `source` is
/// the markdown the text was made from, for telling a block still streaming
/// in (no play: half a command mustn't be something you can run); `thread`
/// is the transcript's.
pub(crate) fn with_header(
    text: gpui_kit::base::TextView,
    source: &str,
    thread: &str,
) -> gpui_kit::base::TextView {
    let source: Arc<str> = source.into();
    let thread = thread.to_owned();
    text.code_block_header(move |block, _window, cx| {
        let code = block.code();
        let shell = ShellBlock::from(block.lang().as_deref(), &code).filter(|_| {
            block
                .span
                .is_some_and(|span| rules::fence_closed(&source, span.start, span.end))
        });
        let label = block.lang().and_then(|lang| language_name(&lang));
        header(label, shell.map(|s| s.command), &code, &thread, cx).into_any_element()
    })
}

/// What the header calls a fence's language: the common ones by their
/// proper names, anything else as written. Only the info string's first word.
pub(crate) fn language_name(info: &str) -> Option<String> {
    let word = info.split_whitespace().next()?;
    let name = match word.to_ascii_lowercase().as_str() {
        "ts" | "typescript" => "TypeScript",
        "tsx" => "TSX",
        "js" | "javascript" => "JavaScript",
        "jsx" => "JSX",
        "sql" => "SQL",
        "bash" => "Bash",
        "sh" | "shell" => "Shell",
        "zsh" => "Zsh",
        "json" => "JSON",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "rust" | "rs" => "Rust",
        "swift" => "Swift",
        "kotlin" | "kt" => "Kotlin",
        "python" | "py" => "Python",
        "go" => "Go",
        "html" => "HTML",
        "css" => "CSS",
        "md" | "markdown" => "Markdown",
        "diff" => "Diff",
        _ => return Some(word.to_owned()),
    };
    Some(name.to_owned())
}

/// The bar itself. It spans the block's padding, so it reaches the block's
/// edges; the code sits under it with the block's own padding.
fn header(
    label: Option<String>,
    command: Option<String>,
    code: &str,
    thread: &str,
    cx: &App,
) -> impl IntoElement {
    use crate::rows::metrics::CODE_PAD;
    let put = command.is_some() && crate::terminal::shows_put(thread, cx);
    // A shell block copies its command (prompts taken off), anything else
    // its code as it is.
    let copied = command.unwrap_or_else(|| code.to_owned());
    let busy = copied_because(&copied);
    let bar = h_flex()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(-CODE_PAD))
        .right(px(-CODE_PAD))
        .pl(px(CODE_PAD + 2.))
        .pr(px(5.))
        .gap(px(2.))
        .items_center()
        .rounded_t(px(7.))
        .bg(style::primary_opacity(cx, 0.03))
        .border_b_1()
        .border_color(style::hairline(cx))
        .font_family(cx.theme().font_family.clone())
        .text_size(px(style::size::DETAIL))
        .line_height(px(style::natural_line(style::size::DETAIL)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_color(style::secondary_text(cx))
                .whitespace_nowrap()
                .text_ellipsis()
                .children(label),
        )
        .when_some(busy, |row, why| {
            row.child(
                div()
                    .mr(px(4.))
                    .text_color(style::secondary_text(cx))
                    .whitespace_nowrap()
                    .child(why),
            )
        })
        .when(put, |row| row.child(icon(Icon::Put, &copied, thread, cx)))
        .child(icon(Icon::Copy, &copied, thread, cx));
    // In the flow it holds the bar's height over the code; the bar itself
    // reaches out over the block's padding to its edges, which a negative
    // margin alone can't do (the row kept the code's width, 24 Nov).
    div()
        .relative()
        .w_full()
        .flex_none()
        .h(px(30.))
        .mt(px(-CODE_PAD))
        .mb(px(CODE_PAD - 2.))
        .child(bar)
}

fn icon(which: Icon, command: &str, thread: &str, cx: &App) -> impl IntoElement {
    let ticked = ticked(which, command);
    let colour = if ticked {
        style::tick_green(cx)
    } else {
        style::secondary_text(cx)
    };
    let glyph = if ticked {
        crate::icons::symbol("checkmark")
    } else {
        crate::icons::symbol(which.symbol())
    };
    let (command, thread) = (command.to_owned(), thread.to_owned());
    let id = SharedString::from(format!(
        "shell-{}-{}",
        if which == Icon::Put { "put" } else { "copy" },
        hash(&command)
    ));
    let copied = ticked && which == Icon::Copy;
    div()
        .id(ElementId::Name(id))
        .flex_none()
        .h(px(24.))
        .min_w(px(24.))
        .when(copied, |d| d.px(px(6.)).gap(px(4.)))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.))
        .cursor_pointer()
        .text_color(colour)
        // A tick keeps its green under the pointer that just pressed it.
        .hover(|s| {
            let s = s.bg(style::primary_opacity(cx, 0.1));
            if ticked {
                s
            } else {
                s.text_color(style::label_text(cx))
            }
        })
        .role(Role::Button)
        .aria_label(SharedString::from(which.tip()))
        .tip(which.tip())
        // Not the start of a text selection in the block under it.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| press(which, &command, &thread, window, cx))
        // SF Symbols at 12 pt, as ShellBlockIcons draws them.
        .child(glyph.with_size(px(style::size::DETAIL)))
        .when(copied, |d| d.child("Copied"))
        .test_support()
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash as _, Hasher as _};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// A press: the tick shows at once. Copy copies; play puts the command in the
/// thread's Terminal (bringing the panel up), and if the shell's busy with
/// something, or someone's own words are on its prompt, copies it instead and
/// says so (TranscriptTextView.press).
fn press(which: Icon, command: &str, thread: &str, window: &mut Window, cx: &mut App) {
    if which == Icon::Copy {
        mark(which, command);
        window.refresh();
        redraw_after(TICK_FOR, cx);
        cx.write_to_clipboard(ClipboardItem::new_string(command.to_owned()));
        return;
    }
    put(command, thread, window, cx);
}

/// Play's press, and the automation's `put`: the command at the thread's
/// prompt, or copied when the shell's busy.
pub(crate) fn put(command: &str, thread: &str, window: &mut Window, cx: &mut App) {
    mark(Icon::Put, command);
    window.refresh();
    redraw_after(TICK_FOR, cx);
    let Some(app) = crate::terminal::app(cx) else {
        return;
    };
    let block = ShellBlock {
        command: command.to_owned(),
    };
    let Some(task) = app.update(cx, |a, cx| {
        crate::terminal::put_in_terminal(a, block, thread, window, cx)
    }) else {
        return;
    };
    let command = command.to_owned();
    cx.spawn(async move |cx| {
        let why = match task.await {
            Some(PutOutcome::Busy) => "Terminal's in use, so it's copied",
            Some(PutOutcome::Occupied) => "Another command's waiting for Return, so it's copied",
            _ => return,
        };
        cx.update(|cx| {
            unmark(Icon::Put, &command);
            cx.write_to_clipboard(ClipboardItem::new_string(command.clone()));
            *BUSY.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((command.clone(), Instant::now(), why));
            cx.refresh_windows();
            redraw_after(NOTE_FOR, cx);
        });
    })
    .detach();
}

/// What each closed shell block in a reply offers, for the dump: "[put, copy]
/// npm test", or "[copy] npm test" where the Terminal wouldn't be the
/// thread's own (AppDump's `shellBlocks`).
#[cfg(feature = "automation")]
pub(crate) fn dump_lines(text: &str, thread: &str, cx: &App) -> Option<Vec<String>> {
    let blocks = rules::shell_blocks(text);
    if blocks.is_empty() {
        return None;
    }
    let icons = if crate::terminal::shows_put(thread, cx) {
        "[put, copy]"
    } else {
        "[copy]"
    };
    Some(
        blocks
            .into_iter()
            .map(|b| format!("{icons} {}", b.command))
            .collect(),
    )
}

#[cfg(test)]
mod language_tests {
    use super::language_name;

    #[test]
    fn common_fences_get_their_proper_names() {
        assert_eq!(language_name("ts").as_deref(), Some("TypeScript"));
        assert_eq!(language_name("SQL").as_deref(), Some("SQL"));
        assert_eq!(language_name("rust title=x").as_deref(), Some("Rust"));
        assert_eq!(language_name("elixir").as_deref(), Some("elixir"));
        assert_eq!(language_name(""), None);
    }
}
