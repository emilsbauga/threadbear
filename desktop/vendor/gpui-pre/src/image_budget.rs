//! Threadbear's patch: what decoding one picture may cost (Daybreak 170,
//! 23 Nov 2026). Upstream decodes any picture whole to RGBA and keeps every
//! GIF frame, so a 16,384-square greyscale PNG of a few hundred KB became
//! 1 GiB and a GIF of thousands of small frames several. Every raster decode
//! in this crate (`Image::to_image_data`, the `img` path loader) goes
//! through `decode`, and the app's own budgeted loader (threadbear-gpui's
//! fit_picture.rs) uses it too, so there's one policy:
//!
//! - the size comes from the header before anything is decoded, and a
//!   picture whose size can't be read isn't;
//! - more than `source_pixels` isn't decoded, the decoder is held to
//!   `decode_bytes`, and what's kept is shrunk to `shown_pixels` and the
//!   atlas's `max_side`;
//! - a moving picture plays only when its frame is at most `moving_pixels`,
//!   with at most `frames` frames and `animation_bytes` across them;
//!   otherwise its first frame shows still, and decoding stops the moment
//!   one more frame would go over.
//!
//! `peak_bytes` says what a decode may hold at once, for a caller that
//! budgets several.

use image::Frame;
use smallvec::SmallVec;
use std::io::Cursor;

/// What one picture may cost.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    /// Pixels in the picture's own frame; more isn't decoded at all.
    pub source_pixels: u64,
    /// Bytes the decoder may allocate for one frame.
    pub decode_bytes: u64,
    /// Pixels kept of a still picture, after shrinking.
    pub shown_pixels: u64,
    /// The longest side kept (the GPU atlas's limit).
    pub max_side: u32,
    /// The biggest frame a moving picture plays at; bigger shows still.
    pub moving_pixels: u64,
    /// Frames kept of a moving picture.
    pub frames: usize,
    /// Bytes kept across a moving picture's frames.
    pub animation_bytes: u64,
    /// Pixels an SVG is drawn at, at most.
    pub svg_pixels: u64,
}

impl DecodeLimits {
    /// 64 million pixels decoded (an 8,000-square photo, a 1,440 x 44,000
    /// full-page shot), 32 million kept (past a 6K screen's 20 million),
    /// moving ones up to 4K a frame, 600 frames and 256 MB (iOS's
    /// AnimationPlan has 600 too), SVGs drawn at up to 4 million pixels
    /// (2,048 square, a 1,024-point icon at 2x).
    pub const DEFAULT: DecodeLimits = DecodeLimits {
        source_pixels: 64 * 1024 * 1024,
        decode_bytes: 256 * 1024 * 1024,
        shown_pixels: 32 * 1024 * 1024,
        // wgpu (Linux) is held to its default device limit, 8192.
        max_side: if cfg!(target_os = "linux") { 8192 } else { 16384 },
        moving_pixels: 8 * 1024 * 1024,
        frames: 600,
        animation_bytes: 256 * 1024 * 1024,
        svg_pixels: 4 * 1024 * 1024,
    };
}

/// Why a picture wasn't decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeRefused {
    /// Over the limits.
    TooBig,
    /// Fits, but not with the pictures on screen now: tried again later.
    Busy,
    /// Not a picture this build reads, or its size couldn't be read.
    Unreadable(String),
}

impl std::fmt::Display for DecodeRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeRefused::TooBig => f.write_str("This picture is too big to show here."),
            DecodeRefused::Busy => {
                f.write_str("Too many big pictures are showing to show this one too.")
            }
            DecodeRefused::Unreadable(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for DecodeRefused {}

/// A decoded picture: BGRA frames as GPUI draws them, and its own size
/// (turned as its EXIF says).
pub struct Decoded {
    /// Its frames, one for a still picture.
    pub frames: SmallVec<[Frame; 1]>,
    /// The picture's own size, before any shrinking.
    pub source: (u32, u32),
}

impl Decoded {
    /// What it costs to keep: every frame's pixels.
    pub fn cost(&self) -> u64 {
        self.frames
            .iter()
            .map(|f| u64::from(f.buffer().width()) * u64::from(f.buffer().height()) * 4)
            .sum()
    }
}

fn unreadable(e: impl std::fmt::Display) -> DecodeRefused {
    DecodeRefused::Unreadable(format!("Couldn't read this picture: {e}"))
}

/// A decoder's own refusal of the limits reads as too big.
fn too_big_or(e: image::ImageError) -> DecodeRefused {
    match e {
        image::ImageError::Limits(_) => DecodeRefused::TooBig,
        e => unreadable(e),
    }
}

/// The kinds of picture decoded here: PNG, JPEG, GIF, WebP, BMP and TIFF,
/// what a thread's or a repo's pictures are. The image crate this build
/// links reads more (OpenEXR, ICO, Radiance HDR, DDS, TGA, QOI, PNM,
/// farbfeld), and some of their decoders allocate by what the file says
/// rather than within the limits they're given: an OpenEXR file of a few
/// channels' worth of pixels declaring thousands of channels, or an ICO
/// whose PNG inside inflates its colour profile before any limit is set
/// (Gemini, Daybreak 170 round 10). Whatever its name says, a file whose
/// bytes are any other kind isn't a picture here.
pub fn readable(bytes: &[u8]) -> Option<image::ImageFormat> {
    use image::ImageFormat::*;
    image::guess_format(bytes)
        .ok()
        .filter(|f| matches!(f, Png | Jpeg | Gif | WebP | Bmp | Tiff))
}

/// What a decoder may allocate besides a picture's pixels (what its header
/// carries, uncompressed), within the room `peak_bytes` reserves for it.
pub const METADATA_BYTES: u64 = 8 * 1024 * 1024;

/// A picture's size from its header, without decoding it. A PNG's is read
/// from its IHDR here: the image crate's PNG decoder, made just to say its
/// size, inflated its colour profile first, up to 512 MB, before anything
/// was reserved (Codex, Daybreak 170 round 9).
pub fn size_of(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.get(12..16)? != b"IHDR" {
            return None;
        }
        let word = |at: usize| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
        return Some((word(16)?, word(20)?));
    }
    if bytes.starts_with(b"RIFF") {
        return webp_size(bytes);
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), readable(bytes)?);
    // A header's worth, before anything is reserved for it.
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(METADATA_BYTES);
    reader.limits(limits);
    reader.into_dimensions().ok()
}

/// A PNG without its compressed text and colour profile (`iCCP`, `zTXt`,
/// `iTXt`), which its decoder would inflate, as big as the limit on its
/// pixels again, beside them; nothing here uses them. Any other picture,
/// or a PNG without them, as it is.
pub fn png_without_compressed_extras(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    use std::borrow::Cow;
    const SIGNATURE: usize = 8;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Cow::Borrowed(bytes);
    }
    let dropped = |kind: &[u8]| matches!(kind, b"iCCP" | b"zTXt" | b"iTXt");
    // Each whole chunk, as (start, end); a short one ends it. Walked, not
    // collected: a file of millions of empty chunks made a list of them
    // several times its own size (Gemini, round 10).
    let chunks = || {
        let mut at = SIGNATURE;
        std::iter::from_fn(move || {
            let head = bytes.get(at..at + 8)?;
            let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
            let end = at.saturating_add(12).saturating_add(len).min(bytes.len());
            let span = (at, end);
            at = end;
            Some(span)
        })
    };
    if !chunks().any(|(start, _)| dropped(&bytes[start + 4..start + 8])) {
        return Cow::Borrowed(bytes);
    }
    // No bigger than the file, made once.
    let mut kept = Vec::with_capacity(bytes.len());
    kept.extend_from_slice(&bytes[..SIGNATURE]);
    let mut at = SIGNATURE;
    for (start, end) in chunks() {
        if !dropped(&bytes[start + 4..start + 8]) {
            kept.extend_from_slice(&bytes[start..end]);
        }
        at = end;
    }
    kept.extend_from_slice(&bytes[at.min(bytes.len())..]);
    Cow::Owned(kept)
}

/// Whether a picture's bytes are a kind that may move: a GIF, or a WebP
/// whose `VP8X` says it's animated. A still WebP reserved for 600 frames
/// took a quarter of the budget for a screenshot (Gemini, Daybreak 170
/// round 12); one that says it's still is decoded still.
pub fn may_move(bytes: &[u8]) -> bool {
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Gif) => true,
        Ok(image::ImageFormat::WebP) => webp_animated(bytes),
        _ => false,
    }
}

/// Whether a WebP's first chunk is a `VP8X` with its animation flag set.
fn webp_animated(bytes: &[u8]) -> bool {
    webp_body(bytes)
        .and_then(|body| riff_chunks(body).next().flatten())
        .is_some_and(|(fourcc, data)| fourcc == b"VP8X" && data.first().is_some_and(|f| f & 0x02 != 0))
}

/// The size a picture is kept at: as it is when it fits, otherwise shrunk,
/// keeping its shape, until its longest side is `max_side` and it has at
/// most `shown_pixels`.
pub fn fitted((width, height): (u32, u32), limits: &DecodeLimits) -> (u32, u32) {
    let area = u64::from(width) * u64::from(height);
    let side = f64::from(limits.max_side) / f64::from(width.max(height).max(1));
    let pixels = (limits.shown_pixels as f64 / area.max(1) as f64).sqrt();
    let scale = side.min(pixels);
    if scale >= 1. {
        return (width, height);
    }
    // Down, so the area stays under the limit.
    let shrink = |n: u32| ((f64::from(n) * scale).floor() as u32).clamp(1, limits.max_side);
    let (mut w, mut h) = (shrink(width), shrink(height));
    // A side held at 1 can leave the other too long for the pixels.
    let most = limits.shown_pixels.max(1);
    if u64::from(w) * u64::from(h) > most {
        if w >= h {
            w = (most / u64::from(h)).clamp(1, u64::from(limits.max_side)) as u32;
        } else {
            h = (most / u64::from(w)).clamp(1, u64::from(limits.max_side)) as u32;
        }
    }
    (w, h)
}

/// What decoding `encoded` bytes of a picture `size` may hold at its peak:
/// the bytes, the decoder's buffers, a conversion to RGBA and what's kept.
/// A size that isn't known reserves the most any picture may take.
pub fn peak_bytes(encoded: u64, size: Option<(u32, u32)>, moving: bool, limits: &DecodeLimits) -> u64 {
    let still_most = limits.decode_bytes + limits.source_pixels * 4 + limits.shown_pixels * 4;
    let moving_most = limits.moving_pixels * 4 * 4 + limits.animation_bytes;
    let most = still_most.max(moving_most);
    // (A PNG's bytes may be copied once, without its extras.)
    let encoded = encoded.saturating_mul(2).saturating_add(METADATA_BYTES);
    let Some((width, height)) = size else {
        return encoded.saturating_add(most);
    };
    let area = u64::from(width) * u64::from(height);
    let peak = if moving && area <= limits.moving_pixels {
        // The decoder's canvas, its output and a frame being read, and
        // every frame kept.
        let kept = area
            .saturating_mul(4 * limits.frames as u64)
            .min(limits.animation_bytes);
        area * 4 * 4 + kept
    } else {
        // The decoder's buffer (float RGBA at most, held to decode_bytes),
        // its RGBA copy when shrinking, and what's kept.
        area.saturating_mul(16).min(limits.decode_bytes)
            + area.saturating_mul(4).min(limits.source_pixels * 4)
            + area.min(limits.shown_pixels) * 4
    };
    encoded.saturating_add(peak.min(most))
}

/// Decodes a picture within `limits`: the only way a picture's bytes become
/// pixels in this app.
pub fn decode(bytes: &[u8], limits: &DecodeLimits) -> Result<Decoded, DecodeRefused> {
    use image::AnimationDecoder as _;
    let format = readable(bytes).ok_or_else(|| {
        DecodeRefused::Unreadable("It isn't a picture this app can show.".into())
    })?;
    let stripped = png_without_compressed_extras(bytes);
    let bytes: &[u8] = &stripped;
    // Its size first, from its header: none, none drawn.
    let (width, height) = size_of(bytes)
        .filter(|&(w, h)| w > 0 && h > 0)
        .ok_or_else(|| DecodeRefused::Unreadable("Couldn't read this picture's size.".into()))?;
    let area = u64::from(width) * u64::from(height);
    if area > limits.source_pixels {
        return Err(DecodeRefused::TooBig);
    }
    // A WebP's frames are decoded at the size their own bitstreams say,
    // before it's checked against the canvas (image-webp 0.2): each must be
    // its frame's size, within the canvas, first (Codex, round 9).
    if format == image::ImageFormat::WebP && !webp_frames_fit(bytes) {
        return Err(DecodeRefused::TooBig);
    }
    // What the decoder may allocate: its pixels' worth (float RGBA at
    // most) and its header's, as `peak_bytes` reserves, not a flat 256 MB.
    let decoder_limits = || {
        let mut l = image::Limits::default();
        l.max_image_width = Some(width);
        l.max_image_height = Some(height);
        l.max_alloc = Some(
            area.saturating_mul(16)
                .min(limits.decode_bytes)
                .saturating_add(METADATA_BYTES),
        );
        l
    };
    // Plays only at a frame size the decoder's buffers stay small at.
    let plays = area <= limits.moving_pixels
        && area <= limits.shown_pixels
        && width <= limits.max_side
        && height <= limits.max_side;
    let (mut frames, source) = match format {
        image::ImageFormat::Gif if plays => {
            use image::ImageDecoder as _;
            let mut decoder =
                image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(unreadable)?;
            decoder.set_limits(decoder_limits()).map_err(too_big_or)?;
            (
                moving(decoder.into_frames(), (width, height), limits)?,
                (width, height),
            )
        }
        image::ImageFormat::WebP if plays => {
            let mut decoder =
                image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(unreadable)?;
            // Plays only as `may_move` said it may, which its room was for.
            if decoder.has_animation() && webp_animated(bytes) {
                use image::ImageDecoder as _;
                decoder.set_limits(decoder_limits()).map_err(too_big_or)?;
                decoder
                    .set_background_color(image::Rgba([0, 0, 0, 0]))
                    .map_err(unreadable)?;
                (
                    moving(decoder.into_frames(), (width, height), limits)?,
                    (width, height),
                )
            } else {
                still(bytes, (width, height), decoder_limits(), limits)?
            }
        }
        // A still picture, or a moving one too big to play: its first frame.
        _ => still(bytes, (width, height), decoder_limits(), limits)?,
    };
    for frame in &mut frames {
        // GPUI's pictures are BGRA.
        for pixel in frame.buffer_mut().chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }
    Ok(Decoded { frames, source })
}

/// A still picture, or a moving one's first frame, decoded within the
/// decoder's limits, shrunk to what's kept and turned as its EXIF says.
fn still(
    bytes: &[u8],
    size: (u32, u32),
    decoder_limits: image::Limits,
    limits: &DecodeLimits,
) -> Result<(SmallVec<[Frame; 1]>, (u32, u32)), DecodeRefused> {
    use image::ImageDecoder as _;
    let format = readable(bytes).ok_or_else(|| unreadable("not a picture"))?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decoder_limits);
    let mut decoder = reader.into_decoder().map_err(too_big_or)?;
    // The decoder's own size and buffer, checked again, whatever the header said.
    if decoder.dimensions() != size || decoder.total_bytes() > limits.decode_bytes {
        return Err(DecodeRefused::TooBig);
    }
    let orientation = decoder.orientation().ok();
    let picture = image::DynamicImage::from_decoder(decoder).map_err(too_big_or)?;
    let mut picture = shrink(picture, limits);
    let mut source = size;
    if let Some(orientation) = orientation {
        use image::metadata::Orientation::*;
        if matches!(
            orientation,
            Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH
        ) {
            source = (size.1, size.0);
        }
        picture.apply_orientation(orientation);
    }
    Ok((SmallVec::from_elem(Frame::new(picture.into_rgba8()), 1), source))
}

/// Shrunk to `fitted`'s size by area averaging, which needs no buffer
/// bigger than the source's RGBA copy (`resize_exact`'s Triangle filter
/// makes a float one as tall as the source).
fn shrink(picture: image::DynamicImage, limits: &DecodeLimits) -> image::DynamicImage {
    let size = (picture.width(), picture.height());
    let (width, height) = fitted(size, limits);
    if (width, height) == size {
        picture
    } else {
        picture.thumbnail_exact(width, height)
    }
}

/// A moving picture's frames while they fit the limits; else its first
/// frame, still. Decoding stops as soon as one more frame would go over.
fn moving(
    frames: image::Frames<'_>,
    (width, height): (u32, u32),
    limits: &DecodeLimits,
) -> Result<SmallVec<[Frame; 1]>, DecodeRefused> {
    let frame_bytes = u64::from(width) * u64::from(height) * 4;
    let mut kept: SmallVec<[Frame; 1]> = SmallVec::new();
    let mut bytes = 0u64;
    for frame in frames {
        // A frame that won't decode ends it there: what came before plays.
        let Ok(frame) = frame else { break };
        if frame.buffer().dimensions() != (width, height) {
            return Err(DecodeRefused::Unreadable(
                "Couldn't read this picture: a frame isn't the picture's size.".into(),
            ));
        }
        bytes = bytes.saturating_add(frame_bytes);
        if !kept.is_empty() && (kept.len() >= limits.frames || bytes > limits.animation_bytes) {
            // Still: its first frame, with no frame time to wait on.
            kept.truncate(1);
            let first = kept.pop().map(|f| f.into_buffer());
            return Ok(first
                .map(|buffer| SmallVec::from_elem(Frame::new(buffer), 1))
                .unwrap_or_default());
        }
        kept.push(frame);
    }
    if kept.is_empty() {
        return Err(DecodeRefused::Unreadable("Couldn't read this picture.".into()));
    }
    if kept.len() == 1 {
        let buffer = kept.pop().map(|f| f.into_buffer()).unwrap_or_default();
        kept.push(Frame::new(buffer));
    }
    Ok(kept)
}

fn u24(b: &[u8]) -> u32 {
    u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16
}

/// The size a WebP's VP8 or VP8L bitstream says it is.
fn webp_bitstream(fourcc: &[u8], data: &[u8]) -> Option<(u32, u32)> {
    match fourcc {
        b"VP8 " => {
            let head = data.get(..10)?;
            if head[3..6] != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let w = u32::from(u16::from_le_bytes([head[6], head[7]]) & 0x3fff);
            let h = u32::from(u16::from_le_bytes([head[8], head[9]]) & 0x3fff);
            Some((w, h))
        }
        b"VP8L" => {
            let head = data.get(..5)?;
            if head[0] != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

/// The chunks in a RIFF body, walked one by one, never collected (a list
/// of a file's millions of empty chunks was several times its size,
/// Gemini, round 10): each one's fourcc and contents, or None for one cut
/// short, which ends it.
fn riff_chunks(mut data: &[u8]) -> impl Iterator<Item = Option<(&[u8], &[u8])>> {
    std::iter::from_fn(move || {
        if data.is_empty() {
            return None;
        }
        let chunk = (|| {
            let head = data.get(..8)?;
            let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
            let body = data.get(8..8usize.checked_add(len)?)?;
            Some((&head[..4], body, 8 + len + (len & 1)))
        })();
        match chunk {
            Some((fourcc, body, next)) => {
                data = &data[next.min(data.len())..];
                Some(Some((fourcc, body)))
            }
            None => {
                data = &[];
                Some(None)
            }
        }
    })
}

/// A WebP's top-level chunks: what its RIFF header says it holds, not what
/// may follow it in the file.
fn webp_body(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    let riff = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    bytes.get(12..riff.saturating_add(8).min(bytes.len()))
}

/// A WebP's size, as its decoder takes it: its first chunk's, the canvas
/// of a `VP8X` or a simple one's bitstream. Read here, without a decoder.
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let (fourcc, data) = riff_chunks(webp_body(bytes)?).next()??;
    match fourcc {
        b"VP8X" => {
            let d = data.get(4..10)?;
            Some((u24(&d[0..3]) + 1, u24(&d[3..6]) + 1))
        }
        _ => webp_bitstream(fourcc, data),
    }
}

/// Whether every frame in a WebP is no bigger than what holds it: a still
/// one's bitstream its canvas (`VP8X`), an animated one's each its frame
/// (`ANMF`), and each frame within the canvas. The bitstreams' own sizes
/// are read from their headers (VP8: after the start code; VP8L: after its
/// signature). Anything not read as expected doesn't fit.
pub fn webp_frames_fit(bytes: &[u8]) -> bool {
    let check = || -> Option<bool> {
        let body = webp_body(bytes)?;
        // The canvas, from the first VP8X, walked for first.
        let mut canvas = None;
        for chunk in riff_chunks(body) {
            let (fourcc, data) = chunk?;
            if fourcc == b"VP8X" {
                let d = data.get(4..10)?;
                canvas = Some((u24(&d[0..3]) + 1, u24(&d[3..6]) + 1));
                break;
            }
        }
        for chunk in riff_chunks(body) {
            let (fourcc, data) = chunk?;
            match fourcc {
                b"VP8 " | b"VP8L" => {
                    let size = webp_bitstream(fourcc, data)?;
                    // Simple (no VP8X): the bitstream is the canvas.
                    if canvas.is_some_and(|c| c != size) {
                        return Some(false);
                    }
                }
                b"ANMF" => {
                    let head = data.get(..16)?;
                    let (x, y) = (u24(&head[0..3]) * 2, u24(&head[3..6]) * 2);
                    let frame = (u24(&head[6..9]) + 1, u24(&head[9..12]) + 1);
                    let canvas = canvas?;
                    if x + frame.0 > canvas.0 || y + frame.1 > canvas.1 {
                        return Some(false);
                    }
                    for inner in riff_chunks(data.get(16..)?) {
                        let (fourcc, data) = inner?;
                        if matches!(fourcc, b"VP8 " | b"VP8L")
                            && webp_bitstream(fourcc, data)? != frame
                        {
                            return Some(false);
                        }
                    }
                }
                _ => {}
            }
        }
        Some(true)
    };
    check().unwrap_or(false)
}

/// The biggest SVG file drawn: its parsed tree grows with its text.
pub const SVG_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Whether these bytes are an SVG to draw: not a raster picture, at most
/// `SVG_MAX_BYTES`, with an `<svg` near the start.
pub fn is_svg(bytes: &[u8]) -> bool {
    image::guess_format(bytes).is_err()
        && bytes.len() <= SVG_MAX_BYTES
        && bytes[..bytes.len().min(4096)]
            .windows(4)
            .any(|w| w == b"<svg")
}

/// How many canvases' worth of pixels an SVG may hold beyond its canvas
/// while it's drawn (isolated groups' layers, pattern tiles, masks, clips
/// and filter steps, at the sizes resvg makes them, which can be bigger
/// than the canvas); more isn't drawn.
pub const SVG_MAX_LAYERS: usize = 12;

/// How much tree usvg may build from an SVG of `encoded` bytes
/// (`expanded_weight` in svg_renderer.rs, which counts the copies `<use>`
/// and references make): twice its own size, and at least 2 MB, so a
/// small icon may reuse its parts, and a diagram mark its lines with
/// arrows, freely. `svg_peak_bytes` reserves 32
/// times the file for the tree.
pub fn svg_weight_most(encoded: usize) -> u64 {
    (encoded as u64).max(1024 * 1024) * 2
}

/// What drawing an SVG of `encoded` bytes may hold at its peak: its text,
/// its parsed XML and tree (a generous multiple of the most tree it may
/// build, `svg_weight_most`), the canvas, its copy and every layer it may
/// nest.
pub fn svg_peak_bytes(encoded: u64, limits: &DecodeLimits) -> u64 {
    encoded.saturating_mul(16)
        + svg_weight_most(encoded.min(SVG_MAX_BYTES as u64) as usize).saturating_mul(16)
        + limits
            .svg_pixels
            .saturating_mul(4 * (SVG_MAX_LAYERS as u64 + 2))
}

/// Draws an SVG within `limits` (at most `svg_pixels`, its `<image>`s left
/// out, as `SvgRenderer` does): the picture and what it costs to keep.
pub fn render_svg(
    bytes: &[u8],
    renderer: &crate::SvgRenderer,
) -> Result<(std::sync::Arc<crate::RenderImage>, u64), DecodeRefused> {
    if !is_svg(bytes) {
        return Err(DecodeRefused::Unreadable("Couldn't read this picture.".into()));
    }
    // One over the limits is too big, not unreadable: it isn't read again.
    // One whose drawing process couldn't start is tried again later.
    let image = renderer.render_picture(bytes, 1.0).map_err(|refused| match refused {
        crate::PictureRefused::TooBig => DecodeRefused::TooBig,
        crate::PictureRefused::TryLater => DecodeRefused::Busy,
        crate::PictureRefused::Unreadable => {
            DecodeRefused::Unreadable("Couldn't read this picture.".into())
        }
    })?;
    let size = image.size(0);
    let cost = (size.width.0.max(0) as u64) * (size.height.0.max(0) as u64) * 4;
    Ok((image, cost))
}
