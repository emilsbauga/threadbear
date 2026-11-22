// The drafts Mike has changed in this thread's replies (draft_boxes.rs), as
// chips over the box: each goes on the end of his next message, but nothing
// in the box or on a decision card said so (Mike, 20 Nov: "it doesn't show
// up in the box that it's going to be sent as part of the message"). He
// picked the attachment chip from three mockups: "Your edited email · 2 lines
// changed", View to see it in its reply, × to put the agent's back (the
// box's Undo). His bubble shows the same chip once it's sent (rows.rs,
// `edited_drafts`).
use crate::composer::Composer;
use crate::draft_boxes::{self, PendingEdit};
use crate::style::{self, size};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use crate::tips::Tip as _;
use std::rc::Rc;
use threadbear_core::draft_block::DraftKind;

/// The chip's tip, and its buttons', which scripts find them by.
pub(crate) const CHIP_TIP: &str =
    "Goes with your next message, for the agent to use instead of its draft";
pub(crate) const VIEW_TIP: &str = "Show it in the reply";
pub(crate) const REMOVE_TIP: &str = "Put the agent's draft back";
/// The tip on the chip in his bubble once it's gone.
pub(crate) const SENT_TIP: &str =
    "Your version of the agent's draft, sent with this message for it to use";

/// The mark for a draft of this kind, on its chip.
pub(crate) fn kind_icon(kind: DraftKind, color: Hsla) -> AnyElement {
    match kind {
        // No envelope among the bundled icons; the text one reads as one.
        DraftKind::Email => div()
            .text_size(px(size::CHIP))
            .text_color(color)
            .child("\u{2709}\u{FE0E}")
            .into_any_element(),
        DraftKind::Slack => crate::icons::symbol("bubble.left")
            .with_size(px(11.))
            .text_color(color)
            .into_any_element(),
        DraftKind::Draft => crate::icons::symbol("doc.text")
            .with_size(px(11.))
            .text_color(color)
            .into_any_element(),
    }
}

/// The chip's shape, here and in his bubble: a rounded tag in the chip fill
/// with a hairline edge, as a picture's chip is.
pub(crate) fn chip_frame(id: impl Into<ElementId>, cx: &App) -> Stateful<Div> {
    h_flex()
        .id(id)
        .flex_none()
        .items_center()
        .gap(px(7.))
        .px(px(9.))
        .py(px(4.))
        .rounded(px(7.))
        .bg(style::chip_fill(cx))
        .border(gpui_kit::px(0.5))
        .border_color(style::hairline(cx))
        .text_size(px(size::CHIP))
        .line_height(px(style::natural_line(size::CHIP)))
}

/// "2 lines changed".
fn lines_changed(lines: usize) -> String {
    if lines == 1 {
        "1 line changed".to_owned()
    } else {
        format!("{lines} lines changed")
    }
}

/// What a chip's View does with the reply's row its draft is in.
pub(crate) type ViewDraft = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// A chip for each changed draft that goes with the next answer: its kind,
/// how many lines changed, View (where there's a thread to show it in) and
/// × to put the agent's back. Over the message box, and on a project page's
/// decision card, which sends the drafts with its answer too.
pub(crate) fn pending_chips(
    id: &'static str,
    drafts: Vec<PendingEdit>,
    view: Option<ViewDraft>,
    cx: &App,
) -> AnyElement {
    let (label, secondary, accent) = (
        style::label_text(cx),
        style::secondary_label(cx),
        style::accent(cx),
    );
    let mut row = h_flex().id(id).w_full().flex_wrap().gap(px(6.));
    for (index, draft) in drafts.into_iter().enumerate() {
        let PendingEdit {
            key,
            row: row_id,
            kind,
            lines,
        } = draft;
        let view = view.clone().map(|view| {
            div()
                .id(("draft-chip-view", index))
                .test_support()
                .role(Role::Button)
                .aria_label(VIEW_TIP)
                .cursor_pointer()
                .text_color(accent)
                .child("View")
                .tip(VIEW_TIP)
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    view(&row_id, window, cx);
                })
        });
        let remove = div()
            .id(("draft-chip-remove", index))
            .test_support()
            .role(Role::Button)
            .aria_label(REMOVE_TIP)
            .cursor_pointer()
            .child(
                gpui_kit::component::Icon::from(gpui_kit::assets::IconName::X)
                    .with_size(px(10.))
                    .text_color(secondary),
            )
            .tip(REMOVE_TIP)
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                // Redraws every window, so the chip goes with the edit.
                draft_boxes::undo_edit(&key, cx);
            });
        row = row.child(
            chip_frame(("draft-chip", index), cx)
                .test_support()
                .role(Role::Group)
                .aria_label(SharedString::from(kind.edited_label()))
                .tip(CHIP_TIP)
                .child(kind_icon(kind, secondary))
                .child(div().text_color(label).child(kind.edited_label()))
                .child(
                    div()
                        .text_color(secondary)
                        .child(format!("· {}", lines_changed(lines))),
                )
                .children(view)
                .child(remove),
        );
    }
    row.into_any_element()
}

impl Composer {
    /// The changed drafts that go with the next message: none while an older
    /// message is being edited, which goes without them.
    fn pending_drafts(&self, cx: &App) -> Vec<PendingEdit> {
        match (&self.thread_id, &self.editing) {
            (Some(thread), None) => draft_boxes::pending_edits(thread, cx),
            _ => Vec::new(),
        }
    }

    pub(crate) fn has_pending_drafts(&self, cx: &App) -> bool {
        !self.pending_drafts(cx).is_empty()
    }

    pub(crate) fn render_draft_chips(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let drafts = self.pending_drafts(cx);
        if drafts.is_empty() {
            return None;
        }
        let pane = self.pane.clone();
        let view: ViewDraft = Rc::new(move |row: &str, window: &mut Window, cx: &mut App| {
            if let Some(pane) = pane.upgrade() {
                pane.update(cx, |pane, cx| pane.reveal_row(row, window, cx));
            }
        });
        Some(pending_chips("draft-chips", drafts, Some(view), cx))
    }

    /// The chips as the dump's `composer.drafts`: "Your edited email · 1 line changed".
    #[cfg(feature = "automation")]
    pub(crate) fn draft_chip_lines(&self, cx: &App) -> Vec<String> {
        self.pending_drafts(cx)
            .into_iter()
            .map(|d| format!("{} · {}", d.kind.edited_label(), lines_changed(d.lines)))
            .collect()
    }
}
