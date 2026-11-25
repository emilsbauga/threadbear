//! The small text and icon pieces every kind of row draws with: an icon,
//! monospaced runs, "key: value" fields and the "+12 −3" stats. Their own
//! module, so the work lines, cards and diffs that share them don't need
//! each other (deslop-please's module-cycle).

use crate::style::{self, size};
use gpui_kit::base::SelectableText;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::style::px;
use threadbear_core::reducer::{Field, ToolPresentation};

/// The SVG bytes of the Lucide icon standing in for an SF Symbol, from the
/// kit's own catalog (its `Assets` only carries 101 of them). A name map
/// like this belongs in icons.rs once that exists.
pub(crate) fn lucide(symbol: &str) -> &'static [u8] {
    use gpui_kit::assets::__private as lucide;
    match symbol {
        "brain" => lucide::Brain.1,
        "terminal" => lucide::Terminal.1,
        "square.dashed" => lucide::SquareDashed.1,
        "photo" => lucide::Image.1,
        "doc.text" => lucide::FileText.1,
        "pencil.line" => lucide::PencilLine.1,
        // The pencil by Mike's messages: missing, it fell to the circle below,
        // and the edit control read as a stray ring (12 Nov).
        "pencil" => lucide::Pencil.1,
        "square.and.pencil" => lucide::SquarePen.1,
        "magnifyingglass" => lucide::Search.1,
        "globe" => lucide::Globe.1,
        "puzzlepiece.extension" => lucide::Puzzle.1,
        "person.2" => lucide::Users.1,
        "checklist" => lucide::ListChecks.1,
        "wrench.and.screwdriver" => lucide::Wrench.1,
        "hammer" => lucide::Hammer.1,
        "xmark.circle" | "xmark.circle.fill" => lucide::CircleX.1,
        "checkmark.circle" | "checkmark.circle.fill" => lucide::CircleCheck.1,
        "checkmark" => lucide::Check.1,
        "clock" => lucide::Clock.1,
        "lock" => lucide::Lock.1,
        "lock.shield" => lucide::ShieldCheck.1,
        "info.circle" => lucide::Info.1,
        "chevron.right" => lucide::ChevronRight.1,
        "chevron.down" => lucide::ChevronDown.1,
        "exclamationmark.triangle" => lucide::TriangleAlert.1,
        "pawprint" => lucide::PawPrint.1,
        "rectangle.on.rectangle" => lucide::Images.1,
        "doc.on.doc" => lucide::Copy.1,
        _ => lucide::Circle.1,
    }
}

/// An SF Symbol's stand-in at `side` points, in `color`.
pub(crate) fn icon(symbol: &str, side: f32, color: Hsla) -> Icon {
    Icon::default()
        .data(lucide(symbol))
        .size(px(side))
        .text_color(color)
}

/// `statsText`: "+12 −3" in the stats font, for a diff row and a changes card.
pub(crate) fn stats_text(added: i64, removed: i64, added_color: Hsla, removed_color: Hsla) -> Div {
    h_flex()
        .flex_none()
        .text_size(px(size::DETAIL))
        .child(div().text_color(added_color).child(format!("+{added}")))
        .child(
            div()
                .text_color(removed_color)
                .ml(px(4.))
                .child(format!("−{removed}")),
        )
}

/// One monospaced run in the output font.
pub(crate) fn mono_text(
    id: impl Into<ElementId>,
    words: impl Into<SharedString>,
    color: Hsla,
    cx: &App,
) -> Stateful<Div> {
    mono_block(id, cx)
        .text_color(color)
        .child(SelectableText::new("t", words.into()))
}

pub(crate) fn mono_block(id: impl Into<ElementId>, cx: &App) -> Stateful<Div> {
    div()
        .id(id.into())
        .font_family(cx.theme().mono_font_family.clone())
        .text_size(px(size::CODE))
        .line_height(px(size::CODE_LINE))
        .min_w_0()
}

/// `fieldsText`: "key:  value" with the values in one column, long values
/// wrapping under their value.
pub(crate) fn fields_text(ix: usize, fields: &[Field], cx: &App) -> Div {
    let key_width = ToolPresentation::key_width(fields, 16);
    let column = (key_width + 2) as f32 * DIGIT_WIDTH;
    let (faint, label) = (style::faint_text(cx), style::label_text(cx));
    let mut col = v_flex();
    for (i, field) in fields.iter().enumerate() {
        let label_text = format!("{}:", field.key);
        let runs_over = label_text.chars().count() > key_width;
        col = col.child(
            h_flex()
                .items_start()
                .child(
                    mono_text(
                        ("fkey", ix * 100 + i),
                        if runs_over {
                            format!("{label_text} ")
                        } else {
                            label_text
                        },
                        faint,
                        cx,
                    )
                    .flex_none()
                    .when(!runs_over, |d| d.w(px(column))),
                )
                .child(mono_text(("fval", ix * 100 + i), field.value.clone(), label, cx).flex_1()),
        );
    }
    col
}

/// Monospaced digit width at the code size: columns of numbers and field keys
/// line up by count of characters.
pub(crate) const DIGIT_WIDTH: f32 = 7.83;
