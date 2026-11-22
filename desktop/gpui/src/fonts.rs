//! Fonts the app carries inside its binary, so a choice in Settings >
//! General > Appearance > Font looks the same on every machine without
//! anyone installing anything.
//!
//! Allo (https://allo.joshpuckett.me, OFL 1.1, licence in fonts/allo): the
//! static OTFs for the weights the app draws in, plus obliques for the
//! italics in replies. Not the variable font: GPUI can't set its roundness
//! axis, and the static files are a fifth of its size.

use std::borrow::Cow;

use gpui_kit::App;

macro_rules! font {
    ($file:literal) => {
        Cow::Borrowed(include_bytes!(concat!("../fonts/allo/", $file)).as_slice())
    };
}

/// Allo's upright files by weight, for a page the app makes itself to
/// carry the same font (review_pane.rs): a web view can't see a font GPUI
/// was only handed.
pub fn allo_weights() -> [(u16, &'static [u8]); 4] {
    [
        (
            400,
            include_bytes!("../fonts/allo/Allo-Regular.otf").as_slice(),
        ),
        (
            500,
            include_bytes!("../fonts/allo/Allo-Medium.otf").as_slice(),
        ),
        (
            600,
            include_bytes!("../fonts/allo/Allo-SemiBold.otf").as_slice(),
        ),
        (
            700,
            include_bytes!("../fonts/allo/Allo-Bold.otf").as_slice(),
        ),
    ]
}

pub fn register(cx: &App) {
    let fonts = vec![
        font!("Allo-Regular.otf"),
        font!("Allo-Oblique.otf"),
        font!("Allo-Medium.otf"),
        font!("Allo-SemiBold.otf"),
        font!("Allo-Bold.otf"),
        font!("Allo-BoldOblique.otf"),
    ];
    // A font that won't load leaves the choice falling back to the system's.
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        threadbear_client::log::write("fonts", &format!("bundled fonts did not load: {error:#}"));
    }
}
