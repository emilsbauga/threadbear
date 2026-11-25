// A picture's SVG (a repo's project icon, a patch's panel, anything a
// thread can put in front of the app) is drawn in a process of its own: this
// app's own binary started again with `ARG`, which reads the SVG on stdin,
// draws it with an allocator that refuses more than the picture budget set
// aside for it (`image_budget::svg_peak_bytes`) and answers on stdout, then
// exits. One that would take more dies there, as does one taking longer than
// `TIME`, and the picture is too big to show; the app carries on.
//
// Seven rounds of Codex's and Gemini's reviews of Daybreak 170 (23 to 24 Nov
// 2026) found SVGs of a few KB that made usvg or resvg allocate gigabytes
// (nested <use>s, markers, text, masks, patterns, filter regions, entities),
// faster than estimates of what they'd cost kept up. Pictures still keep to
// the elements `PICTURE_ELEMENTS` allows (svg_renderer.rs), but this is the
// limit that holds whatever was missed. The app's own icons are drawn here.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui_kit::image_budget::{self, DecodeLimits};

/// The argument that makes this binary the drawing process.
const ARG: &str = "--threadbear-draw-svg";

/// The longest a drawing may take before it's stopped.
const TIME: Duration = Duration::from_secs(10);

/// What a drawing process holds before its limit is set (the binary, its
/// libraries, the SVG read in), generously.
const STARTED: u64 = 64 * 1024 * 1024;

/// What the drawing process may take for an SVG of `encoded` bytes: what
/// `svg_peak_bytes` says drawing it may hold, its answer included.
fn cap_for(encoded: u64) -> u64 {
    image_budget::svg_peak_bytes(encoded, &DecodeLimits::DEFAULT)
        + gpui_kit::picture_answer_most() as u64
}

/// What the books hold for drawing an SVG of `encoded` bytes (fit_picture.rs):
/// the process's limit and its start, and the copies here of the SVG sent
/// and of the answer, read and made into a picture.
pub(crate) fn held_for(encoded: u64) -> u64 {
    cap_for(encoded) + STARTED + 2 * encoded + 2 * gpui_kit::picture_answer_most() as u64
}

/// One drawing process at a time, so the books' room for one is what it
/// takes. (Decodes wait for their turn before reserving that room,
/// `fit_picture::decode_kept`; this is for any other caller.)
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// The allocator: the system's, held to `CAP` bytes in the drawing process
/// once it's set, and only counting then, so the app pays one relaxed load.
pub(crate) struct Capped;

static CAP: AtomicIsize = AtomicIsize::new(0);
static HELD: AtomicIsize = AtomicIsize::new(0);

fn take(bytes: usize) -> bool {
    let cap = CAP.load(Ordering::Relaxed);
    if cap == 0 {
        return true;
    }
    // (A `Layout`'s size is at most isize::MAX; one over the cap alone
    // never counts, so the sum below can't overflow.)
    if bytes as u64 > cap as u64 {
        out_of_room();
    }
    let bytes = bytes as isize;
    if HELD.fetch_add(bytes, Ordering::Relaxed) + bytes > cap {
        out_of_room();
    }
    true
}

/// Past its limit, the drawing process ends there and then, quietly: not an
/// abort, which macOS and Windows would report as a crash each time, and
/// nothing that might allocate on the way out.
fn out_of_room() -> ! {
    end_now(OUT_OF_ROOM)
}

/// Ends this process at once with `code`, running nothing on the way out
/// (no destructors, atexit handlers or DLL detaches, which could allocate
/// or wait on a lock the allocating thread holds).
fn end_now(code: i32) -> ! {
    #[cfg(unix)]
    // SAFETY: `_exit` ends the process without running anything else.
    unsafe {
        libc::_exit(code)
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn TerminateProcess(process: isize, code: u32) -> i32;
        }
        // SAFETY: the pseudo-handle for this process, ended with `code`.
        unsafe {
            TerminateProcess(GetCurrentProcess(), code as u32);
        }
        // (TerminateProcess on this process doesn't return.)
        std::process::abort()
    }
}

/// The drawing process's exit status when it ran out of room.
const OUT_OF_ROOM: i32 = 3;

fn give(bytes: usize) {
    if CAP.load(Ordering::Relaxed) != 0 {
        HELD.fetch_sub(bytes as isize, Ordering::Relaxed);
    }
}

// SAFETY: every call goes to `System` with the caller's own layout and
// pointer; the counting only decides whether it's made.
unsafe impl GlobalAlloc for Capped {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !take(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: as `GlobalAlloc::alloc`'s own contract.
        let made = unsafe { System.alloc(layout) };
        if made.is_null() {
            give(layout.size());
        }
        made
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !take(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: as `GlobalAlloc::alloc_zeroed`'s own contract.
        let made = unsafe { System.alloc_zeroed(layout) };
        if made.is_null() {
            give(layout.size());
        }
        made
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: as `GlobalAlloc::dealloc`'s own contract.
        unsafe { System.dealloc(ptr, layout) };
        give(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // The new block is counted whole while it's made, as the old one
        // may still be held beside it (a move rather than a grow in place).
        if !take(new_size) {
            return std::ptr::null_mut();
        }
        // SAFETY: as `GlobalAlloc::realloc`'s own contract.
        let made = unsafe { System.realloc(ptr, layout, new_size) };
        give(if made.is_null() {
            new_size
        } else {
            layout.size()
        });
        made
    }
}

/// When this binary was started as the drawing process: draws the SVG on
/// stdin and exits. Called first thing in `main`.
pub(crate) fn serve_if_asked() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(ARG) {
        return;
    }
    let scale = args
        .next()
        .and_then(|s| s.parse::<f32>().ok())
        .filter(|s| s.is_finite() && *s > 0. && *s <= 4.)
        .unwrap_or(1.);
    let mut bytes = Vec::new();
    let _ = std::io::stdin()
        .take(image_budget::SVG_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes);
    // It ends itself after its time too, in case the app that started it
    // has gone and can't.
    std::thread::spawn(|| {
        std::thread::sleep(TIME + Duration::from_secs(1));
        out_of_room();
    });
    // What the app set aside for it. What it read so far (the SVG, kept
    // till it exits) isn't counted, and is in the books' STARTED.
    let room = cap_for(bytes.len() as u64);
    // A test's smaller limit (tests/svg_worker.rs); never in a release.
    #[cfg(debug_assertions)]
    let room = std::env::var("THREADBEAR_SVG_TEST_CAP")
        .ok()
        .and_then(|cap| cap.parse().ok())
        .unwrap_or(room);
    CAP.store(room.min(isize::MAX as u64) as isize, Ordering::Relaxed);
    let answer = gpui_kit::SvgRenderer::new(Arc::new(())).picture_answer(&bytes, scale);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&answer);
    let _ = out.flush();
    // The answer's sent: nothing on the way out may count against it.
    end_now(0);
}

/// Draws a picture's SVG in the drawing process (`gpui_kit::PictureDrawer`):
/// its answer, `PICTURE_TRY_LATER` when it couldn't start, or None when it
/// ran out of room or time.
pub(crate) fn draw(bytes: &[u8], scale: f32) -> Option<Vec<u8>> {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    // One that couldn't start (the binary moved, out of processes) says to
    // try again later, rather than that the picture is too big.
    let try_later = || Some(gpui_kit::PICTURE_TRY_LATER.to_vec());
    let Ok(exe) = std::env::current_exe() else {
        return try_later();
    };
    let mut command = std::process::Command::new(exe);
    command
        .arg(ARG)
        .arg(scale.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // No console window for it.
        command.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = command.spawn() else {
        return try_later();
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return try_later();
    };
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    // Stopped if it takes too long: its stdout ends, and its stdin.
    {
        let (child, done) = (child.clone(), done.clone());
        std::thread::spawn(move || {
            let started = Instant::now();
            while !done.load(Ordering::Relaxed) {
                if started.elapsed() > TIME {
                    let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
    }
    let input = bytes.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let most = gpui_kit::picture_answer_most() as u64;
    let mut answer = Vec::with_capacity(most as usize + 1);
    let read = stdout.take(most + 1).read_to_end(&mut answer);
    let fine = read.is_ok() && answer.len() as u64 <= most;
    if !fine {
        let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
    // Its stdout is done, so it has exited or soon will; the watch, still
    // on, kills it at TIME if not. Only then is the writer waited for: the
    // process gone, its stdin is closed and the write ends.
    let status = loop {
        let looked = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
        match looked {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                break None;
            }
        }
    };
    done.store(true, Ordering::Relaxed);
    let _ = writer.join();
    (fine && status?.success()).then_some(answer)
}
