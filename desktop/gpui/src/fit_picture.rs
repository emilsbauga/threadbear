// Every picture a thread can put in front of this app without a click (a
// transcript's tiles and inline pictures, another Mac's, the viewer, the
// files pane, a review, a patch's picture, a project's icon) is decoded
// within one budget. A thread's pictures are its agent's, a cloned repo's or
// another runner's word, and GPUI's own loaders decoded whatever they were
// handed to full-size RGBA and kept every GIF frame, for as long as the app
// ran: a 16,384-square greyscale PNG of a few hundred KB was 1 GiB decoded,
// and a GIF of a thousand tiny frames several GiB (Daybreak 170, 23 Nov 2026).
//
// What one picture may cost is GPUI's `image_budget` (our patch in
// desktop/vendor/gpui-pre): its size read from its header first, at most
// 64 million pixels decoded and 32 million kept, a moving one at most 600
// frames and 256 MB, else its first frame still, an SVG at most 16 million
// pixels without its `<image>`s. GPUI's own decoders use it too, so a
// picture drawn any other way is held to the same.
//
// What they may cost together is the books here. Pixels live only in the
// books, never with whoever shows them (the viewer, the pane and a patch's
// panel keep the file's bytes and draw through `bytes_source`), so the books
// can always make room: every decode reserves what it may hold at its peak
// before it starts and waits when the books are full; what's kept is
// charged at its real size; and to make room, every window is drawn again
// and the pictures it didn't draw go, least recently drawn first, out of
// the GPU's atlas too. Pictures on screen stay, and the decode waits for
// them to scroll away. Bytes read whole but not yet reserved for (a file,
// another Mac's answer) are held to WAITING_BYTES apiece for this Mac's
// and other Macs', and SVGs waiting their drawing turn to four of the
// biggest (`Reads`), so a few big ones waiting don't hold up small ones. A
// file is opened only once there's room for it.

use gpui_kit::image_budget::{self, DecodeLimits, DecodeRefused};
use gpui_kit::{
    App, AsyncApp, Global, Image, ImageCacheError, ImageSource, RenderImage, SvgRenderer,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// What one picture may cost (GPUI's `image_budget`).
pub(crate) const LIMITS: DecodeLimits = DecodeLimits::DEFAULT;

/// Everything decoded and kept at once, decodes under way included.
pub(crate) const BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

/// Bytes read whole and waiting for their reservation, for this Mac's
/// pictures and for other Macs', each.
const WAITING_BYTES: u64 = 256 * 1024 * 1024;

/// The biggest picture file read (as `markdown::PICTURE_MAX_BYTES`).
pub(crate) const FILE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// How often a waiting decode has every window drawn again to see which
/// pictures are still on screen.
const LOOK_AGAIN: Duration = Duration::from_secs(2);

/// Tries at a picture that couldn't be read (a file being written, a lock
/// on Windows), a little later each time, before it's left as it is.
const TRIES: u32 = 6;

/// Why a picture isn't drawn.
pub(crate) type Refused = DecodeRefused;

/// A picture ready to keep: its pixels, its own size and what it costs.
pub(crate) struct Ready {
    pub image: Arc<RenderImage>,
    pub source: (u32, u32),
    pub cost: u64,
}

/// The books: bytes reserved by decodes under way and kept by pictures
/// decoded, against one limit.
pub(crate) struct Books {
    limit: u64,
    used: u64,
    kept: HashMap<String, Kept>,
    /// The most a decode asked for and didn't get since the last clear-out.
    wanted: u64,
    /// When every window was last asked to draw again for a clear-out.
    looked: Option<Instant>,
    /// What's kept, of `used`; the rest is decodes under way.
    kept_bytes: u64,
    /// The last clear-out found nothing it could drop and nothing under way
    /// that would give bytes back: what's waiting won't fit until pictures
    /// go out of sight, so it's refused as Busy and tried later.
    stuck: bool,
    /// Bytes read whole and waiting, by `Reads`.
    waiting: [u64; 3],
    /// Clear-outs started (each `LookAgain`), so a wait gives up as Busy
    /// only on one that looked at the screen after it began waiting:
    /// `stuck` from before is about pictures since scrolled away.
    cleared: u64,
    /// Which clear-out `stuck` comes from.
    stuck_from: u64,
}

struct Kept {
    image: Arc<RenderImage>,
    source: (u32, u32),
    cost: u64,
    drawn: Instant,
}

/// What a clear-out wants done on the main thread.
pub(crate) enum ClearOut {
    Nothing,
    /// Draw every window again, so the pictures on screen say so.
    LookAgain,
    /// These went: out of the atlas with them.
    Gone(Vec<Arc<RenderImage>>),
}

impl Books {
    pub(crate) fn new(limit: u64) -> Self {
        Books {
            limit,
            used: 0,
            kept: HashMap::new(),
            wanted: 0,
            looked: None,
            kept_bytes: 0,
            stuck: false,
            waiting: [0; 3],
            cleared: 0,
            stuck_from: 0,
        }
    }

    pub(crate) fn used(&self) -> u64 {
        self.used
    }

    /// Takes `bytes` when they fit. When not, notes what's wanted, for
    /// `clear_out`. More than the whole budget never fits.
    pub(crate) fn try_reserve(&mut self, bytes: u64) -> Result<bool, Refused> {
        if bytes > self.limit {
            return Err(Refused::TooBig);
        }
        if self.used.saturating_add(bytes) <= self.limit {
            self.used += bytes;
            Ok(true)
        } else {
            self.wanted = self.wanted.max(bytes);
            Ok(false)
        }
    }

    pub(crate) fn release(&mut self, bytes: u64) {
        self.used = self.used.saturating_sub(bytes);
        if bytes > 0 {
            self.stuck = false;
        }
    }

    /// Whether a decode that started waiting at clear-out `since` should
    /// give up for now: one since found nothing it could drop (`stuck`).
    pub(crate) fn stuck(&self, since: u64) -> bool {
        self.stuck && self.stuck_from > since
    }

    /// How many clear-outs have been done, for `stuck`.
    pub(crate) fn cleared(&self) -> u64 {
        self.cleared
    }

    /// Keeps a picture under `key` in place of the `reserved` bytes its
    /// decode took, charged at what it really costs. Hands back the
    /// picture it replaces, to come out of the atlas.
    pub(crate) fn keep(
        &mut self,
        key: String,
        ready: Ready,
        reserved: u64,
        now: Instant,
    ) -> Option<Arc<RenderImage>> {
        self.release(reserved);
        let old = self.forget(&key);
        self.used = self.used.saturating_add(ready.cost);
        self.kept_bytes = self.kept_bytes.saturating_add(ready.cost);
        self.kept.insert(
            key,
            Kept {
                image: ready.image,
                source: ready.source,
                cost: ready.cost,
                drawn: now,
            },
        );
        old
    }

    /// A kept picture and its own size, marked as drawn just now.
    pub(crate) fn drawn(
        &mut self,
        key: &str,
        now: Instant,
    ) -> Option<(Arc<RenderImage>, (u32, u32))> {
        let kept = self.kept.get_mut(key)?;
        kept.drawn = now;
        Some((kept.image.clone(), kept.source))
    }

    pub(crate) fn forget(&mut self, key: &str) -> Option<Arc<RenderImage>> {
        let kept = self.kept.remove(key)?;
        self.release(kept.cost);
        self.kept_bytes = self.kept_bytes.saturating_sub(kept.cost);
        Some(kept.image)
    }

    /// Making room for a waiting decode, in two steps: first every window
    /// is drawn again (`LookAgain`), then, at least `settle` later, the
    /// pictures not drawn since go, least recently drawn first, until what
    /// it wants fits. One drawn since is on screen and stays.
    pub(crate) fn clear_out(&mut self, now: Instant, settle: Duration) -> ClearOut {
        if self.wanted == 0 && self.used <= self.limit {
            return ClearOut::Nothing;
        }
        let Some(looked) = self.looked else {
            self.looked = Some(now);
            self.cleared += 1;
            return ClearOut::LookAgain;
        };
        if now.saturating_duration_since(looked) < settle {
            return ClearOut::Nothing;
        }
        let wanted = std::mem::take(&mut self.wanted);
        self.looked = None;
        let mut unseen: Vec<(Instant, String)> = self
            .kept
            .iter()
            .filter(|(_, k)| k.drawn < looked)
            .map(|(key, k)| (k.drawn, key.clone()))
            .collect();
        unseen.sort();
        let mut gone = Vec::new();
        for (_, key) in unseen {
            if self.used.saturating_add(wanted) <= self.limit {
                break;
            }
            gone.extend(self.forget(&key));
        }
        // Still no room, and no decode under way to give any back.
        self.stuck = self.used.saturating_add(wanted) > self.limit && self.used <= self.kept_bytes;
        self.stuck_from = self.cleared;
        ClearOut::Gone(gone)
    }

    fn try_wait(&mut self, reads: Reads, bytes: u64) -> bool {
        let held = &mut self.waiting[reads as usize];
        if held.saturating_add(bytes) <= reads.most() {
            *held += bytes;
            true
        } else {
            false
        }
    }

    fn stop_waiting(&mut self, reads: Reads, bytes: u64) {
        let held = &mut self.waiting[reads as usize];
        *held = held.saturating_sub(bytes);
    }
}

fn books() -> std::sync::MutexGuard<'static, Books> {
    static BOOKS: LazyLock<Mutex<Books>> = LazyLock::new(|| Mutex::new(Books::new(BUDGET_BYTES)));
    BOOKS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Bytes taken in the books, given back when dropped (a decode refused,
/// or its task gone).
struct Lease(u64);

impl Drop for Lease {
    fn drop(&mut self) {
        books().release(self.0);
    }
}

/// Whose pictures are read.
#[derive(Clone, Copy)]
pub(crate) enum Reads {
    /// Files on this Mac, and bytes in hand.
    Here = 0,
    /// Another Mac's, asked of the runner.
    Remote = 1,
    /// An SVG waiting for its drawing turn (svg_worker.rs draws one at a
    /// time, for up to 10 s each): its bytes move here from `Here` the
    /// moment it's known to be one, so a queue of a repo's icons can't hold
    /// up the pictures behind them (Gemini, rounds 10 and 11).
    Svg = 2,
}

impl Reads {
    /// The most bytes waiting at once: SVGs have room for four of the
    /// biggest, as they're drawn one at a time.
    pub(crate) const fn most(self) -> u64 {
        match self {
            Reads::Svg => 4 * image_budget::SVG_MAX_BYTES as u64,
            Reads::Here | Reads::Remote => WAITING_BYTES,
        }
    }
}

/// What a runner's answer of at most `most` bytes holds at once: the bytes
/// as base64 in the answer, and decoded (Gemini, Daybreak 170 round 11).
pub(crate) const fn answer_bytes(most: u64) -> u64 {
    most.div_ceil(3) * 4 + most + 1024 * 1024
}

/// Room for a picture's bytes, read whole, until it's reserved for.
pub(crate) struct Reader {
    reads: Reads,
    bytes: u64,
}

impl Drop for Reader {
    fn drop(&mut self) {
        books().stop_waiting(self.reads, self.bytes);
    }
}

impl Reader {
    /// The same bytes waiting in `reads`' room instead, if there's room
    /// there now; None, and this let go, if not.
    pub(crate) fn move_to(self, reads: Reads) -> Option<Reader> {
        let bytes = self.bytes;
        let moved = books().try_wait(reads, bytes);
        drop(self);
        moved.then_some(Reader { reads, bytes })
    }

    /// Down to what was really read.
    pub(crate) fn read(&mut self, bytes: u64) {
        let less = self.bytes.saturating_sub(bytes);
        books().stop_waiting(self.reads, less);
        self.bytes -= less;
    }
}

/// Room for `bytes` read whole, waiting for it.
pub(crate) async fn reader(reads: Reads, bytes: u64, cx: &mut AsyncApp) -> Reader {
    let bytes = bytes.min(reads.most());
    loop {
        if books().try_wait(reads, bytes) {
            return Reader { reads, bytes };
        }
        cx.background_executor()
            .timer(Duration::from_millis(100))
            .await;
    }
}

/// Bytes reserved in the books, waiting while they're full (the janitor
/// makes room from pictures that aren't on screen), or Busy when nothing
/// can go.
async fn reserve(bytes: u64, cx: &mut AsyncApp) -> Result<Lease, Refused> {
    cx.update(start_janitor);
    let since = books().cleared();
    loop {
        {
            let mut books = books();
            if books.try_reserve(bytes)? {
                return Ok(Lease(bytes));
            }
            if books.stuck(since) {
                return Err(Refused::Busy);
            }
        }
        cx.background_executor()
            .timer(Duration::from_millis(250))
            .await;
    }
}

/// Started once: while a decode waits for room, makes it (`clear_out`).
#[derive(Default)]
struct Janitor(bool);
impl Global for Janitor {}

pub(crate) fn start_janitor(cx: &mut App) {
    if std::mem::replace(&mut cx.default_global::<Janitor>().0, true) {
        return;
    }
    cx.spawn(async move |cx| loop {
        cx.background_executor()
            .timer(Duration::from_millis(500))
            .await;
        cx.update(clear_out);
    })
    .detach();
}

fn clear_out(cx: &mut App) {
    let step = books().clear_out(Instant::now(), LOOK_AGAIN);
    match step {
        ClearOut::Nothing => {}
        ClearOut::LookAgain => cx.refresh_windows(),
        ClearOut::Gone(gone) => {
            for image in gone {
                cx.drop_image(image, None);
            }
        }
    }
}

/// A kept picture and its own size, marked as drawn.
pub(crate) fn drawn(key: &str) -> Option<(Arc<RenderImage>, (u32, u32))> {
    books().drawn(key, Instant::now())
}

/// A picture's bytes, as `decode_kept` takes them.
pub(crate) type Bytes = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// What decoding `bytes` may hold at its peak.
fn peak(bytes: &[u8]) -> u64 {
    let len = bytes.len() as u64;
    if image_budget::is_svg(bytes) {
        // Drawn in a process of its own (svg_worker.rs): all it may take,
        // that process's own start, and the copies here of what it's sent
        // and sends back.
        crate::svg_worker::held_for(len)
    } else {
        let size = image_budget::size_of(bytes);
        image_budget::peak_bytes(len, size, image_budget::may_move(bytes), &LIMITS)
    }
}

/// A raster picture decoded within `image_budget`'s limits, or an SVG
/// drawn within them.
fn decode(bytes: &[u8], renderer: &SvgRenderer) -> Result<Ready, Refused> {
    if image_budget::is_svg(bytes) {
        let (image, cost) = image_budget::render_svg(bytes, renderer)?;
        let size = image.size(0);
        let source = (size.width.0.max(0) as u32, size.height.0.max(0) as u32);
        return Ok(Ready {
            image,
            source,
            cost,
        });
    }
    let decoded = image_budget::decode(bytes, &LIMITS)?;
    let cost = decoded.cost();
    Ok(Ready {
        source: decoded.source,
        image: Arc::new(RenderImage::new(decoded.frames)),
        cost,
    })
}

/// Decodes `bytes` off the main thread within the budget and keeps it
/// under `key`. `reader` is the room the bytes were read into, given back
/// once they're reserved for.
pub(crate) async fn decode_kept(
    key: String,
    bytes: Bytes,
    svg: bool,
    reader: Reader,
    cx: &mut AsyncApp,
) -> Result<(), Refused> {
    if !svg && image_budget::is_svg((*bytes).as_ref()) {
        return Err(Refused::Unreadable(
            "It isn't a picture this app can show here.".into(),
        ));
    }
    // An SVG is drawn one at a time (svg_worker.rs), so one waits for its
    // turn before it takes the room its drawing needs, not while holding it,
    // and waits in room of its own: none there now, and it's tried later.
    static SVG_TURN: futures::lock::Mutex<()> = futures::lock::Mutex::new(());
    let (_turn, reader) = if image_budget::is_svg((*bytes).as_ref()) {
        let reader = reader.move_to(Reads::Svg).ok_or(Refused::Busy)?;
        (Some(SVG_TURN.lock().await), reader)
    } else {
        (None, reader)
    };
    let measured = bytes.clone();
    let need = cx
        .background_executor()
        .spawn(async move { peak((*measured).as_ref()) })
        .await;
    let mut lease = reserve(need, cx).await?;
    // Reserved for now, encoded bytes included.
    drop(reader);
    let renderer = cx.update(|cx| cx.svg_renderer());
    let ready = cx
        .background_executor()
        .spawn(async move { decode((*bytes).as_ref(), &renderer) })
        .await?;
    cx.update(|cx| {
        let reserved = std::mem::take(&mut lease.0);
        let old = books().keep(key, ready, reserved, Instant::now());
        if let Some(old) = old {
            cx.drop_image(old, None);
        }
    });
    Ok(())
}

/// Where a budgeted picture's bytes come from.
#[derive(Clone)]
enum Origin {
    /// A file on this Mac, read under the path guard; an SVG drawn only
    /// when `svg` (a project's icon, not a transcript's picture).
    File { path: PathBuf, svg: bool },
    /// Bytes in hand (the viewer's, the pane's, a patch's); an SVG drawn
    /// only when `svg` (a file the viewer or the pane opened), so a panel
    /// or a thumbnail that changes every few seconds can't keep starting
    /// SVG drawing processes (svg_worker.rs).
    Bytes { image: Arc<Image>, svg: bool },
}

/// Budgeted pictures being read, or refused, by key.
#[derive(Default)]
struct Loads(HashMap<String, Load>);
impl Global for Loads {}

enum Load {
    Loading,
    Failed {
        refused: Refused,
        /// When it's tried again; never once TRIES have gone.
        again: Option<Instant>,
        tries: u32,
    },
}

/// A picture file of this Mac's, drawn through the books. `stamp` tells one
/// version of the file from the next (its size and time, where they're
/// cheap to read), so a file written again is read again.
pub(crate) fn file_source(path: PathBuf, stamp: String) -> ImageSource {
    let key = format!("file\n{}\n{stamp}", path.to_string_lossy());
    let origin = Origin::File { path, svg: false };
    ImageSource::Custom(Arc::new(move |_window, cx| budgeted(&key, &origin, cx)))
}

/// A raster picture's bytes, drawn through the books.
pub(crate) fn bytes_source(image: Arc<Image>) -> ImageSource {
    let key = format!("bytes\n{}", image.id());
    let origin = Origin::Bytes { image, svg: false };
    ImageSource::Custom(Arc::new(move |_window, cx| budgeted(&key, &origin, cx)))
}

/// A file's bytes the viewer or the Files pane opened, a raster picture or
/// an SVG, drawn through the books.
pub(crate) fn file_bytes_source(image: Arc<Image>) -> ImageSource {
    // Not `bytes_source`'s key: what one may draw, the other mayn't.
    let key = format!("svg bytes\n{}", image.id());
    let origin = Origin::Bytes { image, svg: true };
    ImageSource::Custom(Arc::new(move |_window, cx| budgeted(&key, &origin, cx)))
}

/// What `bytes_source` draws, for a custom source that has the bytes only
/// once its own asset has loaded (a media card's thumbnail).
pub(crate) fn draw_bytes(
    image: &Arc<Image>,
    cx: &mut App,
) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
    let key = format!("bytes\n{}", image.id());
    let origin = Origin::Bytes {
        image: image.clone(),
        svg: false,
    };
    budgeted(&key, &origin, cx)
}

/// A project's icon or a recipe's header, a picture file a repo or an
/// agent can name, a raster one or an SVG: through the books, read under
/// the path guard, as a thread's pictures are.
pub(crate) fn icon_source(path: &str) -> ImageSource {
    let path = PathBuf::from(path);
    let key = format!("icon\n{}\n{}", path.to_string_lossy(), stamp_of(&path));
    let origin = Origin::File { path, svg: true };
    ImageSource::Custom(Arc::new(move |_window, cx| budgeted(&key, &origin, cx)))
}

/// A file's size and time, for its key, looked at most every few seconds
/// (icons are drawn every frame; the guarded look walks the path).
fn stamp_of(path: &Path) -> String {
    type Seen = HashMap<PathBuf, (Instant, String)>;
    static SEEN: LazyLock<Mutex<Seen>> = LazyLock::new(Default::default);
    let now = Instant::now();
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, stamp)) = seen.get(path) {
        if now.saturating_duration_since(*at) < Duration::from_secs(3) {
            return stamp.clone();
        }
    }
    let stamp = threadbear_core::open_policy::local_metadata(path)
        .ok()
        .map(|meta| format!("{} {:?}", meta.len(), meta.modified().ok()))
        .unwrap_or_default();
    if seen.len() > 2000 {
        seen.clear();
    }
    seen.insert(path.to_owned(), (now, stamp.clone()));
    stamp
}

/// A regular file (a link followed to what it names, never a device) of
/// at most FILE_MAX_BYTES, opened under the path guard, and its length.
/// One bigger is too big, not unreadable, so it isn't read again.
fn open_file(path: &Path) -> Result<(std::fs::File, u64), Refused> {
    let unreadable = |e: std::io::Error| Refused::Unreadable(e.to_string());
    let file = threadbear_core::open_policy::local_open(path).map_err(unreadable)?;
    let meta = file.metadata().map_err(unreadable)?;
    if !meta.is_file() {
        return Err(Refused::Unreadable("Not a picture file".into()));
    }
    if meta.len() > FILE_MAX_BYTES {
        return Err(Refused::TooBig);
    }
    Ok((file, meta.len()))
}

/// A picture file's length, from a look at it, without opening it: what
/// `open_file` would say of it.
fn file_len(path: &Path) -> Result<u64, Refused> {
    let meta = threadbear_core::open_policy::local_metadata(path)
        .map_err(|e| Refused::Unreadable(e.to_string()))?;
    if !meta.is_file() {
        return Err(Refused::Unreadable("Not a picture file".into()));
    }
    if meta.len() > FILE_MAX_BYTES {
        return Err(Refused::TooBig);
    }
    Ok(meta.len())
}

/// At most `len` bytes of an open file: what was made room for.
fn read_file(file: std::fs::File, len: u64) -> Result<Vec<u8>, Refused> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    file.take(len)
        .read_to_end(&mut bytes)
        .map_err(|e| Refused::Unreadable(e.to_string()))?;
    Ok(bytes)
}

fn budgeted(
    key: &str,
    origin: &Origin,
    cx: &mut App,
) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
    if let Some((image, _)) = drawn(key) {
        return Some(Ok(image));
    }
    let tries = match cx.default_global::<Loads>().0.get(key) {
        Some(Load::Loading) => return None,
        Some(Load::Failed {
            refused,
            again,
            tries,
        }) => {
            if again.is_none_or(|at| Instant::now() < at) {
                return Some(Err(std::io::Error::other(refused.to_string()).into()));
            }
            *tries
        }
        None => 0,
    };
    let loads = &mut cx.default_global::<Loads>().0;
    if loads.len() > 5000 {
        loads.retain(|_, s| matches!(s, Load::Loading));
    }
    loads.insert(key.to_owned(), Load::Loading);
    // A key with no stamp (Windows, where looking at the file each frame
    // costs too much) may be a file written again since: always tried again.
    let stamped = !key.ends_with('\n');
    let (key, origin) = (key.to_owned(), origin.clone());
    let svg = matches!(
        origin,
        Origin::File { svg: true, .. } | Origin::Bytes { svg: true, .. }
    );
    cx.spawn(async move |cx| {
        let done = match origin {
            Origin::File { path, .. } => {
                // Its size first, then room for it, and only then is it
                // opened: one held open while it waited its turn was a
                // descriptor, and hundreds waiting ran the app out of them
                // (Gemini, round 11).
                let look = path.clone();
                let sized = cx
                    .background_executor()
                    .spawn(async move { file_len(&look) })
                    .await;
                match sized {
                    Ok(len) => {
                        let room = reader(Reads::Here, len, cx).await;
                        let read = cx
                            .background_executor()
                            .spawn(async move {
                                open_file(&path).and_then(|(file, _)| read_file(file, len))
                            })
                            .await;
                        match read {
                            Ok(bytes) => {
                                // Down to what was read, if it's shrunk since.
                                let mut room = room;
                                room.read(bytes.len() as u64);
                                decode_kept(key.clone(), Arc::new(bytes), svg, room, cx).await
                            }
                            Err(refused) => Err(refused),
                        }
                    }
                    Err(refused) => Err(refused),
                }
            }
            Origin::Bytes { image, .. } => {
                // Held only by whoever shows it while it waits its turn: if
                // they let it go (a panel's next picture), so does this.
                let weak = Arc::downgrade(&image);
                let len = image.bytes().len() as u64;
                drop(image);
                let room = reader(Reads::Here, len, cx).await;
                match weak.upgrade() {
                    Some(image) => {
                        decode_kept(key.clone(), Arc::new(Encoded(image)), svg, room, cx).await
                    }
                    None => Err(Refused::Unreadable("Gone.".into())),
                }
            }
        };
        cx.update(|cx| {
            let loads = &mut cx.default_global::<Loads>().0;
            match done {
                Ok(()) => {
                    loads.remove(&key);
                }
                Err(refused) => {
                    // Busy is tried again when there may be room; one that
                    // couldn't be read a little later each time (a file
                    // being written, a lock on Windows) until TRIES have
                    // gone; one too big never, for that version of it.
                    let wait = Duration::from_secs(2u64 << tries.min(5));
                    // (A key with no stamp is tried again only when it
                    // couldn't be read: one too big stays too big.)
                    let again = match refused {
                        Refused::Busy => Some(Duration::from_secs(30)),
                        Refused::Unreadable(_) if !stamped || tries + 1 < TRIES => Some(wait),
                        _ => None,
                    };
                    loads.insert(
                        key,
                        Load::Failed {
                            refused,
                            again: again.map(|wait| Instant::now() + wait),
                            tries: tries.saturating_add(1),
                        },
                    );
                    if let Some(wait) = again {
                        // Drawn again then, so the try happens without
                        // waiting for something else to redraw.
                        cx.spawn(async move |cx| {
                            cx.background_executor().timer(wait).await;
                            cx.update(|cx| cx.refresh_windows());
                        })
                        .detach();
                    }
                }
            }
            cx.refresh_windows();
        });
    })
    .detach();
    None
}

/// An `Image`'s bytes, as `decode_kept` reads them.
struct Encoded(Arc<Image>);

impl AsRef<[u8]> for Encoded {
    fn as_ref(&self) -> &[u8] {
        self.0.bytes()
    }
}

/// A turn at `decode_now`, waited for on the caller's own task before its
/// work goes to a background thread: `decode_now` holds its thread while it
/// waits for room, so each folder entry or project card that went straight
/// to the background parked a thread of the pool, and enough of them
/// starved the janitor's own timer (Gemini, Daybreak 170 round 12). Starts
/// the janitor too, as `decode_now` can't.
pub(crate) fn decode_now_turn(
    cx: &mut App,
) -> impl std::future::Future<Output = futures::lock::MutexGuard<'static, ()>> {
    static TURN: futures::lock::Mutex<()> = futures::lock::Mutex::new(());
    start_janitor(cx);
    TURN.lock()
}

/// Why `decode_now` made nothing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Missed {
    /// No room in the books for now (pictures on screen hold it): try
    /// again later, as it may well fit then.
    Busy,
    /// It can't be read or is too big: no use trying this version again.
    Failed,
}

/// What `decode_now` decodes a picture to, from its size: at most
/// `shown_pixels` kept, and room for `made_bytes` more, the most what's
/// made from it may hold while it's made.
pub(crate) struct Plan {
    pub shown_pixels: u64,
    pub made_bytes: u64,
}

impl Plan {
    /// A small picture made from at most `shown_pixels` of it, in one copy
    /// (a thumbnail cut to its box, a backdrop's band).
    pub(crate) fn small(shown_pixels: u64) -> impl FnOnce((u32, u32)) -> Plan {
        move |_| Plan {
            shown_pixels,
            made_bytes: shown_pixels.saturating_mul(4) + (1 << 20),
        }
    }
}

/// Reads and decodes a picture there and then, its first frame only, as
/// `plan` says from its size, and hands it to `then` as RGBA: for the ones
/// made smaller still before they're shown (file thumbnails, a project's
/// backdrop, a review's cut-out). Run off the main thread, one at a time,
/// the file read inside that turn, with room in the books for the decode
/// and for what `then` makes until it's done. When there's no room it waits
/// a while, the janitor making some, and then gives up as Busy, to be
/// tried again later rather than taken as a picture it can't read.
pub(crate) fn decode_now<T>(
    read: impl FnOnce() -> Option<Vec<u8>>,
    plan: impl FnOnce((u32, u32)) -> Plan,
    then: impl FnOnce(image::RgbaImage) -> Option<T>,
) -> Result<T, Missed> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = read().ok_or(Missed::Failed)?;
    let size = image_budget::size_of(&bytes).ok_or(Missed::Failed)?;
    let plan = plan(size);
    let limits = DecodeLimits {
        shown_pixels: plan.shown_pixels.clamp(1, LIMITS.shown_pixels),
        frames: 1,
        ..LIMITS
    };
    let need = image_budget::peak_bytes(bytes.len() as u64, Some(size), false, &limits)
        .saturating_add(plan.made_bytes);
    let mut tries = 0;
    let since = books().cleared();
    let _lease = loop {
        {
            let mut books = books();
            if books.try_reserve(need).map_err(|_| Missed::Failed)? {
                break Lease(need);
            }
            // Nothing out of sight to drop: no use holding the turn.
            if books.stuck(since) {
                return Err(Missed::Busy);
            }
        }
        tries += 1;
        if tries > 40 {
            return Err(Missed::Busy);
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let decoded = image_budget::decode(&bytes, &limits).map_err(|refused| match refused {
        Refused::Busy => Missed::Busy,
        _ => Missed::Failed,
    })?;
    drop(bytes);
    let frame = decoded.frames.into_iter().next().ok_or(Missed::Failed)?;
    let mut buffer = frame.into_buffer();
    for pixel in buffer.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    then(buffer).ok_or(Missed::Failed)
}

/// After a Busy, how long before a picture made by `decode_now` is tried
/// again.
pub(crate) const BUSY_AGAIN: Duration = Duration::from_secs(30);

/// `picture` cut to `width` by `height`'s shape round its middle and then
/// shrunk to it: `resize_to_fill` without its first step, which makes the
/// whole picture as big as filling needs (a 1 x 16,384 strip would be
/// 112 x 1.8 million).
pub(crate) fn fill(picture: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    let (w, h) = picture.dimensions();
    let (w64, h64) = (u64::from(w), u64::from(h));
    let (cw, ch) = if w64 * u64::from(height) > h64 * u64::from(width) {
        (
            ((h64 * u64::from(width)) / u64::from(height.max(1))).max(1) as u32,
            h,
        )
    } else {
        (
            w,
            ((w64 * u64::from(height)) / u64::from(width.max(1))).max(1) as u32,
        )
    };
    let part = image::imageops::crop_imm(picture, (w - cw) / 2, (h - ch) / 2, cw, ch).to_image();
    image::imageops::resize(&part, width, height, image::imageops::FilterType::Triangle)
}

/// A picture's size from its header, without decoding it.
pub(crate) fn size_of(bytes: &[u8]) -> Option<(u32, u32)> {
    image_budget::size_of(bytes)
}

#[cfg(test)]
mod tests;
