// Pictures taller or wider than the GPU's texture atlas takes. GPUI puts
// every picture it draws into an atlas texture of at most 16384 px a side
// (gpui-pre-apple's metal_atlas.rs, DirectX's the same), and a picture that
// can't get a slot there draws nothing at all, with no error for an
// `img`'s fallback to show. A full-page phone screenshot at 2x (780 x 18,232)
// came out as empty grey boxes in show_options' review window (20 Nov 2026).
// So a picture over the limit is shrunk to just fit before it's drawn: the
// stage zooms, so it keeps as much detail as the GPU can hold.

use gpui_kit::{App, Asset, Global, ImageCacheError, ImageFormat, RenderImage, Window};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The longest side the atlas holds. wgpu (Linux) is held to its default
/// device limit, 8192, which some GPUs there don't go past.
pub(crate) const MAX_SIDE: u32 = if cfg!(target_os = "linux") {
    8192
} else {
    16384
};

/// Whether a picture of this size is too big to draw as it is.
pub(crate) fn too_big((width, height): (u32, u32)) -> bool {
    width > MAX_SIDE || height > MAX_SIDE
}

/// The size a picture is drawn at: as it is when it fits, otherwise shrunk,
/// keeping its shape, until its longest side is MAX_SIDE.
pub(crate) fn fitted((width, height): (u32, u32)) -> (u32, u32) {
    if !too_big((width, height)) {
        return (width, height);
    }
    let scale = f64::from(MAX_SIDE) / f64::from(width.max(height));
    let side = |n: u32| ((f64::from(n) * scale).round() as u32).clamp(1, MAX_SIDE);
    (side(width), side(height))
}

/// A picture's size from its header, without decoding it.
pub(crate) fn size_of(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// Decodes and shrinks a picture to `fitted`'s size, turned the way its
/// EXIF says (as gpui's own loader turns it). None when it can't be read (a
/// format this build doesn't decode), or it's too many pixels to decode and
/// shrink within MAX_PIXELS, whatever the file's size on disk.
fn shrunk(bytes: &[u8]) -> Option<image::RgbaImage> {
    use image::ImageDecoder as _;
    let (width, height) = size_of(bytes)?;
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }
    let (width, height) = fitted((picture.width(), picture.height()));
    Some(
        picture
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .into_rgba8(),
    )
}

/// The most pixels a picture may have to be shrunk: 128 million, 512 MB
/// decoded (a 780 x 18,000 phone shot is 14 million). Bigger shows the
/// picture's fallback (its "can't show" mark) rather than taking the memory.
const MAX_PIXELS: u64 = 128 * 1024 * 1024;

/// Encoded bytes ready for `Image::from_bytes`: as they are when the picture
/// fits (or its size can't be read, so gpui's own decoder has its go),
/// otherwise shrunk and re-encoded as a PNG. None for one too big that
/// can't be shrunk (TOO_BIG says so), which would only draw a blank box.
/// For pictures that arrive as bytes (the viewer's, another Mac's); run it
/// off the main thread, as shrinking takes a moment.
pub(crate) fn fit_bytes(format: ImageFormat, bytes: Vec<u8>) -> Option<(ImageFormat, Vec<u8>)> {
    if !size_of(&bytes).is_some_and(too_big) {
        return Some((format, bytes));
    }
    let small = shrunk(&bytes)?;
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    );
    small.write_with_encoder(encoder).ok()?;
    Some((ImageFormat::Png, png))
}

/// What shows in place of a picture `fit_bytes` couldn't shrink.
pub(crate) const TOO_BIG: &str = "This picture is too big to show here.";

/// A picture file read and drawn shrunk, for one `file_picture` found too
/// big, keyed by its path, size and time. Checked as
/// `checked_picture_bytes` checks Windows' pictures.
pub(crate) struct FittedPicture;

impl Asset for FittedPicture {
    type Source = FittedKey;
    type Output = Result<Arc<RenderImage>, ImageCacheError>;

    #[expect(
        clippy::manual_async_fn,
        reason = "an async fn would hold on to `cx`, and GPUI's Asset wants a future that's 'static"
    )]
    fn load(
        (path, _, _): Self::Source,
        _cx: &mut App,
    ) -> impl std::future::Future<Output = Self::Output> + Send + 'static {
        async move {
            let bytes = crate::rows::markdown::checked_picture_bytes(&path)?;
            // Drawn as it is, it would be a blank box: the fallback says
            // it can't be shown instead.
            let mut small = shrunk(&bytes).ok_or_else(|| std::io::Error::other(TOO_BIG))?;
            // GPUI's pictures are BGRA (as `Image::to_image_data` makes them).
            for pixel in small.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
            Ok(Arc::new(RenderImage::new(vec![image::Frame::new(small)])))
        }
    }
}

/// How much of a file is read for its size. A JPEG's size comes after its
/// EXIF and colour profile, which are at most a few hundred KB.
const HEADER_BYTES: u64 = 1024 * 1024;

type FittedKey = (PathBuf, u64, Option<std::time::SystemTime>);

/// Each path's newest FittedPicture, so the one before (the file since
/// written again) leaves gpui's asset cache, which otherwise keeps every
/// version's pixels, tens of MB each, for as long as the app runs.
#[derive(Default)]
struct Newest(std::collections::HashMap<PathBuf, FittedKey>);
impl Global for Newest {}

/// The shrunk picture for `file_picture`, loading it the first time.
pub(crate) fn use_fitted(
    key: &FittedKey,
    window: &mut Window,
    cx: &mut App,
) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
    let newest = &mut cx.default_global::<Newest>().0;
    if newest.len() > 500 {
        newest.clear();
    }
    if let Some(old) = newest
        .insert(key.0.clone(), key.clone())
        .filter(|old| old != key)
    {
        cx.remove_asset::<FittedPicture>(&old);
    }
    window.use_asset::<FittedPicture>(key, cx)
}

/// A picture file's size from its header, remembered by its size and time
/// (rows ask on every frame). None when it can't be read.
pub(crate) fn file_size(path: &Path, meta: &std::fs::Metadata) -> Option<(u32, u32)> {
    use std::sync::{LazyLock, Mutex};
    type Key = (PathBuf, u64, Option<std::time::SystemTime>);
    static SEEN: LazyLock<Mutex<std::collections::HashMap<Key, Option<(u32, u32)>>>> =
        LazyLock::new(Default::default);
    let key = (path.to_owned(), meta.len(), meta.modified().ok());
    if let Some(known) = SEEN.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return *known;
    }
    // A header's worth at most, read from a regular file: what's after it
    // never reaches the decoder, whatever is at the path by now.
    let size = threadbear_core::open_policy::local_open(path)
        .ok()
        .filter(|file| file.metadata().is_ok_and(|meta| meta.is_file()))
        .and_then(|file| {
            use std::io::Read as _;
            let head = std::io::BufReader::new(file.take(HEADER_BYTES));
            image::ImageReader::new(head)
                .with_guessed_format()
                .ok()?
                .into_dimensions()
                .ok()
        });
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if seen.len() > 2000 {
        seen.clear();
    }
    seen.insert(key, size);
    size
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn a_picture_that_fits_is_left_alone() {
        assert_eq!(fitted((1280, 6808)), (1280, 6808));
        assert_eq!(fitted((MAX_SIDE, 10)), (MAX_SIDE, 10));
        let bytes = png(4, 4);
        assert_eq!(fit_bytes(ImageFormat::Png, bytes.clone()).unwrap().1, bytes);
    }

    #[test]
    fn a_tall_phone_shot_is_shrunk_to_the_limit_keeping_its_shape() {
        let (width, height) = fitted((780, 18_232));
        assert_eq!(height, MAX_SIDE);
        assert!((f64::from(width) / f64::from(height) - 780. / 18_232.).abs() < 0.001);
        let (width, height) = fitted((40_000, 3));
        assert_eq!((width, height), (MAX_SIDE, 1));
    }

    #[test]
    fn too_big_bytes_come_back_as_a_png_that_fits() {
        let (format, bytes) = fit_bytes(ImageFormat::Png, png(2, MAX_SIDE + 100)).unwrap();
        assert_eq!(format, ImageFormat::Png);
        let size = size_of(&bytes).unwrap();
        assert!(!too_big(size));
        assert_eq!(size.1, MAX_SIDE);
    }
}
