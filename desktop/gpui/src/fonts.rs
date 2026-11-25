//! Fonts the app carries inside its binary, so a choice in Settings >
//! General > Appearance > Font looks the same on every machine without
//! anyone installing anything.
//!
//! Allo (https://allo.joshpuckett.me, OFL 1.1, licence in fonts/allo): the
//! static OTFs for the weights the app draws in, plus obliques for the
//! italics in replies. Not the variable font: GPUI can't set its roundness
//! axis, and the static files are a fifth of its size.
//!
//! Caveat (https://github.com/googlefonts/caveat, OFL 1.1, licence in
//! fonts/caveat), bold: the agent's handwritten notes on a review's pictures
//! (the review canvas), after the Convex Explained doodle kit.

use std::borrow::Cow;

use gpui_kit::App;

macro_rules! font {
    ($file:literal) => {
        Cow::Borrowed(include_bytes!(concat!("../fonts/allo/", $file)).as_slice())
    };
}

pub fn register(cx: &App) {
    let fonts = vec![
        font!("Allo-Regular.otf"),
        font!("Allo-Oblique.otf"),
        font!("Allo-Medium.otf"),
        font!("Allo-SemiBold.otf"),
        font!("Allo-Bold.otf"),
        font!("Allo-BoldOblique.otf"),
        Cow::Borrowed(include_bytes!("../fonts/caveat/Caveat-Bold.ttf").as_slice()),
    ];
    // A font that won't load leaves the choice falling back to the system's.
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        threadbear_client::log::write("fonts", &format!("bundled fonts did not load: {error:#}"));
    }
}

/// The family the agent's notes on a review's pictures are written in.
pub const HANDWRITING: &str = "Caveat";
