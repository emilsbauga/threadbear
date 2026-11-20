// The little previews on Highlights' Files rows (Mike picked "thumbnail in
// the row" on 17 Nov 2026, review 9ef132db): a picture shows itself, a video
// or PDF its system thumbnail, a text file its first lines, so the file he's
// after can be picked out at a glance. Everything else, another Mac's files
// and anything `preview_private` keeps to itself show the row's symbol in
// the same box.
//
// All the reading and decoding is one asset per file version, done off the
// main thread, one file at a time, through the same open gate the link cards
// use (`reply_links.rs`'s MediaThumbnail and first lines). The version is the
// highlight's `last_seq`: a file the agent writes again comes up again in the
// thread, so its preview is made again then, and drawing the pane never
// touches the disk.
use crate::highlights::Palette;
use crate::open_gate::{self, Origin};
use crate::style::px;
use gpui_kit::component::{v_flex, ActiveTheme as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::path::Path;
use std::sync::Arc;
use threadbear_core::highlights as hl;
use threadbear_core::open_policy as policy;
use threadbear_core::reply_links::{self as rules, PeekPicture};

/// The box, the same for every row so names line up.
pub(crate) const WIDTH: f32 = 56.;
pub(crate) const HEIGHT: f32 = 36.;
/// Pictures are made at twice the box, for a Retina screen.
const PIXELS: (u32, u32) = (2 * WIDTH as u32, 2 * HEIGHT as u32);
/// Pictures past this are left as their symbol: decoding one is the slow part.
const PICTURE_MAX_BYTES: usize = 40 * 1024 * 1024;

#[derive(Clone)]
pub(crate) enum Thumb {
    Picture(Arc<RenderImage>),
    Lines(Vec<String>),
    Symbol,
}

impl Thumb {
    /// For the dump: which kind of preview the row shows.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Thumb::Picture(_) => "picture",
            Thumb::Lines(_) => "lines",
            Thumb::Symbol => "symbol",
        }
    }
}

struct FileThumb;

impl Asset for FileThumb {
    type Source = (String, i64);
    type Output = Thumb;

    fn load((path, _version): Self::Source, cx: &mut App) -> impl std::future::Future<Output = Self::Output> + Send + 'static {
        let renderer = cx.svg_renderer();
        let background = cx.background_executor().clone();
        // One at a time, so a thread with forty videos doesn't start forty
        // system thumbnail requests at once.
        static ONE_AT_A_TIME: futures::lock::Mutex<()> = futures::lock::Mutex::new(());
        async move {
            let _turn = ONE_AT_A_TIME.lock().await;
            match background.spawn(async move { make(&path) }).await {
                Made::Png(bytes) => Image::from_bytes(ImageFormat::Png, bytes).to_image_data(renderer).map(Thumb::Picture).unwrap_or(Thumb::Symbol),
                Made::Lines(lines) => Thumb::Lines(lines),
                Made::Nothing => Thumb::Symbol,
            }
        }
    }
}

enum Made {
    Png(Vec<u8>),
    Lines(Vec<String>),
    Nothing,
}

/// The preview for `path`, on a worker.
fn make(path: &str) -> Made {
    if hl::preview_private(path, &crate::files::home_dir()) {
        return Made::Nothing;
    }
    match rules::peek_picture(path) {
        PeekPicture::Image => picture(path).map_or(Made::Nothing, Made::Png),
        PeekPicture::Thumbnail => {
            let Ok(meta) = policy::local_metadata(Path::new(path)) else { return Made::Nothing };
            if !meta.is_file() {
                return Made::Nothing;
            }
            open_gate::media_thumbnail(path, Origin::ThisMac, policy::media_version(&meta)).and_then(|png| shrunk(&png)).map_or(Made::Nothing, Made::Png)
        }
        PeekPicture::Lines => {
            let Ok(sample) = policy::local_read(Path::new(path), 2048) else { return Made::Nothing };
            match rules::first_lines(&sample, 12, 60) {
                // Blank lines carry nothing at this size.
                Some(lines) => Made::Lines(lines.into_iter().filter(|l| !l.trim().is_empty()).take(6).collect()),
                None => Made::Nothing,
            }
        }
        PeekPicture::Symbol => Made::Nothing,
    }
}

/// A picture file, read through the gate and made small.
fn picture(path: &str) -> Option<Vec<u8>> {
    let bytes = policy::local_read(Path::new(path), PICTURE_MAX_BYTES + 1).ok()?;
    if bytes.len() > PICTURE_MAX_BYTES {
        return None;
    }
    shrunk(&bytes)
}

/// Any picture's bytes as a small PNG filling the box (cropped, like the
/// row shows it). Limits keep a made-up giant from taking the memory.
fn shrunk(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?;
    let mut limits = image::Limits::default();
    // Any shape, a full-page phone shot too: max_alloc is what holds it.
    limits.max_image_width = Some(65_536);
    limits.max_image_height = Some(65_536);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let small = reader.decode().ok()?.resize_to_fill(PIXELS.0, PIXELS.1, image::imageops::FilterType::Triangle);
    let mut png = Vec::new();
    small.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}

/// The preview so far: None while it's being made (the symbol shows).
pub(crate) fn current(path: &str, version: i64, window: &mut Window, cx: &mut App) -> Option<Thumb> {
    window.use_asset::<FileThumb>(&(path.to_owned(), version), cx)
}

/// The box a Files row shows in place of its symbol.
pub(crate) fn element(path: &str, thumb: Option<&Thumb>, symbol: &str, p: Palette, cx: &App) -> AnyElement {
    let frame = div()
        .flex_none()
        .w(px(WIDTH))
        .h(px(HEIGHT))
        .rounded(px(5.))
        .overflow_hidden()
        .border_1()
        .border_color(p.hairline)
        .bg(crate::style::primary_opacity(cx, 0.05));
    match thumb {
        Some(Thumb::Picture(image)) => {
            let video = matches!(policy::media_kind(path), Some(policy::Media::Video));
            frame
                .relative()
                .child(img(ImageSource::Render(image.clone())).size_full().object_fit(ObjectFit::Cover))
                // A video says so, bottom left, as a play mark.
                .when(video, |f| {
                    f.child(
                        div()
                            .absolute()
                            .left(px(3.))
                            .bottom(px(3.))
                            .size(px(13.))
                            .rounded(px(3.))
                            .bg(gpui_kit::black().opacity(0.65))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(crate::highlights::icon("play", 7., gpui_kit::white())),
                    )
                })
                .into_any_element()
        }
        Some(Thumb::Lines(lines)) => {
            // A page of its first lines: too small to read, enough to tell a
            // script from a plan. A markdown heading reads as the title.
            let mut page = v_flex().size_full().px(px(4.)).py(px(3.)).gap(px(0.5)).overflow_hidden();
            for (i, line) in lines.iter().enumerate() {
                let heading = line.starts_with('#');
                let words = line.trim_start_matches('#').trim().to_owned();
                page = page.child(
                    div()
                        .text_size(px(4.5))
                        .line_height(px(5.5))
                        .flex_none()
                        .when(heading || i == 0, |d| d.font_weight(FontWeight::SEMIBOLD))
                        .text_color(if heading || i == 0 { p.fg } else { p.secondary })
                        .font_family(cx.theme().font_family.clone())
                        .child(words),
                );
            }
            frame.child(page).into_any_element()
        }
        _ => frame.flex().items_center().justify_center().child(crate::highlights::icon(symbol, 14., p.icon)).into_any_element(),
    }
}
