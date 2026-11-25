use crate::{
    AssetSource, DevicePixels, IsZero, RenderImage, Result, SharedString, Size,
    swap_rgba_pa_to_bgra,
};
use image::Frame;
use resvg::tiny_skia::{IntRect, Pixmap, Transform};
use smallvec::SmallVec;
use std::{
    hash::Hash,
    sync::{Arc, LazyLock, OnceLock},
};

#[cfg(target_os = "macos")]
const EMOJI_FONT_FAMILIES: &[&str] = &["Apple Color Emoji", ".AppleColorEmojiUI"];

#[cfg(target_os = "windows")]
const EMOJI_FONT_FAMILIES: &[&str] = &["Segoe UI Emoji", "Segoe UI Symbol"];

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
const EMOJI_FONT_FAMILIES: &[&str] = &[
    "Noto Color Emoji",
    "Emoji One",
    "Twitter Color Emoji",
    "JoyPixels",
];

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    target_os = "linux",
    target_os = "freebsd",
)))]
const EMOJI_FONT_FAMILIES: &[&str] = &[];

fn is_emoji_presentation(c: char) -> bool {
    static EMOJI_PRESENTATION_REGEX: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new("\\p{Emoji_Presentation}").unwrap());
    let mut buf = [0u8; 4];
    EMOJI_PRESENTATION_REGEX.is_match(c.encode_utf8(&mut buf))
}

fn font_has_char(db: &usvg::fontdb::Database, id: usvg::fontdb::ID, ch: char) -> bool {
    db.with_face_data(id, |font_data, face_index| {
        ttf_parser::Face::parse(font_data, face_index)
            .ok()
            .and_then(|face| face.glyph_index(ch))
            .is_some()
    })
    .unwrap_or(false)
}

fn select_emoji_font(
    ch: char,
    fonts: &[usvg::fontdb::ID],
    db: &usvg::fontdb::Database,
    families: &[&str],
) -> Option<usvg::fontdb::ID> {
    for family_name in families {
        let query = usvg::fontdb::Query {
            families: &[usvg::fontdb::Family::Name(family_name)],
            weight: usvg::fontdb::Weight(400),
            stretch: usvg::fontdb::Stretch::Normal,
            style: usvg::fontdb::Style::Normal,
        };

        let Some(id) = db.query(&query) else {
            continue;
        };

        if fonts.contains(&id) || !font_has_char(db, id, ch) {
            continue;
        }

        return Some(id);
    }

    None
}

/// When rendering SVGs, we render them at twice the size to get a higher-quality result.
pub const SMOOTH_SVG_SCALE_FACTOR: f32 = 2.;

#[derive(Clone, PartialEq, Hash, Eq)]
#[expect(missing_docs)]
pub struct RenderSvgParams {
    pub path: SharedString,
    pub size: Size<DevicePixels>,
}

#[derive(Clone)]
/// A struct holding everything necessary to render SVGs.
pub struct SvgRenderer {
    asset_source: Arc<dyn AssetSource>,
    usvg_options: Arc<usvg::Options<'static>>,
}

/// A parsed SVG document that can be rasterized at any scale.
///
/// Produced by [`SvgRenderer::parse_svg`] and rasterized by
/// [`SvgRenderer::render_parsed`]. Parsing resolves fonts and converts text
/// to paths, so callers that need to rasterize the same SVG at multiple
/// scales should retain this value to avoid re-paying the parse cost.
pub struct ParsedSvg(usvg::Tree);

/// The size in which to rasterize the SVG.
#[derive(Clone, Copy)]
pub enum SvgSize {
    /// A width in device pixels. The SVG retains its aspect ratio.
    Size(Size<DevicePixels>),
    /// An exact width and height in device pixels.
    ExactSize(Size<DevicePixels>),
    /// A logical scaling factor to apply to the size provided by the SVG.
    ScaleFactor(f32),
}

impl From<f32> for SvgSize {
    fn from(scale_factor: f32) -> Self {
        Self::ScaleFactor(scale_factor)
    }
}

impl SvgRenderer {
    /// Creates a new SVG renderer with the provided asset source.
    pub fn new(asset_source: Arc<dyn AssetSource>) -> Self {
        static SYSTEM_FONT_DB: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        });

        // Build the enriched font DB lazily on first SVG render rather than
        // eagerly at construction time. This avoids the expensive deep-clone
        // of the system font database for code paths that never render SVGs
        // (e.g. tests).
        let enriched_fontdb: Arc<OnceLock<Arc<usvg::fontdb::Database>>> = Arc::new(OnceLock::new());

        let default_font_resolver = usvg::FontResolver::default_font_selector();
        let font_resolver = Box::new({
            let asset_source = asset_source.clone();
            move |font: &usvg::Font, db: &mut Arc<usvg::fontdb::Database>| {
                if db.is_empty() {
                    let fontdb = enriched_fontdb.get_or_init(|| {
                        let mut db = (**SYSTEM_FONT_DB).clone();
                        load_bundled_fonts(&*asset_source, &mut db);
                        fix_generic_font_families(&mut db);
                        Arc::new(db)
                    });
                    *db = fontdb.clone();
                }
                if let Some(id) = default_font_resolver(font, db) {
                    return Some(id);
                }
                // fontdb doesn't recognize CSS system font keywords like "system-ui"
                // or "ui-sans-serif", so fall back to sans-serif before any face.
                let sans_query = usvg::fontdb::Query {
                    families: &[usvg::fontdb::Family::SansSerif],
                    ..Default::default()
                };
                db.query(&sans_query)
                    .or_else(|| db.faces().next().map(|f| f.id))
            }
        });
        let default_fallback_selection = usvg::FontResolver::default_fallback_selector();
        let fallback_selection = Box::new(
            move |ch: char, fonts: &[usvg::fontdb::ID], db: &mut Arc<usvg::fontdb::Database>| {
                if is_emoji_presentation(ch) {
                    if let Some(id) = select_emoji_font(ch, fonts, db.as_ref(), EMOJI_FONT_FAMILIES)
                    {
                        return Some(id);
                    }
                }

                default_fallback_selection(ch, fonts, db)
            },
        );
        let options = usvg::Options {
            font_resolver: usvg::FontResolver {
                select_font: font_resolver,
                select_fallback: fallback_selection,
            },
            // Threadbear's patch (Daybreak 170): an SVG's `<image>` draws
            // nothing. Its embedded or linked pictures would otherwise be
            // read from disk or decoded by resvg whole, outside
            // `image_budget`'s limits.
            image_href_resolver: usvg::ImageHrefResolver {
                resolve_data: Box::new(|_, _, _| None),
                resolve_string: Box::new(|_, _| None),
            },
            ..Default::default()
        };
        Self {
            asset_source,
            usvg_options: Arc::new(options),
        }
    }

    /// Parses SVG data into a [`ParsedSvg`] that can be rasterized at any scale.
    ///
    /// Threadbear's patch (Daybreak 170): a picture's SVG may be anyone's (a
    /// repo's icon, a patch's panel), so it's held to `PICTURE_ELEMENTS`;
    /// the app's own icons (`render_alpha_mask`) aren't.
    pub fn parse_svg(&self, bytes: &[u8]) -> Result<ParsedSvg, usvg::Error> {
        checked_tree(bytes, &self.usvg_options, Elements::Picture).map(ParsedSvg)
    }

    /// Rasterizes a previously parsed SVG into an image buffer.
    pub fn render_parsed(
        &self,
        svg: &ParsedSvg,
        size: impl Into<SvgSize>,
    ) -> Result<Arc<RenderImage>, usvg::Error> {
        let (size, image_scale_factor) = match size.into() {
            SvgSize::Size(size) => (SvgSize::Size(size), 1.0),
            SvgSize::ExactSize(size) => (SvgSize::ExactSize(size), 1.0),
            SvgSize::ScaleFactor(scale_factor) => (
                SvgSize::ScaleFactor(scale_factor * SMOOTH_SVG_SCALE_FACTOR),
                SMOOTH_SVG_SCALE_FACTOR,
            ),
        };
        let pixmap = rasterize_tree(&svg.0, size)?;
        let mut buffer =
            image::ImageBuffer::from_raw(pixmap.width(), pixmap.height(), pixmap.take()).unwrap();

        for pixel in buffer.chunks_exact_mut(4) {
            swap_rgba_pa_to_bgra(pixel);
        }

        let mut image = RenderImage::new(SmallVec::from_const([Frame::new(buffer)]));
        image.scale_factor = image_scale_factor;
        Ok(Arc::new(image))
    }

    /// Renders the given bytes into an image buffer.
    ///
    /// Threadbear's patch (Daybreak 170): a picture's SVG may be anyone's,
    /// so when the app has said how (`set_picture_drawer`), it's drawn in a
    /// process of its own that can't take more than its share of memory or
    /// time, and one that would is refused as too big. Seven rounds of
    /// reviews found ways round every estimate of what usvg and resvg would
    /// allocate; the process is the limit that holds.
    pub fn render_single_frame(
        &self,
        bytes: &[u8],
        scale_factor: f32,
    ) -> Result<Arc<RenderImage>, usvg::Error> {
        self.render_picture(bytes, scale_factor).map_err(|refused| match refused {
            PictureRefused::TooBig => usvg::Error::ElementsLimitReached,
            PictureRefused::TryLater | PictureRefused::Unreadable => usvg::Error::InvalidSize,
        })
    }

    /// `render_single_frame`, saying why not as the picture budget needs to.
    pub fn render_picture(
        &self,
        bytes: &[u8],
        scale_factor: f32,
    ) -> Result<Arc<RenderImage>, PictureRefused> {
        match PICTURE_DRAWER.get() {
            // No answer: it ran out of room or time, or crashed.
            Some(draw) => match draw(bytes, scale_factor) {
                Some(answer) => read_picture_answer(&answer),
                None => Err(PictureRefused::TooBig),
            },
            None => self
                .render_single_frame_here(bytes, scale_factor)
                .map_err(|e| match e {
                    usvg::Error::ElementsLimitReached => PictureRefused::TooBig,
                    _ => PictureRefused::Unreadable,
                }),
        }
    }

    /// What the drawing process sends back for `bytes` at `scale_factor`
    /// (`read_picture_answer` reads it): the picture, or why not.
    pub fn picture_answer(&self, bytes: &[u8], scale_factor: f32) -> Vec<u8> {
        match self.render_single_frame_here(bytes, scale_factor) {
            Ok(image) => {
                let size = image.size(0);
                let pixels = image.as_bytes(0).unwrap_or_default();
                let mut answer = Vec::with_capacity(16 + pixels.len());
                answer.extend_from_slice(b"SVG1");
                answer.extend_from_slice(&(size.width.0.max(0) as u32).to_le_bytes());
                answer.extend_from_slice(&(size.height.0.max(0) as u32).to_le_bytes());
                answer.extend_from_slice(&image.scale_factor.to_le_bytes());
                answer.extend_from_slice(pixels);
                answer
            }
            Err(usvg::Error::ElementsLimitReached) => b"BIG1".to_vec(),
            Err(_) => b"BAD1".to_vec(),
        }
    }

    /// `render_single_frame` in this process, as the drawing process does.
    pub fn render_single_frame_here(
        &self,
        bytes: &[u8],
        scale_factor: f32,
    ) -> Result<Arc<RenderImage>, usvg::Error> {
        let svg = self.parse_svg(bytes)?;
        self.render_parsed(&svg, scale_factor)
    }

    pub(crate) fn render_alpha_mask(
        &self,
        params: &RenderSvgParams,
        bytes: Option<&[u8]>,
    ) -> Result<Option<(Size<DevicePixels>, Vec<u8>)>> {
        anyhow::ensure!(!params.size.is_zero(), "can't render at a zero size");

        let render_pixmap = |bytes| {
            let pixmap = self.render_pixmap(bytes, SvgSize::Size(params.size))?;

            // Convert the pixmap's pixels into an alpha mask.
            let size = Size::new(
                DevicePixels(pixmap.width() as i32),
                DevicePixels(pixmap.height() as i32),
            );
            let alpha_mask = pixmap
                .pixels()
                .iter()
                .map(|p| p.alpha())
                .collect::<Vec<_>>();

            Ok(Some((size, alpha_mask)))
        };

        if let Some(bytes) = bytes {
            render_pixmap(bytes)
        } else if let Some(bytes) = self.asset_source.load(&params.path)? {
            render_pixmap(&bytes)
        } else {
            Ok(None)
        }
    }

    /// Threadbear's patch (Daybreak 170): whether an icon of the app's own
    /// (any element usvg reads) would be drawn at `scale`, for tests of
    /// what drawing one may hold.
    pub fn draws_icon(&self, bytes: &[u8], scale: f32) -> bool {
        self.render_pixmap(bytes, SvgSize::ScaleFactor(scale)).is_ok()
    }

    fn render_pixmap(&self, bytes: &[u8], size: SvgSize) -> Result<Pixmap, usvg::Error> {
        let tree = checked_tree(bytes, &self.usvg_options, Elements::Any)?;
        rasterize_tree(&tree, size)
    }
}

/// Draws a picture's SVG somewhere safer than here (`render_single_frame`):
/// hands its bytes and scale to the drawing process, which answers with
/// `SvgRenderer::picture_answer`, and gives back that answer, or None when
/// it gave none (out of room or time).
pub type PictureDrawer = fn(&[u8], f32) -> Option<Vec<u8>>;

/// Why a picture's SVG wasn't drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PictureRefused {
    /// It would take more than its share, or took too long.
    TooBig,
    /// The drawing process couldn't start: try again later.
    TryLater,
    /// Not an SVG this reads.
    Unreadable,
}

/// The answer a `PictureDrawer` gives when its process couldn't start.
pub const PICTURE_TRY_LATER: &[u8] = b"TRY1";

/// The most a picture answer may be: its header and `svg_pixels` of BGRA.
pub fn picture_answer_most() -> usize {
    16 + crate::image_budget::DecodeLimits::DEFAULT.svg_pixels as usize * 4
}

/// The picture in a drawing process's answer, held to the same limits as
/// one drawn here: its size, at most `svg_pixels`, and its bytes, exactly.
fn read_picture_answer(answer: &[u8]) -> Result<Arc<RenderImage>, PictureRefused> {
    match answer.get(..4) {
        Some(b"SVG1") => {}
        Some(b"BIG1") => return Err(PictureRefused::TooBig),
        Some(b"TRY1") => return Err(PictureRefused::TryLater),
        _ => return Err(PictureRefused::Unreadable),
    }
    let word = |at: usize| -> Option<[u8; 4]> { answer.get(at..at + 4)?.try_into().ok() };
    let (Some(w), Some(h), Some(scale)) = (word(4), word(8), word(12)) else {
        return Err(PictureRefused::Unreadable);
    };
    let (w, h, scale) = (u32::from_le_bytes(w), u32::from_le_bytes(h), f32::from_le_bytes(scale));
    let pixels = &answer[16..];
    let most = crate::image_budget::DecodeLimits::DEFAULT.svg_pixels;
    if w == 0
        || h == 0
        || u64::from(w) * u64::from(h) > most
        || pixels.len() as u64 != u64::from(w) * u64::from(h) * 4
        || !(scale.is_finite() && scale > 0. && scale <= 8.)
    {
        return Err(PictureRefused::Unreadable);
    }
    let buffer =
        image::ImageBuffer::from_raw(w, h, pixels.to_vec()).ok_or(PictureRefused::Unreadable)?;
    let mut image = RenderImage::new(SmallVec::from_const([Frame::new(buffer)]));
    image.scale_factor = scale;
    Ok(Arc::new(image))
}

static PICTURE_DRAWER: std::sync::OnceLock<PictureDrawer> = std::sync::OnceLock::new();

/// Threadbear's patch (Daybreak 170): from now on, pictures' SVGs are drawn
/// by `draw` (the app's drawing process). Set once, at launch.
pub fn set_picture_drawer(draw: PictureDrawer) {
    let _ = PICTURE_DRAWER.set(draw);
}

/// Threadbear's patch (Daybreak 170): an SVG is parsed only when it's at
/// most `SVG_MAX_BYTES` and not gzipped (usvg would inflate it without a
/// cap), and made into a tree only when what usvg would build from it
/// (`expanded_weight`) is in proportion to its size. What drawing it holds
/// is checked in `rasterize_tree`, once the size it's drawn at is known.
fn checked_tree(
    bytes: &[u8],
    options: &usvg::Options,
    elements: Elements,
) -> Result<usvg::Tree, usvg::Error> {
    if bytes.len() > crate::image_budget::SVG_MAX_BYTES {
        return Err(usvg::Error::ElementsLimitReached);
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Err(usvg::Error::MalformedGZip);
    }
    // As usvg's `from_data` and `from_str` read it. Its own DTD is read
    // (Illustrator writes one), but not entities, which roxmltree expands
    // with no limit on what they come to.
    let text = std::str::from_utf8(bytes).map_err(|_| usvg::Error::NotAnUtf8Str)?;
    if text.contains("<!ENTITY") {
        return Err(usvg::Error::ElementsLimitReached);
    }
    let xml = usvg::roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let doc = usvg::roxmltree::Document::parse_with_options(text, xml)
        .map_err(usvg::Error::ParsingFailed)?;
    if elements == Elements::Picture && !only_picture_elements(&doc) {
        return Err(usvg::Error::ElementsLimitReached);
    }
    if expanded_weight(&doc) > crate::image_budget::svg_weight_most(bytes.len()) {
        return Err(usvg::Error::ElementsLimitReached);
    }
    usvg::Tree::from_xmltree(&doc, options)
}

/// Which SVG elements a drawing may have.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Elements {
    /// The app's own icons: whatever usvg reads.
    Any,
    /// A picture, which may be anyone's: `PICTURE_ELEMENTS` only.
    Picture,
}

/// The SVG elements a picture may have. Not text (each letter becomes a
/// path of its own, from the system's fonts, loaded afresh in each drawing
/// process), pictures in it, or foreign objects. The rest is drawn in a
/// process held to its share of memory and time (svg_worker.rs), which is
/// what holds: seven rounds of reviews found ways round every estimate of
/// what markers, masks, patterns, filters and copies would cost (Daybreak
/// 170); those estimates still refuse what they can see coming.
const PICTURE_ELEMENTS: &[&str] = &[
    "svg", "g", "a", "defs", "symbol", "switch", "use", "path", "rect", "circle", "ellipse", "line",
    "polyline", "polygon", "linearGradient", "radialGradient", "stop", "clipPath", "mask",
    "pattern", "marker", "filter", "style", "title", "desc", "metadata",
];

/// Whether every SVG element in `doc` is one a picture may have. Elements
/// of other namespaces (an editor's own) are left alone, as usvg ignores
/// them.
fn only_picture_elements(doc: &usvg::roxmltree::Document) -> bool {
    const SVG: &str = "http://www.w3.org/2000/svg";
    doc.descendants()
        .filter(|n| n.is_element())
        .filter(|n| n.tag_name().namespace().is_none_or(|ns| ns == SVG))
        .all(|n| {
            let name = n.tag_name().name();
            // A filter's steps are all `fe…`.
            PICTURE_ELEMENTS.contains(&name) || name.starts_with("fe") && name != "feImage"
        })
}

/// Roughly the bytes of text usvg turns into a tree for `doc`, counting
/// each copy it makes: a `<use>` (or any `href`) copies what it names; a
/// `url(#id)` (a mask, clip, pattern or filter) may be made again for each
/// element that names it, and one named from a `<style>` sheet for every
/// element; and a marker may be copied to every point of every path, as
/// it's inherited and can be set from a sheet, so each marker counts once
/// per point in the whole drawing, its copies included. A few hundred
/// bytes of nested `<use>`s or markers can otherwise make gigabytes of
/// paths while the tree is built (Daybreak 170, rounds 5 and 6). Generous,
/// as a copy that usvg shares is counted again. Deeper than usvg would
/// parse safely, or a loop, is refused (u64::MAX).
fn expanded_weight(doc: &usvg::roxmltree::Document) -> u64 {
    use std::collections::HashMap;
    use usvg::roxmltree::{Node, NodeId};

    /// What a subtree comes to: its weight, its paths' points, and how
    /// deep it goes, its copies included.
    #[derive(Clone, Copy)]
    struct Cost {
        weight: u64,
        points: u64,
        height: u32,
    }

    const REFUSED: Cost = Cost {
        weight: u64::MAX,
        points: u64::MAX,
        height: u32::MAX,
    };

    /// Deeper than this, counting a copy's own depth where it's used, isn't
    /// read: usvg builds the tree by recursion.
    const DEEPEST: u32 = 256;

    impl Cost {
        fn add(&mut self, more: Cost) {
            self.weight = self.weight.saturating_add(more.weight);
            self.points = self.points.saturating_add(more.points);
            self.height = self.height.max(more.height.saturating_add(1));
        }
    }

    struct Walk<'a, 'input> {
        ids: HashMap<&'a str, Node<'a, 'input>>,
        memo: HashMap<NodeId, Cost>,
        elements: u64,
    }

    fn urls(value: &str) -> impl Iterator<Item = &str> {
        value.split("url(").skip(1).filter_map(|rest| {
            let rest = rest.trim_start().trim_start_matches(['"', '\'']);
            let id = rest.strip_prefix('#')?;
            let end = id.find(|c: char| matches!(c, ')' | '"' | '\'') || c.is_whitespace())?;
            Some(&id[..end])
        })
    }

    impl<'a, 'input> Walk<'a, 'input> {
        fn named(&mut self, id: &str, depth: u32) -> Cost {
            match self.ids.get(id).copied() {
                Some(node) => self.cost(node, depth + 1),
                None => Cost {
                    weight: 0,
                    points: 0,
                    height: 0,
                },
            }
        }

        /// `depth` counts elements and references on the way down, so a
        /// long chain of either is refused before the stack runs out.
        fn cost(&mut self, node: Node<'a, 'input>, depth: u32) -> Cost {
            if depth > DEEPEST {
                return REFUSED;
            }
            if !node.is_element() {
                return Cost {
                    weight: node.text().map_or(0, |t| t.len() as u64),
                    points: 0,
                    height: 0,
                };
            }
            if let Some(&known) = self.memo.get(&node.id()) {
                // Met before higher up: as deep again from here.
                if depth.saturating_add(known.height) > DEEPEST {
                    return REFUSED;
                }
                return known;
            }
            // Met again on the way down: usvg drops a loop, this refuses it.
            self.memo.insert(node.id(), REFUSED);
            let mut sum = Cost {
                weight: 64,
                points: 0,
                height: 0,
            };
            for attribute in node.attributes() {
                let (name, value) = (attribute.name(), attribute.value());
                sum.weight = sum.weight.saturating_add(value.len() as u64);
                if matches!(name, "d" | "points") {
                    sum.points = sum.points.saturating_add(value.len() as u64 / 2 + 2);
                }
                if name == "href" {
                    if let Some(id) = value.trim().strip_prefix('#') {
                        let more = self.named(id, depth);
                        sum.add(more);
                    }
                }
                for id in urls(value) {
                    let more = self.named(id, depth);
                    sum.weight = sum.weight.saturating_add(more.weight);
                    sum.height = sum.height.max(more.height.saturating_add(1));
                }
            }
            if node.tag_name().name() == "style" {
                let text: String = node.children().filter_map(|c| c.text()).collect();
                for id in urls(&text) {
                    let more = self.named(id, depth).weight.saturating_mul(self.elements);
                    sum.weight = sum.weight.saturating_add(more);
                }
            }
            for child in node.children() {
                let more = self.cost(child, depth + 1);
                sum.add(more);
            }
            if depth.saturating_add(sum.height) > DEEPEST {
                sum = REFUSED;
            }
            self.memo.insert(node.id(), sum);
            sum
        }
    }

    let mut walk = Walk {
        ids: HashMap::new(),
        memo: HashMap::new(),
        elements: 0,
    };
    let mut markers = Vec::new();
    for node in doc.descendants().filter(|n| n.is_element()) {
        walk.elements += 1;
        if let Some(id) = node.attribute("id") {
            walk.ids.entry(id).or_insert(node);
        }
        if node.tag_name().name() == "marker" {
            markers.push(node);
        }
    }
    let drawing = walk.cost(doc.root_element(), 0);
    markers
        .into_iter()
        .map(|marker| {
            walk.cost(marker, 0)
                .weight
                .saturating_mul(drawing.points)
        })
        .fold(drawing.weight, u64::saturating_add)
}

/// Threadbear's patch (Daybreak 170): the pixels resvg 0.46 holds at once,
/// beyond the canvas, drawing `tree` with `transform` onto a `width` x
/// `height` canvas. It follows resvg's own sizes rather than counting
/// layers, as a layer isn't the canvas's size: an isolated group's layer is
/// its box at the drawn scale, up to 5 canvases each way (render.rs); a
/// pattern's tile is its cell at the drawn scale, with no cap at all
/// (path.rs), and what's in it is drawn into the tile; a mask or a clip is
/// another pixmap the size of what it's applied to (mask.rs, clip.rs); a
/// filter keeps a result per step (filter/mod.rs). Generous where resvg
/// frees one before the next, never short.
fn held_pixels(tree: &usvg::Tree, transform: Transform, width: u32, height: u32) -> u64 {
    let (w, h) = (width as i32, height as i32);
    let Some(max_bbox) = IntRect::from_xywh(-w * 2, -h * 2, width * 5, height * 5) else {
        return u64::MAX;
    };
    nodes_held(tree.root(), transform, max_bbox, area(width, height))
}

fn area(width: u32, height: u32) -> u64 {
    u64::from(width) * u64::from(height)
}

fn nodes_held(parent: &usvg::Group, transform: Transform, max_bbox: IntRect, target: u64) -> u64 {
    let mut most = 0;
    for node in parent.children() {
        let held = match node {
            usvg::Node::Group(group) => group_held(group, transform, max_bbox, target),
            usvg::Node::Path(path) => {
                let fill = path.fill().map_or(0, |f| paint_held(f.paint(), transform, max_bbox));
                let stroke = path.stroke().map_or(0, |s| paint_held(s.paint(), transform, max_bbox));
                fill.max(stroke)
            }
            usvg::Node::Text(text) => group_held(text.flattened(), transform, max_bbox, target),
            usvg::Node::Image(_) => 0,
        };
        most = most.max(held);
    }
    most
}

fn paint_held(paint: &usvg::Paint, transform: Transform, max_bbox: IntRect) -> u64 {
    let usvg::Paint::Pattern(pattern) = paint else {
        return 0;
    };
    let (sx, sy) = transform.pre_concat(pattern.transform()).get_scale();
    let rect = pattern.rect();
    // As resvg rounds them; `as` saturates a huge or odd one.
    let (tw, th) = (
        (rect.width() * sx).round() as u32,
        (rect.height() * sy).round() as u32,
    );
    if tw == 0 || th == 0 {
        return 0;
    }
    let tile = area(tw, th);
    // What's in a pattern is drawn into its tile, with the outer canvas's
    // limits on its layers.
    tile.saturating_add(nodes_held(
        pattern.root(),
        Transform::from_scale(sx, sy),
        max_bbox,
        tile,
    ))
}

fn group_held(group: &usvg::Group, transform: Transform, max_bbox: IntRect, target: u64) -> u64 {
    let transform = transform.pre_concat(group.transform());
    if !group.should_isolate() {
        return nodes_held(group, transform, max_bbox, target);
    }
    // resvg draws nothing for a group whose box it can't place.
    let Some(bbox) = group.layer_bounding_box().transform(transform) else {
        return 0;
    };
    let ibbox = if group.filters().is_empty() {
        IntRect::from_xywh(
            (bbox.x().floor() as i32).saturating_sub(2),
            (bbox.y().floor() as i32).saturating_sub(2),
            (bbox.width().ceil() as u32).saturating_add(4),
            (bbox.height().ceil() as u32).saturating_add(4),
        )
    } else {
        Some(bbox.to_int_rect())
    };
    let Some(ibbox) = ibbox.and_then(|r| r.intersect(&max_bbox)) else {
        return 0;
    };
    let layer = area(ibbox.width(), ibbox.height());
    let transform =
        Transform::from_translate(-ibbox.x() as f32, -ibbox.y() as f32).pre_concat(transform);
    let content = nodes_held(group, transform, max_bbox, layer);
    // A filter works in its own region, the filter's rectangle at the
    // drawn scale, which resvg doesn't cut to the layer (filter/mod.rs,
    // `apply_inner`): each step keeps a result that size, and the worst
    // (a drop shadow's blur) holds about six more while it runs.
    let filters = group
        .filters()
        .iter()
        .map(|filter| {
            let Some(region) = filter.rect().transform(transform).map(|r| r.to_int_rect()) else {
                return 0;
            };
            // An feImage draws into the region with its own limits.
            let filter_box = IntRect::from_xywh(0, 0, region.width(), region.height());
            let region = area(region.width(), region.height()).max(layer);
            let working = region.saturating_mul(6);
            filter.primitives().iter().fold(working, |sum, primitive| {
                let own = region;
                let image = match primitive.kind() {
                    usvg::filter::Kind::Image(image) => {
                        let (sx, sy) = transform.get_scale();
                        filter_box.map_or(0, |bounds| {
                            nodes_held(image.root(), Transform::from_scale(sx, sy), bounds, region)
                        })
                    }
                    _ => 0,
                };
                sum.saturating_add(own).saturating_add(image)
            })
        })
        .fold(0u64, u64::saturating_add);
    let clip = group.clip_path().map_or(0, |c| clip_held(c, layer));
    let mask = group
        .mask()
        .map_or(0, |m| mask_held(m, transform, max_bbox, layer));
    layer
        .saturating_add(content)
        .saturating_add(filters)
        .saturating_add(clip)
        .saturating_add(mask)
}

fn clip_held(clip: &usvg::ClipPath, target: u64) -> u64 {
    // A clip's pixmap, a group in it with a clip of its own drawn on one
    // more, and a clip on the clip.
    fn groups(parent: &usvg::Group, target: u64) -> u64 {
        let mut most = 0;
        for node in parent.children() {
            let held = match node {
                usvg::Node::Group(group) => match group.clip_path() {
                    Some(clip) => target
                        .saturating_add(groups(group, target))
                        .saturating_add(clip_held(clip, target)),
                    None => groups(group, target),
                },
                usvg::Node::Text(text) => groups(text.flattened(), target),
                _ => 0,
            };
            most = most.max(held);
        }
        most
    }
    target
        .saturating_add(target / 4)
        .saturating_add(groups(clip.root(), target))
        .saturating_add(clip.clip_path().map_or(0, |c| clip_held(c, target)))
}

fn mask_held(mask: &usvg::Mask, transform: Transform, max_bbox: IntRect, target: u64) -> u64 {
    if mask.root().children().is_empty() {
        return 0;
    }
    // The mask's pixmap, its alpha mask twice, what's in it, and a mask on
    // the mask while this one is still held.
    target
        .saturating_add(target / 2)
        .saturating_add(nodes_held(mask.root(), transform, max_bbox, target))
        .saturating_add(
            mask.mask()
                .map_or(0, |m| mask_held(m, transform, max_bbox, target)),
        )
}

fn rasterize_tree(tree: &usvg::Tree, size: SvgSize) -> Result<Pixmap, usvg::Error> {
    // Cap the size of the rendered pixmap to avoid texture allocation panics
    // Related issue: #56466
    const MAX_SIZE: f32 = 8192.0;

    let svg_size = tree.size();
    let (mut width, mut height) = match size {
        SvgSize::Size(size) => {
            let scale = i32::from(size.width) as f32 / svg_size.width();
            (svg_size.width() * scale, svg_size.height() * scale)
        }
        SvgSize::ExactSize(size) => (i32::from(size.width) as f32, i32::from(size.height) as f32),
        SvgSize::ScaleFactor(scale) => (svg_size.width() * scale, svg_size.height() * scale),
    };

    if width > MAX_SIZE {
        log::warn!("Attempted to render pixmap where width ({width}) > MAX_SIZE ({MAX_SIZE})");
    }
    if height > MAX_SIZE {
        log::warn!("Attempted to render pixmap where height ({height}) > MAX_SIZE ({MAX_SIZE})");
    }
    let scale = (MAX_SIZE / width).min(MAX_SIZE / height).min(1.0);
    width *= scale;
    height *= scale;
    // Threadbear's patch (Daybreak 170): and at most `svg_pixels` in all,
    // so a tiny file can't ask for an 8192-square canvas.
    let most = crate::image_budget::DecodeLimits::DEFAULT.svg_pixels as f32;
    if width * height > most {
        let fit = (most / (width * height)).sqrt();
        width = (width * fit).floor();
        height = (height * fit).floor();
    }

    // Render the SVG to a pixmap with the specified width and height.
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width as u32, height as u32)
        .ok_or(usvg::Error::InvalidSize)?;

    let transform = Transform::from_scale(width / svg_size.width(), height / svg_size.height());
    // Threadbear's patch (Daybreak 170): drawn only when what resvg holds
    // beyond the canvas fits the `SVG_MAX_LAYERS` canvases `svg_peak_bytes`
    // reserves for.
    let most_held = crate::image_budget::DecodeLimits::DEFAULT
        .svg_pixels
        .saturating_mul(crate::image_budget::SVG_MAX_LAYERS as u64);
    if held_pixels(tree, transform, pixmap.width(), pixmap.height()) > most_held {
        return Err(usvg::Error::ElementsLimitReached);
    }

    resvg::render(tree, transform, &mut pixmap.as_mut());

    Ok(pixmap)
}

fn load_bundled_fonts(asset_source: &dyn AssetSource, db: &mut usvg::fontdb::Database) {
    let font_paths = [
        "fonts/ibm-plex-sans/IBMPlexSans-Regular.ttf",
        "fonts/lilex/Lilex-Regular.ttf",
    ];
    for path in font_paths {
        match asset_source.load(path) {
            Ok(Some(data)) => db.load_font_data(data.into_owned()),
            Ok(None) => log::warn!("Bundled font not found: {path}"),
            Err(error) => log::warn!("Failed to load bundled font {path}: {error}"),
        }
    }
}

// fontdb defaults generic families to Microsoft fonts ("Arial", "Times New Roman")
// which aren't installed on most Linux systems. fontconfig normally overrides these,
// but when it fails the defaults remain and all generic family queries return None.
fn fix_generic_font_families(db: &mut usvg::fontdb::Database) {
    use usvg::fontdb::{Family, Query};

    let families_and_fallbacks: &[(Family<'_>, &str)] = &[
        (Family::SansSerif, "IBM Plex Sans"),
        // No serif font bundled; use sans-serif as best available fallback.
        (Family::Serif, "IBM Plex Sans"),
        (Family::Monospace, "Lilex"),
        (Family::Cursive, "IBM Plex Sans"),
        (Family::Fantasy, "IBM Plex Sans"),
    ];

    for (family, fallback_name) in families_and_fallbacks {
        let query = Query {
            families: &[*family],
            ..Default::default()
        };
        if db.query(&query).is_none() {
            match family {
                Family::SansSerif => db.set_sans_serif_family(*fallback_name),
                Family::Serif => db.set_serif_family(*fallback_name),
                Family::Monospace => db.set_monospace_family(*fallback_name),
                Family::Cursive => db.set_cursive_family(*fallback_name),
                Family::Fantasy => db.set_fantasy_family(*fallback_name),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use usvg::fontdb::{Database, Family, Query};

    const IBM_PLEX_REGULAR: &[u8] =
        include_bytes!("../../../assets/fonts/ibm-plex-sans/IBMPlexSans-Regular.ttf");
    const LILEX_REGULAR: &[u8] = include_bytes!("../../../assets/fonts/lilex/Lilex-Regular.ttf");

    #[test]
    fn renders_parsed_svg_at_requested_size() -> Result<()> {
        let renderer = SvgRenderer::new(Arc::new(()));
        let svg = renderer.parse_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="24pt" height="12pt"></svg>"#,
        )?;
        let requested_size = Size::new(DevicePixels(24), DevicePixels(12));
        let image = renderer.render_parsed(&svg, SvgSize::ExactSize(requested_size))?;

        assert_eq!(image.size(0), requested_size);
        Ok(())
    }

    #[test]
    fn preserves_aspect_ratio_for_width_constrained_size() -> Result<()> {
        let renderer = SvgRenderer::new(Arc::new(()));
        let svg = renderer.parse_svg(
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="24pt" height="12pt"></svg>"#,
        )?;
        let image = renderer.render_parsed(
            &svg,
            SvgSize::Size(Size::new(DevicePixels(24), DevicePixels(24))),
        )?;

        assert_eq!(image.size(0), Size::new(DevicePixels(24), DevicePixels(12)));
        Ok(())
    }

    fn db_with_bundled_fonts() -> Database {
        let mut db = Database::new();
        db.load_font_data(IBM_PLEX_REGULAR.to_vec());
        db.load_font_data(LILEX_REGULAR.to_vec());
        db
    }

    #[test]
    fn text_with_split_glyph_clusters_in_mixed_fonts_does_not_panic() {
        let mut db = Database::new();
        db.load_font_data(IBM_PLEX_REGULAR.to_vec());
        db.load_font_data(LILEX_REGULAR.to_vec());
        let options = usvg::Options {
            fontdb: std::sync::Arc::new(db),
            ..Default::default()
        };

        // A base letter followed by a stack of combining marks. Under HarfBuzz's
        // default cluster merging every mark glyph shares the base's byte index,
        // which is the "glyph splitting" condition that triggered the panic. The
        // chunk must use two different fonts so the buggy merge path runs.
        let zalgo = "e\u{0301}\u{0302}\u{0303}\u{0304}\u{0306}\u{0307}\u{0308}\u{030a}";
        let svg = format!(
            r#"<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><text font-family="Lilex" font-size="32">{zalgo}<tspan font-family="IBM Plex Sans">{zalgo}</tspan></text></svg>"#
        );

        // Before the fix this aborts via panic with a message like
        // "removal index (is 5) should be < len (is 5)".
        usvg::Tree::from_data(svg.as_bytes(), &options)
            .expect("SVG with mixed-font text should parse");
    }

    #[test]
    fn test_is_emoji_presentation() {
        let cases = [
            ("a", false),
            ("Z", false),
            ("1", false),
            ("#", false),
            ("*", false),
            ("漢", false),
            ("中", false),
            ("カ", false),
            ("©", false),
            ("♥", false),
            ("😀", true),
            ("✅", true),
            ("🇺🇸", true),
            // SVG fallback is not cluster-aware yet
            ("©️", false),
            ("♥️", false),
            ("1️⃣", false),
        ];
        for (s, expected) in cases {
            assert_eq!(
                is_emoji_presentation(s.chars().next().unwrap()),
                expected,
                "for char {:?}",
                s
            );
        }
    }

    #[test]
    fn fix_generic_font_families_sets_all_families() {
        let mut db = db_with_bundled_fonts();
        fix_generic_font_families(&mut db);

        let families = [
            Family::SansSerif,
            Family::Serif,
            Family::Monospace,
            Family::Cursive,
            Family::Fantasy,
        ];

        for family in families {
            let query = Query {
                families: &[family],
                ..Default::default()
            };
            assert!(
                db.query(&query).is_some(),
                "Expected generic family {family:?} to resolve after fix_generic_font_families"
            );
        }
    }

    #[test]
    fn test_select_emoji_font_skips_family_without_glyph() {
        let db = db_with_bundled_fonts();

        let ibm_plex_sans = db
            .query(&usvg::fontdb::Query {
                families: &[usvg::fontdb::Family::Name("IBM Plex Sans")],
                weight: usvg::fontdb::Weight(400),
                stretch: usvg::fontdb::Stretch::Normal,
                style: usvg::fontdb::Style::Normal,
            })
            .unwrap();
        let lilex = db
            .query(&usvg::fontdb::Query {
                families: &[usvg::fontdb::Family::Name("Lilex")],
                weight: usvg::fontdb::Weight(400),
                stretch: usvg::fontdb::Stretch::Normal,
                style: usvg::fontdb::Style::Normal,
            })
            .unwrap();
        let selected = select_emoji_font('│', &[], &db, &["IBM Plex Sans", "Lilex"]).unwrap();

        assert_eq!(selected, lilex);
        assert!(!font_has_char(&db, ibm_plex_sans, '│'));
        assert!(font_has_char(&db, selected, '│'));
    }

    #[test]
    fn fix_generic_font_families_monospace_resolves_to_lilex() {
        let mut db = db_with_bundled_fonts();
        fix_generic_font_families(&mut db);

        let query = Query {
            families: &[Family::Monospace],
            ..Default::default()
        };
        let id = db.query(&query).expect("Monospace should resolve");
        let face = db.face(id).expect("Face should exist");
        assert!(
            face.families.iter().any(|(name, _)| name.contains("Lilex")),
            "Monospace should map to Lilex, got {:?}",
            face.families
        );
    }
}
