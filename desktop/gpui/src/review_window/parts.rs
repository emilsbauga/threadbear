// Small pieces more than one part of the review window draws: a tick box, the
// agent's star, a shot's thumbnail. Their own module, so the band, the stage
// and the canvas that share them don't need each other (deslop-please's
// module-cycle).
use crate::style;
use gpui_kit::component::{h_flex, Icon, IconName, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use threadbear_core::reducer::ImageRef;

use crate::style::px;

/// A tick box: an outline, or filled with the accent and a white tick.
pub(crate) fn checkbox(on: bool, accent: Hsla, cx: &App) -> AnyElement {
    if on {
        return div()
            .size(px(14.))
            .rounded(px(3.5))
            .bg(accent)
            .flex()
            .items_center()
            .justify_center()
            .child(
                Icon::new(IconName::Check)
                    .with_size(px(11.))
                    .text_color(gpui_kit::white()),
            )
            .into_any_element();
    }
    div()
        .size(px(14.))
        .rounded(px(3.5))
        .border(px(1.2))
        .border_color(style::secondary_text(cx))
        .into_any_element()
}

/// The agent's pick: a small gold star and "Recommended" in grey, as on an
/// asks card (after Ghostex's, Mike, 9 Nov).
pub(crate) fn recommended_mark(cx: &App) -> AnyElement {
    // On the name's line, as the Swift mark is text run on from the name.
    h_flex()
        .flex_none()
        .gap(px(3.))
        .items_center()
        .child(
            crate::icons::symbol("star.fill")
                .with_size(px(11.))
                .text_color(style::recommended_star(cx)),
        )
        .child(
            div()
                .text_size(px(style::size::DETAIL))
                .line_height(px(style::natural_line(style::size::WORK)))
                .text_color(style::secondary_text(cx))
                .child("Recommended"),
        )
        .into_any_element()
}

/// A shot small, cropped from its top left, where a mockup's title and
/// controls are, rather than squashed (`ReviewThumb`).
pub(crate) fn thumb(image: &ImageRef, width: f32, height: f32, radius: f32, cx: &App) -> Div {
    let (w, h) = pixels(image);
    let scale = (f64::from(width) / w).max(f64::from(height) / h);
    div()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .rounded(px(radius))
        .overflow_hidden()
        .bg(style::primary_opacity(cx, 0.08))
        .child(
            img(crate::rows::markdown::file_picture(&image.path))
                .w(px((w * scale) as f32))
                .h(px((h * scale) as f32))
                .object_fit(ObjectFit::Fill),
        )
}

/// A shot's size in pixels, or a mockup's usual size when it doesn't say.
pub(crate) fn pixels(image: &ImageRef) -> (f64, f64) {
    match (image.width, image.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w as f64, h as f64),
        _ => (1100., 760.),
    }
}
