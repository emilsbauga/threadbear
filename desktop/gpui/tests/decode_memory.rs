//! What reading a picture's header and structure allocates, counted by the
//! allocator itself (Daybreak 170). These run before anything is reserved
//! in the books, so they must hold nothing that grows with the file's count
//! of chunks: round 10 (Gemini's) found the PNG and WebP walks collected
//! every chunk into a list several times the file's own size.
use gpui_kit::image_budget;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: hands every call straight to the system allocator, only counting.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(live, Ordering::SeqCst);
        // SAFETY: the caller's layout, as `GlobalAlloc::alloc` was given it.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        // SAFETY: a block this allocator handed out, with its layout.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// One measurement at a time: the count is the whole process's.
static ONE: Mutex<()> = Mutex::new(());

/// The most `f` held at once beyond what was live before it.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = LIVE.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    let out = std::hint::black_box(f());
    (out, PEAK.load(Ordering::SeqCst) - before)
}

const EMPTY_CHUNKS: usize = 1_000_000;

#[test]
fn a_pngs_walk_holds_no_list_of_its_chunks() {
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let chunk = |kind: &[u8], data: &[u8]| {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(data);
        c.extend_from_slice(&[0; 4]);
        c
    };
    png.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
    png.extend(chunk(b"iCCP", b"p\0\0x"));
    for _ in 0..EMPTY_CHUNKS {
        png.extend(chunk(b"tEXt", &[]));
    }
    png.extend(chunk(b"IEND", &[]));
    let (stripped, peak) = peak_of(|| image_budget::png_without_compressed_extras(&png).len());
    assert_eq!(stripped, png.len() - 16);
    // One copy, no bigger than the file: not a list of a million chunks
    // beside it (16 bytes each, and another copy growing).
    assert!(peak <= png.len() + 64 * 1024, "{peak} for {}", png.len());
    let (size, peak) = peak_of(|| image_budget::size_of(&png));
    assert_eq!(size, Some((1, 1)));
    assert!(peak <= 64 * 1024, "{peak}");
}

#[test]
fn a_webps_walk_holds_no_list_of_its_chunks() {
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let chunk = |fourcc: &[u8], data: &[u8]| {
        let mut c = fourcc.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        c
    };
    // A 1 x 1 canvas, then a million empty chunks.
    let mut body = b"WEBP".to_vec();
    body.extend(chunk(b"VP8X", &[0; 10]));
    for _ in 0..EMPTY_CHUNKS {
        body.extend(chunk(b"JUNK", &[]));
    }
    let mut webp = b"RIFF".to_vec();
    webp.extend_from_slice(&(body.len() as u32).to_le_bytes());
    webp.extend(body);
    let (fits, peak) = peak_of(|| image_budget::webp_frames_fit(&webp));
    assert!(fits);
    // Not 32 bytes for each of its 8-byte chunks.
    assert!(peak <= 64 * 1024, "{peak} for {}", webp.len());
    let (size, peak) = peak_of(|| image_budget::size_of(&webp));
    assert_eq!(size, Some((1, 1)));
    assert!(peak <= 64 * 1024, "{peak}");
}
