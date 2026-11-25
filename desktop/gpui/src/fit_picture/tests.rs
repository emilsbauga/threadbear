use super::*;
use image_budget::{decode, fitted, peak_bytes};

const MAX_SIDE: u32 = LIMITS.max_side;

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

fn grey_png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::GrayImage::from_pixel(width, height, image::Luma([7]))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// A PNG's signature and header only, claiming any size: what a bomb looks
/// like before its compressed pixels, without making them.
fn png_header(width: u32, height: u32, colour: u8) -> Vec<u8> {
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(b"IHDR");
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, colour, 0, 0, 0]);
    let crc = crc32(&ihdr);
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(&ihdr);
    bytes.extend_from_slice(&crc.to_be_bytes());
    // An IDAT of a few zero bytes: a decoder that went on would allocate.
    let idat = b"IDAT\x78\x9c\x03\x00\x00\x00\x00\x01";
    bytes.extend_from_slice(&((idat.len() - 4) as u32).to_be_bytes());
    bytes.extend_from_slice(idat);
    bytes.extend_from_slice(&crc32(idat).to_be_bytes());
    bytes
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn gif(width: u32, height: u32, frames: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for i in 0..frames {
            let shade = (i * 40 % 255) as u8;
            let buffer =
                image::RgbaImage::from_pixel(width, height, image::Rgba([shade, 0, 0, 255]));
            encoder
                .encode_frame(image::Frame::from_parts(
                    buffer,
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(50, 1),
                ))
                .unwrap();
        }
    }
    bytes
}

/// A lossless animated WebP of `frames` frames, built by hand (the image
/// crate writes no animations): VP8X with the animation flag, an ANIM
/// chunk, and an ANMF per frame holding a still WebP's VP8L.
fn animated_webp(width: u32, height: u32, frames: usize) -> Vec<u8> {
    let still = {
        let mut bytes = Vec::new();
        image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 200, 255]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::WebP,
            )
            .unwrap();
        bytes
    };
    // The VP8L chunk of the still one: after "RIFF....WEBP".
    let vp8l = &still[12..];
    assert_eq!(&vp8l[..4], b"VP8L");
    let chunk = |tag: &[u8], body: &[u8]| {
        let mut c = tag.to_vec();
        c.extend_from_slice(&(body.len() as u32).to_le_bytes());
        c.extend_from_slice(body);
        if body.len() % 2 == 1 {
            c.push(0);
        }
        c
    };
    let u24 = |n: u32| n.to_le_bytes()[..3].to_vec();
    let mut vp8x = vec![0x02 | 0x10, 0, 0, 0];
    vp8x.extend(u24(width - 1));
    vp8x.extend(u24(height - 1));
    let mut body = b"WEBP".to_vec();
    body.extend(chunk(b"VP8X", &vp8x));
    body.extend(chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]));
    for _ in 0..frames {
        let mut anmf = Vec::new();
        anmf.extend(u24(0));
        anmf.extend(u24(0));
        anmf.extend(u24(width - 1));
        anmf.extend(u24(height - 1));
        anmf.extend(u24(50));
        anmf.push(0);
        anmf.extend_from_slice(vp8l);
        body.extend(chunk(b"ANMF", &anmf));
    }
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend(body);
    bytes
}

fn small(
    source_pixels: u64,
    shown_pixels: u64,
    frames: usize,
    animation_bytes: u64,
) -> DecodeLimits {
    DecodeLimits {
        source_pixels,
        decode_bytes: source_pixels * 8,
        shown_pixels,
        moving_pixels: shown_pixels,
        frames,
        animation_bytes,
        ..LIMITS
    }
}

#[test]
fn a_picture_that_fits_is_left_alone() {
    assert_eq!(fitted((1280, 6808), &LIMITS), (1280, 6808));
    assert_eq!(fitted((MAX_SIDE, 10), &LIMITS), (MAX_SIDE, 10));
    let decoded = decode(&png(4, 4), &LIMITS).unwrap();
    assert_eq!(decoded.frames.len(), 1);
    assert_eq!(decoded.frames[0].buffer().dimensions(), (4, 4));
    // BGRA, as GPUI draws.
    assert_eq!(
        decoded.frames[0].buffer().get_pixel(0, 0).0,
        [30, 20, 10, 255]
    );
    assert_eq!(decoded.source, (4, 4));
}

#[test]
fn a_tall_phone_shot_is_shrunk_to_the_limit_keeping_its_shape() {
    let (width, height) = fitted((780, 18_232), &LIMITS);
    assert_eq!(height, MAX_SIDE);
    assert!((f64::from(width) / f64::from(height) - 780. / 18_232.).abs() < 0.001);
    let (width, height) = fitted((40_000, 3), &LIMITS);
    assert_eq!((width, height), (MAX_SIDE, 1));
}

#[test]
fn a_picture_taller_than_the_gpu_draws_comes_back_shrunk_to_fit() {
    let decoded = decode(&png(2, MAX_SIDE + 100), &LIMITS).unwrap();
    let (width, height) = decoded.frames[0].buffer().dimensions();
    assert!(width <= MAX_SIDE && height <= MAX_SIDE);
    assert_eq!(height, MAX_SIDE);
    assert_eq!(decoded.source, (2, MAX_SIDE + 100));
}

// Daybreak 170: a 16,384-square greyscale PNG is a few hundred KB and 1 GiB
// decoded. Its header alone is refused, before any allocation.
#[test]
fn a_max_side_square_bomb_is_refused_from_its_header() {
    for colour in [0u8, 6] {
        let bomb = png_header(16_384, 16_384, colour);
        assert_eq!(image_budget::size_of(&bomb), Some((16_384, 16_384)));
        assert_eq!(
            decode(&bomb, &LIMITS).err(),
            Some(Refused::TooBig),
            "colour {colour}"
        );
    }
    // Just over the source pixels, and sizes whose product overflows u32:
    // all refused from the header, none multiplied in 32 bits.
    let over = (LIMITS.source_pixels + 1) as u32;
    for (w, h) in [(8193, 8193), (over, 1), (65_536, 65_536)] {
        assert_eq!(
            decode(&png_header(w, h, 0), &LIMITS).err(),
            Some(Refused::TooBig),
            "{w} x {h}"
        );
    }
    // PNG's own largest: its decoder won't read the header either.
    assert!(decode(&png_header(0x7FFF_FFFF, 0x7FFF_FFFF, 0), &LIMITS).is_err());
}

// GPUI's own decoders are held to the same: `Image::to_image_data` (an
// `ImageSource::Image`, a data: URL in markdown) refuses the bomb.
#[test]
fn gpuis_own_decoder_refuses_the_bomb_too() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let bomb = Image::from_bytes(gpui_kit::ImageFormat::Png, png_header(16_384, 16_384, 0));
    let error = bomb.to_image_data(renderer.clone()).unwrap_err();
    assert!(error.to_string().contains("too big"), "{error}");
    // Named a GIF or anything else, its bytes decide.
    let named = Image::from_bytes(gpui_kit::ImageFormat::Gif, png_header(16_384, 16_384, 0));
    assert!(named.to_image_data(renderer.clone()).is_err());
    let fine = Image::from_bytes(gpui_kit::ImageFormat::Png, png(3, 3));
    assert_eq!(fine.to_image_data(renderer).unwrap().frame_count(), 1);
}

#[test]
fn an_svg_is_drawn_at_most_at_the_svg_pixels_without_its_pictures() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="8192"><rect width="10" height="10"/></svg>"#;
    let image = renderer.render_single_frame(svg, 1.0).unwrap();
    let size = image.size(0);
    let pixels = size.width.0 as u64 * size.height.0 as u64;
    assert!(pixels <= LIMITS.svg_pixels, "{pixels}");
    // A picture with a picture in it isn't drawn at all (round 7); an icon
    // of the app's own draws without it, as its `<image>`s are never read.
    let embedded = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4" height="4"><image width="4" height="4" xlink:href="data:image/png;base64,{}"/></svg>"#,
        base64_encode(&png(4, 4))
    );
    assert!(renderer
        .render_single_frame(embedded.as_bytes(), 1.0)
        .is_err());
    assert!(renderer.draws_icon(embedded.as_bytes(), 1.0));
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn what_is_kept_is_held_to_the_shown_pixels() {
    // Every side at MAX_SIDE, and past what u32 holds once squared.
    for size in [(MAX_SIDE, MAX_SIDE), (8000, 8000), (u32::MAX, u32::MAX)] {
        let (w, h) = fitted(size, &LIMITS);
        assert!(
            u64::from(w) * u64::from(h) <= LIMITS.shown_pixels,
            "{size:?}"
        );
        assert!(w <= MAX_SIDE && h <= MAX_SIDE);
    }
    // Tiny limits and a long thin picture: still within them.
    let tiny = small(1 << 20, 100, 600, 1 << 20);
    let (w, h) = fitted((10_000, 3), &tiny);
    assert!(u64::from(w) * u64::from(h) <= 100, "{w} x {h}");
    // A greyscale picture under the decode limit but over what's kept is
    // shrunk to it, keeping its shape.
    let limits = small(100_000, 10_000, 600, 1 << 20);
    let decoded = decode(&grey_png(300, 200), &limits).unwrap();
    let (w, h) = decoded.frames[0].buffer().dimensions();
    assert!(u64::from(w) * u64::from(h) <= 10_000);
    assert!((f64::from(w) / f64::from(h) - 1.5).abs() < 0.05);
    assert!(decoded.cost() <= 40_000);
}

#[test]
fn a_picture_over_the_source_pixels_is_refused() {
    let limits = small(10_000, 10_000, 600, 1 << 20);
    assert_eq!(
        decode(&grey_png(200, 200), &limits).err(),
        Some(Refused::TooBig)
    );
}

#[test]
fn a_picture_whose_size_cant_be_read_isnt_decoded() {
    let mut cut = png(4, 4);
    cut.truncate(12);
    assert!(matches!(decode(&cut, &LIMITS), Err(Refused::Unreadable(_))));
    assert!(matches!(
        decode(b"not a picture at all", &LIMITS),
        Err(Refused::Unreadable(_))
    ));
}

#[test]
fn a_gif_within_the_limits_plays_every_frame() {
    let decoded = decode(&gif(10, 10, 5), &LIMITS).unwrap();
    assert_eq!(decoded.frames.len(), 5);
    assert_eq!(decoded.cost(), 5 * 10 * 10 * 4);
}

#[test]
fn a_gif_over_the_frame_count_shows_its_first_frame_still() {
    let limits = small(1 << 20, 1 << 20, 4, 1 << 30);
    let decoded = decode(&gif(10, 10, 5), &limits).unwrap();
    assert_eq!(decoded.frames.len(), 1);
    // The first frame, BGRA.
    assert_eq!(decoded.frames[0].buffer().get_pixel(0, 0).0, [0, 0, 0, 255]);
}

#[test]
fn a_gif_over_the_animation_bytes_stops_decoding_and_shows_its_first_frame() {
    // Three 10 x 10 frames fit 1,200 bytes; the fourth would go over.
    let limits = small(1 << 20, 1 << 20, 600, 1200);
    assert_eq!(decode(&gif(10, 10, 50), &limits).unwrap().frames.len(), 1);
    assert_eq!(decode(&gif(10, 10, 3), &limits).unwrap().frames.len(), 3);
}

#[test]
fn a_gif_bigger_than_plays_is_one_shrunk_frame() {
    let limits = small(1 << 20, 100, 600, 1 << 30);
    let decoded = decode(&gif(40, 40, 3), &limits).unwrap();
    assert_eq!(decoded.frames.len(), 1);
    let (w, h) = decoded.frames[0].buffer().dimensions();
    assert!(w * h <= 100);
}

#[test]
fn an_animated_webp_is_held_to_the_same_frames_and_bytes() {
    let webp = animated_webp(10, 10, 5);
    assert_eq!(decode(&webp, &LIMITS).unwrap().frames.len(), 5);
    let limits = small(1 << 20, 1 << 20, 4, 1 << 30);
    assert_eq!(decode(&webp, &limits).unwrap().frames.len(), 1);
    let limits = small(1 << 20, 1 << 20, 600, 1200);
    assert_eq!(decode(&webp, &limits).unwrap().frames.len(), 1);
}

fn ready(width: u32, height: u32) -> Ready {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    super::decode(&png(width, height), &renderer).unwrap()
}

/// Makes room as `reserve` does: look again, then clear out after `settle`.
fn clear(books: &mut Books, now: Instant) -> Vec<Arc<RenderImage>> {
    let settle = Duration::from_secs(1);
    match books.clear_out(now, settle) {
        ClearOut::LookAgain => {}
        _ => panic!("looks again first"),
    }
    match books.clear_out(now + settle, settle) {
        ClearOut::Gone(gone) => gone,
        _ => panic!("clears out after"),
    }
}

#[test]
fn the_books_hold_every_decode_and_kept_picture_to_one_limit() {
    let now = Instant::now();
    let mut books = Books::new(1000);
    // Pictures each allowed on their own can't together go over.
    assert!(books.try_reserve(600).unwrap());
    assert!(!books.try_reserve(600).unwrap());
    // Kept at its real cost: a 10 x 10 picture is 400 bytes.
    assert!(books.keep("a".into(), ready(10, 10), 600, now).is_none());
    assert_eq!(books.used(), 400);
    assert!(books.try_reserve(600).unwrap());
    assert!(!books.try_reserve(1).unwrap());
    books.release(600);
    // Kept again under the same key, charged once, and the one it replaces
    // handed back for the atlas.
    assert!(books.try_reserve(400).unwrap());
    assert!(books.keep("a".into(), ready(10, 10), 400, now).is_some());
    assert_eq!(books.used(), 400);
    // A waiting decode has every window drawn again; one drawn since stays.
    assert!(!books.try_reserve(700).unwrap());
    let settle = Duration::from_secs(1);
    assert!(matches!(books.clear_out(now, settle), ClearOut::LookAgain));
    assert!(books.drawn("a", now + settle / 2).is_some());
    match books.clear_out(now + settle, settle) {
        ClearOut::Gone(gone) => assert!(gone.is_empty()),
        _ => panic!("clears out"),
    }
    assert_eq!(books.used(), 400);
    // Not drawn since the look: it goes, and its bytes come back.
    assert!(!books.try_reserve(700).unwrap());
    let later = now + settle * 3;
    let gone = clear(&mut books, later);
    assert_eq!(gone.len(), 1);
    assert_eq!(books.used(), 0);
    assert!(books.drawn("a", later).is_none());
    assert!(books.try_reserve(700).unwrap());
    // More than the whole budget is refused, not waited for.
    assert_eq!(books.try_reserve(1001), Err(Refused::TooBig));
}

#[test]
fn only_as_many_go_as_the_waiting_decode_needs() {
    let now = Instant::now();
    let mut books = Books::new(1000);
    for key in ["a", "b"] {
        assert!(books.try_reserve(400).unwrap());
        books.keep(key.into(), ready(10, 10), 400, now);
    }
    books.drawn("b", now + Duration::from_millis(1));
    assert!(!books.try_reserve(300).unwrap());
    let gone = clear(&mut books, now + Duration::from_secs(5));
    // a, the least recently drawn, makes room on its own.
    assert_eq!(gone.len(), 1);
    assert!(books.drawn("a", now).is_none());
    assert!(books.drawn("b", now).is_some());
}

#[test]
fn nothing_waiting_drops_nothing() {
    let now = Instant::now();
    let mut books = Books::new(1000);
    assert!(books.try_reserve(400).unwrap());
    books.keep("a".into(), ready(10, 10), 400, now);
    let later = now + Duration::from_secs(100);
    assert!(matches!(
        books.clear_out(later, Duration::from_secs(1)),
        ClearOut::Nothing
    ));
}

#[test]
fn bytes_waiting_are_limited_by_size_not_count() {
    let mut books = Books::new(1000);
    // Big ones waiting fill their room...
    assert!(books.try_wait(Reads::Remote, WAITING_BYTES - 10));
    assert!(!books.try_wait(Reads::Remote, 100));
    // ...and a small one still gets in, and a slow Mac's don't hold up
    // this one's files.
    assert!(books.try_wait(Reads::Remote, 10));
    assert!(books.try_wait(Reads::Here, FILE_MAX_BYTES));
    books.stop_waiting(Reads::Remote, WAITING_BYTES);
    assert!(books.try_wait(Reads::Remote, 100));
}

#[test]
fn an_svg_is_drawn_through_the_books_and_a_raster_named_svg_is_a_raster() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>"#;
    assert!(image_budget::is_svg(svg));
    let drawn = super::decode(svg, &renderer).unwrap();
    assert!(drawn.cost > 0);
    // Its peak is reserved for, canvas and all.
    assert!(peak(svg) >= LIMITS.svg_pixels * 4);
    // A PNG whatever it's called is decoded, within the limits, as one.
    assert!(!image_budget::is_svg(&png(4, 4)));
    let bomb = png_header(16_384, 16_384, 0);
    assert!(!image_budget::is_svg(&bomb));
    assert_eq!(super::decode(&bomb, &renderer).err(), Some(Refused::TooBig));
    // Neither: not drawn.
    assert!(super::decode(b"hello", &renderer).is_err());
}

#[test]
fn decode_now_keeps_one_frame_within_the_books() {
    let plan = || Plan::small(1 << 20);
    let picture = decode_now(|| Some(gif(10, 10, 5)), plan(), Some).unwrap();
    assert_eq!(picture.dimensions(), (10, 10));
    // RGBA again, for the image crate.
    assert_eq!(picture.get_pixel(0, 0).0, [0, 0, 0, 255]);
    // Ones it can't read, or too big, aren't Busy: no use trying again.
    assert_eq!(
        decode_now(|| Some(png_header(16_384, 16_384, 0)), plan(), Some).err(),
        Some(Missed::Failed)
    );
    assert_eq!(
        decode_now(|| None, plan(), Some).err(),
        Some(Missed::Failed)
    );
    assert_eq!(
        decode_now(|| Some(b"hello".to_vec()), plan(), Some).err(),
        Some(Missed::Failed)
    );
    // What it does with the picture is done with its room still taken.
    let before = books().used();
    let during = decode_now(|| Some(png(4, 4)), plan(), |_| Some(books().used())).unwrap();
    assert!(during > before);
    // The plan is made from the picture's own size, and what it asks for
    // is what's kept.
    let picture = decode_now(
        || Some(png(400, 100)),
        |size| {
            assert_eq!(size, (400, 100));
            Plan {
                shown_pixels: 100 * 25,
                made_bytes: 0,
            }
        },
        Some,
    )
    .unwrap();
    assert_eq!(picture.dimensions(), (100, 25));
}

// Daybreak 170, round 3: filling a thumbnail's box from a 1 x 16,384
// strip made the whole strip 112 wide first, 784 MB.
#[test]
fn filling_a_box_cuts_before_it_shrinks() {
    let strip = image::RgbaImage::from_pixel(1, 16_384, image::Rgba([1, 2, 3, 255]));
    let small = fill(&strip, 112, 72);
    assert_eq!(small.dimensions(), (112, 72));
    let wide = image::RgbaImage::from_pixel(16_384, 1, image::Rgba([1, 2, 3, 255]));
    assert_eq!(fill(&wide, 112, 72).dimensions(), (112, 72));
}

#[test]
fn an_svg_holding_too_many_layers_isnt_drawn() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let nested = |side: u32, depth: usize| {
        let mut svg =
            format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}">"#);
        for _ in 0..depth {
            svg.push_str(&format!(
                r#"<g opacity="0.5"><rect width="{side}" height="{side}"/>"#
            ));
        }
        for _ in 0..depth {
            svg.push_str("</g>");
        }
        svg.push_str("</svg>");
        svg
    };
    // What's held is counted in pixels, so a small icon may nest deeply...
    assert!(super::decode(nested(64, 40).as_bytes(), &renderer).is_ok());
    // ...and a canvas-sized one only a few deep.
    assert!(super::decode(nested(2048, 3).as_bytes(), &renderer).is_ok());
    assert!(super::decode(nested(2048, 40).as_bytes(), &renderer).is_err());
    // Gzipped, it isn't inflated at all.
    assert!(renderer
        .render_single_frame(&[0x1f, 0x8b, 8, 0], 1.0)
        .is_err());
}

#[test]
fn a_stuck_wait_gives_up_as_busy() {
    let now = Instant::now();
    let mut big = Books::new(1000);
    // Kept 900 bytes' worth, all of it on screen, nothing under way.
    assert!(big.try_reserve(950).unwrap());
    big.keep("a".into(), ready(15, 15), 950, now);
    assert!(!big.try_reserve(700).unwrap());
    let settle = Duration::from_secs(1);
    assert!(matches!(big.clear_out(now, settle), ClearOut::LookAgain));
    big.drawn("a", now + settle / 2);
    assert!(matches!(
        big.clear_out(now + settle, settle),
        ClearOut::Gone(_)
    ));
    assert!(big.stuck(0));
    // A wait that starts after it doesn't give up on that clear-out's word:
    // what was on screen then may have scrolled away (round 5).
    assert!(!big.stuck(big.cleared()));
    // Anything given back means it may fit after all.
    big.forget("a");
    assert!(!big.stuck(0));
}

#[test]
fn no_one_picture_can_reserve_more_than_the_budget() {
    let most = peak_bytes(FILE_MAX_BYTES, None, true, &LIMITS);
    assert!(most < BUDGET_BYTES, "{most}");
    for size in [
        Some((u32::MAX, u32::MAX)),
        Some((8000, 8000)),
        Some((2000, 2000)),
    ] {
        for moving in [false, true] {
            assert!(peak_bytes(FILE_MAX_BYTES, size, moving, &LIMITS) <= most);
        }
    }
    assert!(
        image_budget::svg_peak_bytes(image_budget::SVG_MAX_BYTES as u64, &LIMITS) < BUDGET_BYTES
    );
    // What a still picture holds at its peak is covered: a 64 million pixel
    // 16-bit RGBA PNG's buffer, its RGBA copy and what's kept.
    let side = 8192u64;
    assert!(
        peak_bytes(0, Some((side as u32, side as u32)), false, &LIMITS)
            >= LIMITS.decode_bytes + side * side * 4 + LIMITS.shown_pixels * 4
    );
}

// Every path that draws a thread's picture goes through the books and
// `image_budget`: none hands a path or bytes to GPUI's loaders, keeps decoded
// pixels of its own, or decodes with the image crate itself.
#[test]
fn every_picture_path_shares_this_one() {
    let sources = [
        ("rows/markdown.rs", include_str!("../rows/markdown.rs")),
        ("rows/images.rs", include_str!("../rows/images.rs")),
        ("rows/cards.rs", include_str!("../rows/cards.rs")),
        ("remote_pictures.rs", include_str!("../remote_pictures.rs")),
        ("viewer.rs", include_str!("../viewer.rs")),
        ("files.rs", include_str!("../files.rs")),
        ("patches.rs", include_str!("../patches.rs")),
        ("patch_icons.rs", include_str!("../patch_icons.rs")),
        ("projects.rs", include_str!("../projects.rs")),
        ("projects_page.rs", include_str!("../projects_page.rs")),
        ("sidebar.rs", include_str!("../sidebar.rs")),
        ("new_thread.rs", include_str!("../new_thread.rs")),
        ("recipes.rs", include_str!("../recipes.rs")),
        (
            "highlights_project.rs",
            include_str!("../highlights_project.rs"),
        ),
        ("composer_card.rs", include_str!("../composer_card.rs")),
        ("file_thumbs.rs", include_str!("../file_thumbs.rs")),
        ("folders.rs", include_str!("../folders.rs")),
        (
            "review_window/canvas.rs",
            include_str!("../review_window/canvas.rs"),
        ),
        (
            "review_window/stage.rs",
            include_str!("../review_window/stage.rs"),
        ),
        (
            "review_window/reply_pictures.rs",
            include_str!("../review_window/reply_pictures.rs"),
        ),
        ("composer.rs", include_str!("../composer.rs")),
        ("open_gate.rs", include_str!("../open_gate.rs")),
        ("agent_browser.rs", include_str!("../agent_browser.rs")),
        ("fit_picture.rs", include_str!("../fit_picture.rs")),
    ];
    for (name, source) in sources {
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        // (`to_image_data` is GPUI's own, within `image_budget`'s limits.)
        for banned in [
            "image::open(",
            "ImageReader::new",
            "img(PathBuf::from(",
            "img(std::path::PathBuf::from(",
            "PathBuf::from(path).into()",
            "fit_bytes",
        ] {
            assert!(!code.contains(banned), "{name}: {banned}");
        }
        // A thread's picture bytes go to `bytes_source`, never straight to
        // GPUI (the folder and page symbols and a project's blurred
        // backdrop, made by the app, may).
        if !matches!(name, "folders.rs" | "projects_page.rs") {
            assert!(!code.contains("ImageSource::Image("), "{name}");
        }
        // Thumbnails the app makes are kept as PNGs and drawn through the
        // books, never as pixels of their own that only grow (round 4).
        if matches!(name, "file_thumbs.rs" | "folders.rs") {
            assert!(!code.contains("to_image_data"), "{name}");
            assert!(!code.contains("ImageSource::Render("), "{name}");
        }
    }
    let markdown = include_str!("../rows/markdown.rs");
    assert!(markdown.contains("crate::fit_picture::file_source("));
    // A media card's thumbnail too (round 5).
    let links = include_str!("../reply_links.rs");
    let links = links.split("#[cfg(test)]").next().unwrap_or(links);
    assert!(!links.contains("to_image_data"));
}

// Daybreak 170, round 4: groups inside a pattern weren't counted, and the
// tile itself had no limit.
#[test]
fn an_svg_patterns_tile_and_whats_in_it_are_counted() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let patterned = |cell: u32, depth: usize| {
        let mut svg = String::from(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><pattern id="p" patternUnits="userSpaceOnUse" "#,
        );
        svg.push_str(&format!(r#"width="{cell}" height="{cell}">"#));
        for _ in 0..depth {
            svg.push_str(&format!(
                r#"<g opacity="0.5"><rect width="{cell}" height="{cell}"/>"#
            ));
        }
        for _ in 0..depth {
            svg.push_str("</g>");
        }
        svg.push_str(r#"<rect width="2" height="2"/></pattern></defs><rect width="1024" height="1024" fill="url(#p)"/></svg>"#);
        svg
    };
    // Stripes and dots, as icons use them, still draw.
    assert!(super::decode(patterned(8, 0).as_bytes(), &renderer).is_ok());
    assert!(super::decode(patterned(8, 2).as_bytes(), &renderer).is_ok());
    // Codex's: a canvas-sized cell, 100 layers deep in it.
    assert!(super::decode(patterned(1024, 100).as_bytes(), &renderer).is_err());
    // A cell far bigger than the canvas is a tile that size.
    assert!(super::decode(patterned(200_000, 0).as_bytes(), &renderer).is_err());
}

// A layer is its group's box, which resvg lets grow to 5 canvases each
// way, not the canvas: a few such layers are many canvases.
#[test]
fn an_svg_layer_bigger_than_its_canvas_is_counted_at_its_size() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let wide = |depth: usize| {
        let mut svg =
            String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">"#);
        for _ in 0..depth {
            svg.push_str(
                r#"<g opacity="0.5"><rect x="-1024" y="-1024" width="2560" height="2560"/>"#,
            );
        }
        for _ in 0..depth {
            svg.push_str("</g>");
        }
        svg.push_str("</svg>");
        svg
    };
    assert!(super::decode(wide(1).as_bytes(), &renderer).is_ok());
    // The first is 25 canvases (a 512 square is drawn at 1,024); resvg
    // cuts the ones inside it smaller. A handful no longer fit.
    assert!(super::decode(wide(8).as_bytes(), &renderer).is_err());
}

// Daybreak 170, round 5: a filter works in its own region, which resvg
// doesn't cut to the layer, and a drop shadow holds several copies of it.
#[test]
fn an_svg_filter_is_counted_at_its_own_region() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    // Codex's: a flood over a region 20,000 square at the drawn scale.
    let flood = br#"<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><filter id="f" filterUnits="userSpaceOnUse" x="-5000" y="-5000" width="10000" height="10000"><feFlood flood-color="red"/></filter></defs><g filter="url(#f)"><rect width="256" height="256"/></g></svg>"#;
    assert!(super::decode(flood, &renderer).is_err());
    // Codex's: a drop shadow over a region bigger than the canvas.
    let shadow = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="1440" height="1440"><feDropShadow stdDeviation=".5"/></filter></defs><g filter="url(#f)"><rect width="1024" height="1024"/></g></svg>"#;
    assert!(super::decode(shadow, &renderer).is_err());
    // An icon's own shadow still draws.
    let icon = br#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><filter id="f"><feDropShadow dx="1" dy="1" stdDeviation="2"/></filter></defs><g filter="url(#f)"><rect x="8" y="8" width="48" height="48"/></g></svg>"#;
    assert!(super::decode(icon, &renderer).is_ok());
}

// Daybreak 170, round 5 (Gemini's): nested `<use>`s copy a long path
// thousands of times while the tree is built, before anything is drawn.
#[test]
fn an_svg_whose_uses_multiply_its_paths_isnt_made_into_a_tree() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let tens = |levels: usize, segments: usize| {
        let mut svg = String::from(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><defs><path id="g0" d="M0 0"#,
        );
        for _ in 0..segments {
            svg.push_str(" l1 1");
        }
        svg.push_str(r#""/>"#);
        for level in 1..=levels {
            svg.push_str(&format!(r#"<g id="g{level}">"#));
            for _ in 0..10 {
                svg.push_str(&format!(r##"<use xlink:href="#g{}"/>"##, level - 1));
            }
            svg.push_str("</g>");
        }
        svg.push_str(&format!(r##"</defs><use href="#g{levels}"/></svg>"##));
        svg
    };
    // An icon reusing a part a few times draws.
    assert!(super::decode(tens(1, 20).as_bytes(), &renderer).is_ok());
    // A long path copied ten thousand times doesn't.
    assert!(super::decode(tens(4, 5_000).as_bytes(), &renderer).is_err());
    // Nor does one that names itself.
    let looped = br##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><g id="a"><use href="#a"/></g></svg>"##;
    assert!(renderer.render_single_frame(looped, 1.0).is_err());
}

// Daybreak 170, round 6: a marker is copied to every point it marks, and
// may be set from a style sheet or inherited over a `<use>`.
#[test]
fn an_svg_whose_markers_multiply_its_paths_isnt_made_into_a_tree() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let path = |segments: usize| {
        let mut d = String::from("M0 0");
        for _ in 0..segments {
            d.push_str(" l1 1");
        }
        d
    };
    // Codex's: from a sheet.
    let sheet = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><marker id="m" markerWidth="1" markerHeight="1"><path d="{}"/></marker></defs><style>.marked {{ marker-mid: url(#m) }}</style><path class="marked" d="{}"/></svg>"#,
        path(5_000),
        path(50_000)
    );
    assert!(super::decode(sheet.as_bytes(), &renderer).is_err());
    // Gemini's: inherited over a `<use>`.
    let used = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><marker id="m" markerWidth="1" markerHeight="1"><path d="{}"/></marker><path id="p" d="{}"/></defs><g marker-mid="url(#m)"><use href="#p"/></g></svg>"##,
        path(20_000),
        path(10_000)
    );
    assert!(super::decode(used.as_bytes(), &renderer).is_err());
    // A diagram's arrows still draw.
    let mut arrows = String::from(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><marker id="a" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>"#,
    );
    for i in 0..200 {
        arrows.push_str(&format!(
            r#"<line x1="0" y1="{i}" x2="300" y2="{i}" stroke="black" marker-end="url(#a)"/>"#
        ));
    }
    arrows.push_str("</svg>");
    // A diagram's arrows still draw.
    assert!(super::decode(arrows.as_bytes(), &renderer).is_ok());
}

// Daybreak 170, round 6: what's checked before the tree is built can't be
// made to run out of stack, or expand entities without a limit.
#[test]
fn an_svg_nested_too_deep_or_with_entities_isnt_read() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let mut deep = String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">"#);
    for _ in 0..100_000 {
        deep.push_str("<g>");
    }
    deep.push_str(r#"<rect width="8" height="8"/>"#);
    for _ in 0..100_000 {
        deep.push_str("</g>");
    }
    deep.push_str("</svg>");
    assert!(renderer.render_single_frame(deep.as_bytes(), 1.0).is_err());
    let laughs = br#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>&b;</text></svg>"#;
    assert!(renderer.render_single_frame(laughs, 1.0).is_err());
    // A plain DOCTYPE, as Illustrator writes, is fine.
    let illustrator = br#"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>"#;
    assert!(renderer.render_single_frame(illustrator, 1.0).is_ok());
}

// Daybreak 170, round 6 (Gemini's): a wait that began while a clear-out
// was already looking doesn't give up on what that one saw.
#[test]
fn a_wait_gives_up_only_on_a_look_taken_after_it_began() {
    let now = Instant::now();
    let mut books = Books::new(1000);
    assert!(books.try_reserve(950).unwrap());
    books.keep("a".into(), ready(15, 15), 950, now);
    assert!(!books.try_reserve(700).unwrap());
    let settle = Duration::from_secs(1);
    assert!(matches!(books.clear_out(now, settle), ClearOut::LookAgain));
    // This wait begins after that look started.
    let since = books.cleared();
    books.drawn("a", now + settle / 2);
    assert!(!books.try_reserve(700).unwrap());
    assert!(matches!(
        books.clear_out(now + settle, settle),
        ClearOut::Gone(_)
    ));
    assert!(!books.stuck(since));
    // The next look, after it began, counts.
    assert!(!books.try_reserve(700).unwrap());
    let later = now + settle * 2;
    assert!(matches!(
        books.clear_out(later, settle),
        ClearOut::LookAgain
    ));
    books.drawn("a", later + settle / 2);
    assert!(matches!(
        books.clear_out(later + settle, settle),
        ClearOut::Gone(_)
    ));
    assert!(books.stuck(since));
}

// Daybreak 170, rounds 7 and 8: a picture's SVG is drawn in a process held
// to its share (svg_worker.rs), and has no text or pictures in it.
#[test]
fn a_pictures_svg_has_no_text_or_pictures_in_it() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let logo = br##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 64 64"><title>Logo</title><sodipodi:namedview/><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath><symbol id="s"><rect width="8" height="8"/></symbol></defs><g clip-path="url(#c)" opacity="0.9"><rect width="64" height="64" fill="url(#g)"/><use xlink:href="#s" x="4"/><use href="#s" x="20"/><path d="M0 0L64 64" stroke="#000" stroke-width="2"/><polygon points="0,0 8,0 4,8"/><line x2="10" y2="10" stroke="red"/></g></svg>"##;
    assert!(super::decode(logo, &renderer).is_ok());
    for (what, inner) in [
        ("text", "<text>@</text>"),
        ("tspan", "<tspan>@</tspan>"),
        ("image", r#"<image href="x.png"/>"#),
        (
            "feImage",
            r#"<filter id="f"><feImage href="x.png"/></filter>"#,
        ),
        ("foreignObject", "<foreignObject/>"),
    ] {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">{inner}<rect width="8" height="8"/></svg>"#
        );
        assert!(super::decode(svg.as_bytes(), &renderer).is_err(), "{what}");
    }
    // Gemini's: a chain of copies whose depth hid behind what was already
    // counted. 15 blocks of 240 groups, each using the one before.
    let mut chain =
        String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><defs>"#);
    for block in 1..=15 {
        chain.push_str(&format!(r#"<g id="b{block}">"#));
        for _ in 0..240 {
            chain.push_str("<g>");
        }
        if block == 1 {
            chain.push_str(r#"<rect width="1" height="1"/>"#);
        } else {
            chain.push_str(&format!(r##"<use href="#b{}"/>"##, block - 1));
        }
        for _ in 0..240 {
            chain.push_str("</g>");
        }
        chain.push_str("</g>");
    }
    chain.push_str(r##"</defs><use href="#b15"/></svg>"##);
    assert!(super::decode(chain.as_bytes(), &renderer).is_err());
}

// Threadbear's patch (Daybreak 170): the app's own icons may have
// patterns, filters and markers, counted at the sizes resvg makes them.
#[test]
fn an_icons_layers_tiles_filters_and_markers_are_counted() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let icon = |svg: &str| renderer.draws_icon(svg.as_bytes(), 2.);
    let patterned = |cell: u32, depth: usize| {
        let mut svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="{cell}" height="{cell}">"#
        );
        for _ in 0..depth {
            svg.push_str(&format!(
                r#"<g opacity="0.5"><rect width="{cell}" height="{cell}"/>"#
            ));
        }
        for _ in 0..depth {
            svg.push_str("</g>");
        }
        svg.push_str(r#"<rect width="2" height="2"/></pattern></defs><rect width="1024" height="1024" fill="url(#p)"/></svg>"#);
        svg
    };
    assert!(icon(&patterned(8, 2)));
    assert!(!icon(&patterned(1024, 100)));
    assert!(!icon(&patterned(200_000, 0)));
    let shadow = r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><filter id="f"><feDropShadow dx="1" dy="1" stdDeviation="2"/></filter></defs><g filter="url(#f)"><rect x="8" y="8" width="48" height="48"/></g></svg>"#;
    assert!(icon(shadow));
    let flood = r#"<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><filter id="f" filterUnits="userSpaceOnUse" x="-5000" y="-5000" width="10000" height="10000"><feFlood flood-color="red"/></filter></defs><g filter="url(#f)"><rect width="256" height="256"/></g></svg>"#;
    assert!(!icon(flood));
    let arrow = r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><marker id="a" markerWidth="10" markerHeight="10"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><line x2="50" y2="50" stroke="black" marker-end="url(#a)"/></svg>"#;
    assert!(icon(arrow));
}

// Daybreak 170, round 7: a picture's SVG is drawn in a process of its own
// (svg_worker.rs); what it answers is read back held to the same limits.
// Here the "process" is this one, so every SVG test after it goes through
// the same answer too.
#[test]
fn a_pictures_svg_comes_back_from_its_drawing_process() {
    fn here(bytes: &[u8], scale: f32) -> Option<Vec<u8>> {
        Some(gpui_kit::SvgRenderer::new(Arc::new(())).picture_answer(bytes, scale))
    }
    gpui_kit::set_picture_drawer(here);
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>"#;
    let drawn = renderer.render_single_frame(svg, 1.0).unwrap();
    let here = renderer.render_single_frame_here(svg, 1.0).unwrap();
    assert_eq!(drawn.size(0), here.size(0));
    assert_eq!(drawn.as_bytes(0), here.as_bytes(0));
    // Through the books, the same picture.
    assert!(super::decode(svg, &renderer).is_ok());
    // Refused there: too big, so it isn't tried again.
    let text =
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>@</text></svg>"#;
    assert_eq!(
        image_budget::render_svg(text, &renderer).err(),
        Some(Refused::TooBig)
    );
}

/// A zlib stream that inflates to about `bytes` zero bytes, in a fraction
/// of that: a literal zero, then matches of 258 a byte back (fixed Huffman).
fn zlib_of_zeros(bytes: usize) -> Vec<u8> {
    struct Bits {
        out: Vec<u8>,
        acc: u32,
        n: u32,
    }
    impl Bits {
        // LSB first, as deflate packs its fields.
        fn put(&mut self, value: u32, len: u32) {
            for i in 0..len {
                self.acc |= ((value >> i) & 1) << self.n;
                self.n += 1;
                if self.n == 8 {
                    self.out.push(self.acc as u8);
                    self.acc = 0;
                    self.n = 0;
                }
            }
        }
        // Huffman codes go most significant bit first.
        fn code(&mut self, code: u32, len: u32) {
            for i in (0..len).rev() {
                self.put((code >> i) & 1, 1);
            }
        }
    }
    let mut bits = Bits {
        out: vec![0x78, 0x01],
        acc: 0,
        n: 0,
    };
    bits.put(1, 1); // last block
    bits.put(1, 2); // fixed Huffman
    bits.code(0x30, 8); // literal 0
    for _ in 0..bytes / 258 {
        bits.code(0b1100_0101, 8); // length 258
        bits.code(0, 5); // distance 1
    }
    bits.code(0, 7); // end of block
    bits.put(0, 7);
    bits.out.extend_from_slice(&[0, 0, 0, 1]); // (Adler-32, not checked first)
    bits.out
}

// Daybreak 170, round 9 (Codex's): learning a PNG's size made the image
// crate inflate its colour profile, up to its own 512 MB default, before
// anything was reserved for it.
#[test]
fn a_pngs_size_is_read_without_inflating_a_huge_profile() {
    let mut bomb = png_header(1, 1, 6);
    // Its IDAT and the rest after the profile: put the iCCP just after IHDR.
    let after_ihdr = 8 + 4 + 4 + 13 + 4;
    let mut iccp = b"iCCP".to_vec();
    iccp.extend_from_slice(b"p\0\0");
    iccp.extend_from_slice(&zlib_of_zeros(300 * 1024 * 1024));
    let mut chunk = ((iccp.len() - 4) as u32).to_be_bytes().to_vec();
    chunk.extend_from_slice(&iccp);
    chunk.extend_from_slice(&crc32(&iccp).to_be_bytes());
    bomb.splice(after_ihdr..after_ihdr, chunk);
    assert!(bomb.len() < 2 * 1024 * 1024);
    let started = Instant::now();
    // Its size comes from its header, the profile never read.
    assert_eq!(image_budget::size_of(&bomb), Some((1, 1)));
    // Decoded without it (here its pixels are empty, so it doesn't draw).
    assert!(!image_budget::png_without_compressed_extras(&bomb)
        .windows(4)
        .any(|w| w == b"iCCP"));
    let _ = super::decode(&bomb, &gpui_kit::SvgRenderer::new(Arc::new(())));
    // Not after inflating 300 MB.
    assert!(started.elapsed() < Duration::from_secs(5));
    // A real picture with a profile still draws.
    let mut real = png(4, 4);
    let mut iccp = b"iCCP".to_vec();
    iccp.extend_from_slice(b"p\0\0");
    iccp.extend_from_slice(&zlib_of_zeros(1024));
    let mut chunk = ((iccp.len() - 4) as u32).to_be_bytes().to_vec();
    chunk.extend_from_slice(&iccp);
    chunk.extend_from_slice(&crc32(&iccp).to_be_bytes());
    real.splice(after_ihdr..after_ihdr, chunk);
    assert!(super::decode(&real, &gpui_kit::SvgRenderer::new(Arc::new(()))).is_ok());
    // What's reserved for any picture covers what its header may hold.
    assert!(peak_bytes(0, Some((1, 1)), false, &LIMITS) >= image_budget::METADATA_BYTES);
}

// Daybreak 170, round 9 (Codex's): a WebP's frame is decoded at its own
// bitstream's size before that's checked against the canvas.
#[test]
fn a_webp_frame_bigger_than_its_canvas_isnt_decoded() {
    let chunk = |fourcc: &[u8], data: &[u8]| {
        let mut c = fourcc.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    };
    let riff = |body: Vec<u8>| {
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        b.extend_from_slice(b"WEBP");
        b.extend_from_slice(&body);
        b
    };
    // A VP8 key frame's header saying 16,383 square.
    let mut vp8 = vec![0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a];
    vp8.extend_from_slice(&0x3fffu16.to_le_bytes());
    vp8.extend_from_slice(&0x3fffu16.to_le_bytes());
    vp8.extend_from_slice(&[0; 32]);
    // ...inside a 1 x 1 canvas.
    let mut vp8x = vec![0u8; 10];
    let lying = riff([chunk(b"VP8X", &vp8x), chunk(b"VP8 ", &vp8)].concat());
    assert!(!image_budget::webp_frames_fit(&lying));
    assert_eq!(
        super::decode(&lying, &gpui_kit::SvgRenderer::new(Arc::new(()))).err(),
        Some(Refused::TooBig)
    );
    // The same frame in a canvas its size fits (and is then too big anyway).
    vp8x[4..7].copy_from_slice(&[0xfe, 0x3f, 0]);
    vp8x[7..10].copy_from_slice(&[0xfe, 0x3f, 0]);
    assert!(image_budget::webp_frames_fit(&riff(
        [chunk(b"VP8X", &vp8x), chunk(b"VP8 ", &vp8)].concat()
    )));
    // Real ones fit.
    assert!(image_budget::webp_frames_fit(&animated_webp(8, 8, 3)));
}

// The most an SVG's drawing reserves (svg_worker.rs) fits the budget.
#[test]
fn an_svgs_drawing_fits_the_budget() {
    let most = crate::svg_worker::held_for(image_budget::SVG_MAX_BYTES as u64);
    assert!(most < BUDGET_BYTES, "{most}");
}

// Daybreak 170, round 10 (Gemini's): the image crate this build links reads
// OpenEXR, ICO and more, and an EXR file declaring thousands of channels, or
// an ICO whose PNG inflates its colour profile before any limit is set,
// allocated by what the file said. Only the kinds a thread's pictures are
// get decoded, whatever the file is called.
#[test]
fn a_picture_of_a_kind_not_read_here_isnt_decoded() {
    let renderer = gpui_kit::SvgRenderer::new(Arc::new(()));
    let encoded = |format: image::ImageFormat| {
        let mut bytes = Vec::new();
        let picture = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            4,
            4,
            image::Rgba([9, 9, 9, 255]),
        ));
        let picture = match format {
            image::ImageFormat::OpenExr => image::DynamicImage::ImageRgba32F(picture.to_rgba32f()),
            image::ImageFormat::Jpeg => image::DynamicImage::ImageRgb8(picture.to_rgb8()),
            _ => picture,
        };
        picture
            .write_to(&mut std::io::Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    };
    for format in [image::ImageFormat::OpenExr, image::ImageFormat::Ico] {
        let bytes = encoded(format);
        assert_eq!(image::guess_format(&bytes).unwrap(), format);
        assert_eq!(image_budget::readable(&bytes), None, "{format:?}");
        assert_eq!(image_budget::size_of(&bytes), None, "{format:?}");
        assert!(
            matches!(
                image_budget::decode(&bytes, &LIMITS).err(),
                Some(Refused::Unreadable(_))
            ),
            "{format:?}"
        );
        assert!(super::decode(&bytes, &renderer).is_err(), "{format:?}");
        // GPUI's own loaders hold to it too.
        let image = gpui_kit::Image::from_bytes(gpui_kit::ImageFormat::Png, bytes);
        assert!(image.to_image_data(renderer.clone()).is_err(), "{format:?}");
    }
    // The kinds a thread's pictures are still draw.
    for format in [
        image::ImageFormat::Png,
        image::ImageFormat::Jpeg,
        image::ImageFormat::Gif,
        image::ImageFormat::WebP,
        image::ImageFormat::Bmp,
        image::ImageFormat::Tiff,
    ] {
        let bytes = encoded(format);
        assert_eq!(image_budget::size_of(&bytes), Some((4, 4)), "{format:?}");
        let decoded = image_budget::decode(&bytes, &LIMITS).unwrap();
        assert_eq!(decoded.source, (4, 4), "{format:?}");
    }
}

// Daybreak 170, round 10 (Gemini's): the WebP check walked on past what the
// RIFF header says the file holds, so a real WebP with bytes after it (a
// download's padding) didn't draw.
#[test]
fn a_webps_check_reads_only_what_its_riff_holds() {
    let mut padded = animated_webp(8, 8, 3);
    padded.extend_from_slice(b"pad");
    assert!(image_budget::webp_frames_fit(&padded));
    assert_eq!(image_budget::size_of(&padded), Some((8, 8)));
    // Its size is read from its first chunk, without a decoder.
    let still = {
        let mut bytes = Vec::new();
        image::RgbaImage::from_pixel(5, 3, image::Rgba([0, 0, 0, 255]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::WebP,
            )
            .unwrap();
        bytes
    };
    assert_eq!(image_budget::size_of(&still), Some((5, 3)));
    assert!(image_budget::decode(&still, &LIMITS).is_ok());
}

// Daybreak 170, round 10 (Gemini's, test gaps): an animated WebP's frame
// must sit inside its canvas, and its own bitstream (VP8L here) must be the
// frame's size.
#[test]
fn an_animated_webps_frames_are_checked_against_their_canvas() {
    let good = animated_webp(8, 8, 2);
    assert!(image_budget::webp_frames_fit(&good));
    // The first ANMF: after "RIFF....WEBP", VP8X (8 + 10) and ANIM (8 + 6).
    let anmf = 12 + 18 + 14;
    assert_eq!(&good[anmf..anmf + 4], b"ANMF");
    let body = anmf + 8;
    // A frame placed past the canvas's edge.
    let mut moved = good.clone();
    moved[body] = 1; // x = 2
    assert!(!image_budget::webp_frames_fit(&moved));
    // A frame header saying 4 x 4 round an 8 x 8 VP8L bitstream.
    let mut smaller = good;
    smaller[body + 6] = 3;
    smaller[body + 9] = 3;
    assert!(!image_budget::webp_frames_fit(&smaller));
    assert!(image_budget::decode(&smaller, &LIMITS).is_err());
}

// Daybreak 170, rounds 10 and 11 (Gemini's): an SVG waits for its drawing
// turn holding its bytes, so a repo's queue of 4 MB icons filled the room a
// thread's pictures wait in, and then the room the viewer's pictures wait in.
// An SVG's bytes move to room of their own once they're known to be one,
// and when that's full it's tried later, holding nothing.
#[test]
fn svgs_waiting_their_turn_hold_up_no_other_picture() {
    let mut books = Books::new(1000);
    let svg = image_budget::SVG_MAX_BYTES as u64;
    let mut queued = 0;
    while books.try_wait(Reads::Svg, svg) {
        queued += 1;
    }
    assert_eq!(queued, 4);
    // Pictures of every other kind still get in.
    assert!(books.try_wait(Reads::Here, FILE_MAX_BYTES));
    assert!(books.try_wait(Reads::Remote, FILE_MAX_BYTES));
    // An SVG waits in `Here` only until it's moved, then not at all.
    let svg_bytes = br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>"#;
    assert!(image_budget::is_svg(svg_bytes));
    let source = include_str!("../fit_picture.rs");
    let kept = &source[source.find("pub(crate) async fn decode_kept").unwrap()..];
    let moved = kept.find("move_to(Reads::Svg)").unwrap();
    assert!(moved < kept.find("SVG_TURN.lock()").unwrap());
    // A file is looked at, then waits for room, and only then is opened.
    let loads = &source[source.find("fn budgeted(").unwrap()..];
    let room = loads.find("reader(Reads::Here, len").unwrap();
    assert!(loads.find("file_len(").unwrap() < room);
    assert!(room < loads.find("open_file(&path)").unwrap());
}

// Daybreak 170, round 12 (Gemini's): every WebP was taken as one that may
// move, so a still screenshot reserved room for 600 frames, a quarter of
// the budget. One whose VP8X says it's still reserves as a still picture,
// and an animated one still plays.
#[test]
fn a_still_webp_reserves_as_a_still_picture() {
    let still = {
        let mut bytes = Vec::new();
        image::RgbaImage::from_pixel(1024, 1024, image::Rgba([0, 0, 0, 255]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::WebP,
            )
            .unwrap();
        bytes
    };
    assert!(!image_budget::may_move(&still));
    let size = image_budget::size_of(&still);
    assert!(
        peak_bytes(
            still.len() as u64,
            size,
            image_budget::may_move(&still),
            &LIMITS
        ) < 64 * 1024 * 1024
    );
    let moving = animated_webp(8, 8, 3);
    assert!(image_budget::may_move(&moving));
    assert_eq!(decode(&moving, &LIMITS).unwrap().frames.len(), 3);
    // A GIF may always move.
    let mut gif = Vec::new();
    image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 0, 255]))
        .write_to(&mut std::io::Cursor::new(&mut gif), image::ImageFormat::Gif)
        .unwrap();
    assert!(image_budget::may_move(&gif));
}

// Daybreak 170, round 12 (Gemini's): `decode_now` holds its thread while it
// waits for room, and folder entries, project cards and cut-outs went
// straight to background threads to call it, parking the pool. Each takes
// its turn on its own task first.
#[test]
fn decode_now_is_waited_for_off_the_background_threads() {
    for (name, source) in [
        ("folders.rs", include_str!("../folders.rs")),
        ("projects_page.rs", include_str!("../projects_page.rs")),
        (
            "review_window/canvas.rs",
            include_str!("../review_window/canvas.rs"),
        ),
        ("file_thumbs.rs", include_str!("../file_thumbs.rs")),
    ] {
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let turn = code
            .find("decode_now_turn")
            .unwrap_or_else(|| panic!("{name}"));
        let work = code[turn..]
            .find("background")
            .unwrap_or_else(|| panic!("{name}"));
        assert!(work < 400, "{name}");
    }
}
